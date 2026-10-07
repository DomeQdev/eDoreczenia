import { CLIENTS, IDP_HINT, oidcEndpoint, type ClientName } from "../constants.js";
import { OidcError } from "../errors.js";
import { defaultFetch, type BrowserHttp, type FetchLike } from "../tools/BrowserHttp.js";
import { bytesToBase64Url, decodeJwt, randomToken, utf8Encode } from "../tools/Encoding.js";

export type Pkce = {
    verifier: string;
    challenge: string;
    method: "S256";
};

export type TokenSet = {
    client: ClientName;
    accessToken: string;
    refreshToken: string | null;
    idToken: string | null;
    /** Epoch ms. */
    accessExpiresAt: number;
    /** Epoch ms, `null` without a refresh token. */
    refreshExpiresAt: number | null;
    /** `jti` of the refresh token, to detect rotation. */
    refreshJti: string | null;
    obtainedAt: number;
    /** Address the token was issued for (`login_hint`). */
    ade?: string;
};

export type AuthRequest = {
    client: ClientName;
    url: URL;
    state: string;
    nonce: string;
    pkce: Pkce;
    redirectUri: string;
};

type TokenResponse = {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    error?: string;
    error_description?: string;
};

type TokenRequestOptions = {
    userAgent: string;
    fetch?: FetchLike;
};

/** Claims of an `edor-app` access token. */
export type AppTokenClaims = {
    sub?: string;
    sid?: string;
    azp?: string;
    exp?: number;
    iat?: number;
    person_identifier?: string;
    person_identifier_syn?: string;
    organization_full_name?: string;
    institution?: unknown;
    authorization?: unknown;
    mailbox?: { address?: string; context?: string; status?: string; name?: string; roles?: string[] };
    /** `session_index` is the ePUAP TGSID. */
    authentication?: { session_index?: string; level?: string; authority?: string; organization_epuap_id?: string };
    [key: string]: unknown;
};

/** Claims of an `edor-dashboard` access token. */
export type DashboardTokenClaims = {
    sub?: string;
    /** PESEL number. */
    person_identifier?: string;
    organization_epuap_id?: string;
    epuap_login?: string;
    service_provider?: string;
    tgsid?: string;
    assertion_context_ref?: string;
    given_name?: string;
    family_name?: string;
    [key: string]: unknown;
};

export const createPkce = async (): Promise<Pkce> => {
    const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest("SHA-256", utf8Encode(verifier));

    return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)), method: "S256" };
};

export const toTokenSet = (
    client: ClientName,
    data: TokenResponse & { access_token: string },
    now = Date.now()
): TokenSet => {
    const access = decodeJwt(data.access_token) ?? {};
    const refresh = data.refresh_token ? (decodeJwt(data.refresh_token) ?? {}) : {};

    const accessExpiresAt =
        typeof access.exp === "number" ? access.exp * 1000 : now + (data.expires_in ?? 300) * 1000;
    const refreshExpiresAt =
        typeof refresh.exp === "number"
            ? refresh.exp * 1000
            : data.refresh_expires_in
              ? now + data.refresh_expires_in * 1000
              : null;

    return {
        client,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        idToken: data.id_token ?? null,
        accessExpiresAt,
        refreshExpiresAt: data.refresh_token ? refreshExpiresAt : null,
        refreshJti: typeof refresh.jti === "string" ? refresh.jti : null,
        obtainedAt: now,
    };
};

const requestTokens = async (
    client: ClientName,
    params: URLSearchParams,
    { userAgent, fetch = defaultFetch }: TokenRequestOptions
) => {
    const response = await fetch(oidcEndpoint(CLIENTS[client].host, "token"), {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": userAgent,
        },
        body: params,
    });

    let data: TokenResponse;
    try {
        data = JSON.parse(await response.text());
    } catch {
        const contentType = response.headers.get("content-type")?.split(";")[0] ?? "?";
        throw new OidcError(response.status, "non_json", `token endpoint returned ${response.status} (${contentType})`);
    }

    if (!response.ok || !data.access_token) {
        const description = data.error_description ? ` — ${data.error_description.slice(0, 120)}` : "";
        throw new OidcError(
            response.status,
            data.error ?? "error",
            `token endpoint ${response.status}: ${data.error ?? "?"}${description}`
        );
    }

    return toTokenSet(client, { ...data, access_token: data.access_token });
};

export const exchangeCode = ({
    client,
    code,
    redirectUri,
    codeVerifier,
    ...options
}: TokenRequestOptions & { client: ClientName; code: string; redirectUri: string; codeVerifier: string }) =>
    requestTokens(
        client,
        new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENTS[client].id,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }),
        options
    );

/** Keycloak may rotate the refresh token; when it does not, the current one is kept. */
export const refreshTokens = async ({ tokens, ...options }: TokenRequestOptions & { tokens: TokenSet }) => {
    if (!tokens.refreshToken) throw new OidcError(0, "no_refresh_token", "no refresh token");

    const next = await requestTokens(
        tokens.client,
        new URLSearchParams({
            grant_type: "refresh_token",
            client_id: CLIENTS[tokens.client].id,
            refresh_token: tokens.refreshToken,
            scope: "openid profile",
        }),
        options
    );

    if (tokens.ade) next.ade = tokens.ade;
    if (!next.refreshToken) {
        next.refreshToken = tokens.refreshToken;
        next.refreshExpiresAt = tokens.refreshExpiresAt;
        next.refreshJti = tokens.refreshJti;
    }

    return next;
};

/** Backchannel logout of the SSO session. */
export const logout = async ({ tokens, userAgent, fetch = defaultFetch }: TokenRequestOptions & { tokens: TokenSet }) => {
    if (!tokens.refreshToken) return false;

    const response = await fetch(oidcEndpoint(CLIENTS[tokens.client].host, "logout"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
        body: new URLSearchParams({ client_id: CLIENTS[tokens.client].id, refresh_token: tokens.refreshToken }),
    });
    await response.body?.cancel();

    return response.ok;
};

/** Authorization request with PKCE, built the way angular-oauth2-oidc does in the official apps. */
export const buildAuthRequest = async (
    client: ClientName,
    { ade, idpHint }: { ade?: string; idpHint?: boolean } = {}
): Promise<AuthRequest> => {
    const { id, host, redirectUri: redirectUriFor } = CLIENTS[client];
    const pkce = await createPkce();
    const state = randomToken();
    const nonce = randomToken();
    const redirectUri = redirectUriFor(ade);

    const params = new URLSearchParams({
        response_type: "code",
        client_id: id,
        state,
        redirect_uri: redirectUri,
        scope: "openid profile",
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        nonce,
    });
    if (idpHint) params.set("kc_idp_hint", IDP_HINT);
    // `edor-mu` expects the address prefixed with `ADE.`, `edor-app` the bare address.
    if (ade) params.set("login_hint", client === "mu" ? `ADE.${ade}` : ade);

    const url = new URL(oidcEndpoint(host, "auth"));
    url.search = params.toString();

    return { client, url, state, nonce, pkce, redirectUri };
};

/** Matches the redirect back to `redirectUri` that carries `code` or `error`. */
export const isCallbackFor = ({ redirectUri }: Pick<AuthRequest, "redirectUri">) => {
    const target = new URL(redirectUri);
    const trimSlash = (path: string) => path.replace(/\/$/, "");

    return (url: URL) =>
        url.origin === target.origin &&
        trimSlash(url.pathname) === trimSlash(target.pathname) &&
        (url.searchParams.has("code") || url.searchParams.has("error"));
};

/**
 * Gets tokens for another client through the existing SSO session (Keycloak cookies in the jar),
 * without user interaction. Returns `null` when Keycloak asks for a login instead.
 */
export const authorizeViaSso = async (
    http: BrowserHttp,
    client: ClientName,
    { ade }: { ade?: string } = {}
): Promise<TokenSet | null> => {
    const step = `sso-${client}`;
    const request = await buildAuthRequest(client, { ade });
    const isCallback = isCallbackFor(request);

    // The keycloak-oidc broker may answer with an auto-POST form.
    const start = await http.request(step, request.url, { stopAt: isCallback });
    const { response } = await http.submitAutoForms(step, start, { stopAt: isCallback, limit: 6 });

    const callback = response.stoppedAt;
    if (!callback) {
        const landedOn = `${response.url.host}${response.url.pathname}, ${response.response.status}`;
        http.trace.record({ step, note: `no SSO session (landed on ${landedOn})` });
        return null;
    }

    const error = callback.searchParams.get("error");
    if (error) {
        http.trace.record({ step, note: `callback error: ${error}` });
        return null;
    }

    if (callback.searchParams.get("state") !== request.state) http.halt(step, "state mismatch on callback");

    const tokens = await exchangeCode({
        client,
        code: callback.searchParams.get("code")!,
        redirectUri: request.redirectUri,
        codeVerifier: request.pkce.verifier,
        userAgent: http.userAgent,
        fetch: http.fetch,
    });
    if (ade) tokens.ade = ade;

    return tokens;
};
