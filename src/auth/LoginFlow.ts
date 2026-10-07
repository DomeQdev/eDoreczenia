import { DEFAULT_USER_AGENT, HOSTS } from "../constants.js";
import { EdoError, FlowHalt, QrExpiredError } from "../errors.js";
import { BrowserHttp, isHtml, isHtmlForm, type BrowserResponse, type FetchLike } from "../tools/BrowserHttp.js";
import { CookieJar, type StoredCookie } from "../tools/Cookies.js";
import { findLinks, formPayload, type ParsedForm } from "../tools/Html.js";
import type { TraceSink } from "../tools/Trace.js";
import { authenticate, findEntry, getLoginEntries, type LoginEntries, type LoginEntryType } from "./LoginGov.js";
import {
    getQrCode,
    submitArtifact,
    waitForConfirmation,
    type QrCode,
    type SamlConfirmation,
    type WaitOptions,
} from "./Mobywatel.js";
import { buildAuthRequest, exchangeCode, isCallbackFor } from "./Oidc.js";
import { EdoSession } from "./Session.js";

/*
 * Keycloak EDOR → `mlpz` broker (ePUAP) → SAML → login.gov.pl → mObywatel QR → back to Keycloak.
 *
 * The flow is split into phases with a plain JSON state, so it can be persisted and resumed in
 * another request or process:
 *
 *   const { state, qr } = await startQrLogin();
 *   const confirmation = await awaitQrConfirmation(state);
 *   let result = await completeLogin(state, { confirmation });
 *   while (result.kind === "choice") result = await completeLogin(result.state, { choice: "0" });
 *
 * or in one call with `loginWithQr`. Any unexpected response ends in a `FlowHalt`.
 */

export type FlowOptions = {
    userAgent?: string;
    fetch?: FetchLike;
    onTrace?: TraceSink;
};

export type ChoiceOption = {
    id: string;
    label: string;
};

/** Contains cookies and the PKCE verifier — treat it as a secret. */
export type LoginState = {
    v: 1;
    userAgent: string;
    jar: StoredCookie[];
    auth: { state: string; verifier: string; redirectUri: string };
    /** login.gov.pl SPA address, sent as the referer to its API. */
    loginGovUrl: string | null;
    qr: QrCode | null;
    /** A form waiting for the user's decision, e.g. the ePUAP context selection. */
    pendingForm: { form: ParsedForm; pageUrl: string } | null;
    startedAt: number;
};

export type CompleteResult =
    | { kind: "choice"; state: LoginState; options: ChoiceOption[] }
    | { kind: "done"; session: EdoSession };

export type LoginWithQrOptions = FlowOptions & {
    /** Shows a QR code to the user, including the automatically refreshed ones. */
    onQr(qr: QrCode): void | Promise<void>;
    /** Picks an option, e.g. the ePUAP context. Without it, a choice ends the flow with a `FlowHalt`. */
    onChoice?(options: ChoiceOption[]): string | Promise<string>;
    /** Persists the state between phases. */
    onState?(state: LoginState): void | Promise<void>;
    signal?: AbortSignal;
    /** How many times to replace an expired QR code. Default 2, about 15 minutes in total. */
    qrRefreshes?: number;
    connect?: WaitOptions["connect"];
};

const MAX_REDIRECT_STEPS = 12;

const restoreHttp = (state: Pick<LoginState, "userAgent" | "jar">, { fetch, onTrace }: FlowOptions) =>
    new BrowserHttp({ userAgent: state.userAgent, jar: CookieJar.fromJSON(state.jar), fetch, onTrace });

/** Submits auto-POST forms until `until` matches; a form that needs a decision halts the flow. */
const autoSubmit = async (
    http: BrowserHttp,
    step: string,
    start: BrowserResponse,
    until: (response: BrowserResponse) => boolean
) => {
    const { response, pending } = await http.submitAutoForms(step, start, { until, limit: MAX_REDIRECT_STEPS });
    if (pending.length) http.halt(step, `page has ${pending.length} form(s) but none submittable`);

    return response;
};

const landedOn = ({ url, response }: BrowserResponse) => `${url.host}${url.pathname} (${response.status})`;

/**
 * Steps 1–11: from Keycloak's `/auth` to the QR code on login.mobywatel.gov.pl. Only the
 * `MOBILE_ID` method is automated; picking another one halts after the provider is selected.
 */
export const startQrLogin = async ({
    method = "MOBILE_ID",
    ...options
}: FlowOptions & { method?: LoginEntryType } = {}): Promise<{
    state: LoginState;
    qr: QrCode;
    entries: LoginEntries;
}> => {
    const http: BrowserHttp = new BrowserHttp({
        userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
        fetch: options.fetch,
        onTrace: options.onTrace,
    });

    // 1. Keycloak `/auth` with `kc_idp_hint=mlpz` redirects through the broker to ePUAP.
    const auth = await buildAuthRequest("dashboard", { idpHint: true });
    let response = await http.request("1-keycloak-auth", auth.url, { stopAt: isCallbackFor(auth) });
    if (response.stoppedAt) http.halt("1-keycloak-auth", "unexpected immediate callback (stale SSO session?)");

    // 2. Keycloak may show its login page instead of redirecting; follow the broker link.
    if (response.url.origin === HOSTS.dashboard && isHtml(response) && !isHtmlForm(response)) {
        const [brokerLink] = findLinks(response.text, response.url, "/broker/mlpz/login");
        if (!brokerLink) http.halt("2-broker-link", "Keycloak login page without broker link");

        response = await http.request("2-broker-mlpz", brokerLink);
    }

    // 3–6. ePUAP auto-POSTs the SAMLRequest to login.gov.pl, which ends on its SPA.
    response = await autoSubmit(
        http,
        "4-saml-autopost",
        response,
        (next) => next.url.origin === HOSTS.loginGov && !isHtmlForm(next)
    );
    if (response.url.origin !== HOSTS.loginGov) {
        http.halt("4-saml-autopost", `expected login.gov.pl, landed on ${landedOn(response)}`);
    }
    const loginGovUrl = response.url.href;

    // 7. Available login methods.
    const entries = await getLoginEntries(http, { referer: loginGovUrl });
    const entry = findEntry(entries, method);
    if (!entry) http.halt("7-login-entries", `login method ${method} not available`);

    // 8. Provider selection.
    const selected = await authenticate(http, entry.identityProviderId, { referer: loginGovUrl });
    if (selected.response.status >= 400) {
        const status = `${selected.response.status} (${selected.contentType || "?"})`;
        http.halt("8-authenticate", `authenticate → ${status}`);
    }
    if (method !== "MOBILE_ID") {
        http.halt("8-authenticate", `provider ${method} selected — only MOBILE_ID (QR) is automated; landed on ${selected.url.host}`);
    }

    // 9–10. SAML auto-POST to login.mobywatel.gov.pl/sso, ending on the mObywatel SPA.
    const isMobywatelSpa = (next: BrowserResponse) => next.url.origin === HOSTS.mobywatel && !isHtmlForm(next);
    let mobywatel: BrowserResponse;
    if (isHtml(selected)) {
        mobywatel = await autoSubmit(http, "9-mobywatel-sso", selected, isMobywatelSpa);
    } else {
        const form = findSamlForm(parseJsonSafe(selected.text));
        if (!form) http.halt("9-mobywatel-sso", "authenticate response without SAML form");

        const posted = await http.request("9-mobywatel-sso", form.action, {
            method: "POST",
            body: new URLSearchParams(form.fields),
            headers: { Origin: HOSTS.loginGov, Referer: loginGovUrl },
        });
        mobywatel = await autoSubmit(http, "9-mobywatel-sso", posted, isMobywatelSpa);
    }
    if (mobywatel.url.origin !== HOSTS.mobywatel) {
        http.halt("9-mobywatel-sso", `expected login.mobywatel.gov.pl, landed on ${landedOn(mobywatel)}`);
    }

    // 11. QR code.
    const qr = await getQrCode(http);
    const state: LoginState = {
        v: 1,
        userAgent: http.userAgent,
        jar: http.jar.toJSON(),
        auth: { state: auth.state, verifier: auth.pkce.verifier, redirectUri: auth.redirectUri },
        loginGovUrl,
        qr,
        pendingForm: null,
        startedAt: Date.now(),
    };

    return { state, qr, entries };
};

/** New QR code in the same mObywatel session; each one expires after 5 minutes. */
export const refreshQr = async (state: LoginState, options: FlowOptions = {}) => {
    const http: BrowserHttp = restoreHttp(state, options);
    const qr = await getQrCode(http);

    return { state: { ...state, jar: http.jar.toJSON(), qr }, qr };
};

/** Waits for the user to confirm the QR code in the mObywatel app. */
export const awaitQrConfirmation = (state: LoginState, options: FlowOptions & WaitOptions = {}) => {
    if (!state.qr) throw new EdoError("login state has no QR code");

    return waitForConfirmation(restoreHttp(state, options), state.qr, options);
};

/**
 * Steps 13–15: SAML artifact → ePUAP → Keycloak → `edor-dashboard` tokens. A page that asks the
 * user to pick something (e.g. person or company context) is returned as `kind: "choice"`; call
 * again with `{ choice: option.id }`.
 */
export const completeLogin = async (
    state: LoginState,
    input: { confirmation: SamlConfirmation } | { choice: string },
    options: FlowOptions = {}
): Promise<CompleteResult> => {
    const http: BrowserHttp = restoreHttp(state, options);
    const isCallback = isCallbackFor({ redirectUri: state.auth.redirectUri });
    let response: BrowserResponse;

    if ("confirmation" in input) {
        response = await submitArtifact(http, input.confirmation, isCallback);
        if (!response.stoppedAt && (response.response.status >= 400 || /error/i.test(response.url.pathname))) {
            http.halt("13-saml-artifact", `artifact resolution failed: ${landedOn(response)}`);
        }
    } else {
        if (!state.pendingForm) throw new EdoError("no pending choice in login state");

        const { form, pageUrl } = state.pendingForm;
        const choice = form.choices[Number(input.choice)];
        if (!choice) throw new EdoError("invalid choice");

        const page = new URL(pageUrl);
        response = await http.request("14-choice", form.action, {
            method: form.method,
            body: form.method === "POST" ? formPayload(form, { [choice.name]: choice.value }) : null,
            headers: { Origin: page.origin, Referer: page.href },
            stopAt: isCallback,
        });
    }

    const step = "14-mlpz-context";
    const submitted = await http.submitAutoForms(step, response, { stopAt: isCallback, limit: MAX_REDIRECT_STEPS });
    response = submitted.response;

    if (submitted.pending.length) {
        const form = submitted.pending.find(({ choices }) => choices.length > 0);
        if (!form) {
            const fields = submitted.pending.map(({ fields }) => fields.map(({ name }) => name).join(",")).join(" | ");
            return http.halt(step, `form(s) without submittable variant; fields: ${fields}`);
        }

        http.trace.record({
            step,
            note: `choice required (${form.choices.length} options)`,
            fields: form.choices.map(({ name }) => name),
        });

        return {
            kind: "choice",
            state: { ...state, jar: http.jar.toJSON(), pendingForm: { form, pageUrl: response.url.href } },
            options: form.choices.map(({ label, value }, index) => ({
                id: String(index),
                label: label || value || `opcja ${index + 1}`,
            })),
        };
    }

    const callback = response.stoppedAt;
    if (!callback) {
        const contentType = response.contentType || "?";
        return http.halt(step, `did not reach dashboard callback; stuck at ${landedOn(response)}, ${contentType}`);
    }

    const error = callback.searchParams.get("error");
    if (error) http.halt("15-callback", `Keycloak error: ${error}`);
    if (callback.searchParams.get("state") !== state.auth.state) http.halt("15-callback", "state mismatch on callback");

    const dashboard = await exchangeCode({
        client: "dashboard",
        code: callback.searchParams.get("code")!,
        redirectUri: state.auth.redirectUri,
        codeVerifier: state.auth.verifier,
        userAgent: http.userAgent,
        fetch: http.fetch,
    });

    // Only Keycloak cookies carry over; they give SSO for the other clients.
    const jar = http.jar.toJSON().filter(({ domain }) => domain.endsWith("edoreczenia.gov.pl"));
    const session = new EdoSession({ userAgent: http.userAgent, jar, tokens: { dashboard } }, { fetch: options.fetch });

    return { kind: "done", session };
};

/** The whole flow in one call, refreshing expired QR codes along the way. */
export const loginWithQr = async (options: LoginWithQrOptions) => {
    const { fetch, onTrace, signal, connect, qrRefreshes = 2 } = options;
    let { state, qr } = await startQrLogin(options);

    await options.onState?.(state);
    await options.onQr(qr);

    let confirmation: SamlConfirmation;
    for (let refreshes = 0; ; refreshes++) {
        try {
            confirmation = await awaitQrConfirmation(state, { fetch, onTrace, signal, connect });
            break;
        } catch (error) {
            if (!(error instanceof QrExpiredError) || refreshes >= qrRefreshes) throw error;

            ({ state, qr } = await refreshQr(state, options));
            await options.onState?.(state);
            await options.onQr(qr);
        }
    }

    let result = await completeLogin(state, { confirmation }, options);
    while (result.kind === "choice") {
        await options.onState?.(result.state);
        if (!options.onChoice) {
            throw new FlowHalt("14-choice", `choice required (${result.options.length} options) but no onChoice handler`);
        }

        result = await completeLogin(result.state, { choice: await options.onChoice(result.options) }, options);
    }

    return result.session;
};

const parseJsonSafe = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
};

/**
 * Fallback for when `authenticate` answers with JSON: finds the object holding a `SAMLRequest`
 * and turns it into a form to POST.
 */
export const findSamlForm = (json: unknown): { action: string; fields: Record<string, string> } | null => {
    const stack: { node: unknown; parent: Record<string, unknown> | null }[] = [{ node: json, parent: null }];
    const seen = new Set<unknown>();

    while (stack.length) {
        const { node, parent } = stack.pop()!;
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);

        if (Array.isArray(node)) {
            for (const child of node) stack.push({ node: child, parent });
            continue;
        }

        const object = node as Record<string, unknown>;
        if (!Object.keys(object).some((key) => /^samlrequest$/i.test(key))) {
            for (const child of Object.values(object)) {
                if (child && typeof child === "object") stack.push({ node: child, parent: object });
            }
            continue;
        }

        const fields: Record<string, string> = {};
        let action: string | null = null;

        // The target URL may sit next to the SAML fields or one level up.
        for (const source of [object, parent ?? {}]) {
            for (const [key, value] of Object.entries(source)) {
                if (typeof value !== "string") continue;

                if (/^(url|action|ssoUrl|formAction|redirectUrl|targetUrl)$/i.test(key) && /^https?:/i.test(value)) {
                    action ??= value;
                } else if (source === object) {
                    fields[key] = value;
                }
            }
        }

        return { action: action ?? `${HOSTS.mobywatel}/sso`, fields };
    }

    return null;
};
