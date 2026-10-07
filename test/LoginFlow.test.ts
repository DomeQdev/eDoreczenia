import { describe, expect, it } from "vitest";
import { completeLogin, refreshQr, startQrLogin, type LoginState } from "../src/auth/LoginFlow.js";
import { FlowHalt } from "../src/errors.js";
import { bytesToBase64Url, utf8Encode } from "../src/tools/Encoding.js";

const jwt = (payload: object) =>
    `${bytesToBase64Url(utf8Encode('{"alg":"none"}'))}.${bytesToBase64Url(utf8Encode(JSON.stringify(payload)))}.sig`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const CONFIRMATION = { action: "https://login.gov.pl/login/SingleSignOnClientService", samlart: "ART" };

/** Fake government infrastructure following the real redirect chain, with made-up values. */
const fakeGov = ({ withChoice = false } = {}) => {
    let authState = "";
    let redirectUri = "";

    const html = (body: string) =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
    const redirect = (location: string, status = 302, cookie?: string) =>
        new Response(null, { status, headers: { location, ...(cookie ? { "set-cookie": cookie } : {}) } });
    const json = (value: unknown) => Response.json(value);
    const keycloakEndpointForm = html(
        `<form method="post" action="https://edoreczenia.gov.pl/auth/realms/EDOR/broker/mlpz/endpoint"><input type="hidden" name="SAMLResponse" value="resp"/></form>`
    );

    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const headers = new Headers(init?.headers);
        const cookies = headers.get("cookie") ?? "";

        switch (`${method} ${url.host}${url.pathname}`) {
            case "GET edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/auth":
                authState = url.searchParams.get("state")!;
                redirectUri = url.searchParams.get("redirect_uri")!;
                expect(url.searchParams.get("kc_idp_hint")).toBe("mlpz");
                return redirect(
                    "/auth/realms/EDOR/broker/mlpz/login?session_code=x",
                    303,
                    "AUTH_SESSION_ID=a; Path=/auth/realms/EDOR/; Secure"
                );
            case "GET edoreczenia.gov.pl/auth/realms/EDOR/broker/mlpz/login":
                return redirect("https://serwis.epuap.gov.pl/mlpz/login?ORIGIN=x");
            case "GET serwis.epuap.gov.pl/mlpz/login":
                return redirect("https://serwis.epuap.gov.pl/mlpz/context?ORIGIN=x", 302, "JSESSIONID_MLPZ=j; Path=/");
            case "GET serwis.epuap.gov.pl/mlpz/context":
                return html(
                    `<form method="post" action="https://login.gov.pl/login/SingleSignOnService"><input type="hidden" name="SAMLRequest" value="req"/></form>`
                );
            case "POST login.gov.pl/login/SingleSignOnService":
                return redirect("https://login.gov.pl/login/login?ssot=t", 301, "entryToken=e; Path=/");
            case "GET login.gov.pl/login/login":
                return html(`<app-root></app-root>`);
            case "GET login.gov.pl/web/api/login-entries":
                expect(cookies).toContain("entryToken=e");
                expect(headers.get("accept")).toBe("application/v2+json");
                return json({
                    serviceProvider: {},
                    mainEntries: [
                        { type: "TRUSTED_PROFILE", identityProviderId: "1" },
                        { type: "MOBILE_ID", identityProviderId: "4200000000000000000" },
                    ],
                });
            case "POST login.gov.pl/web/api/identity-providers/4200000000000000000/authenticate":
                return html(
                    `<form method="post" action="https://login.mobywatel.gov.pl/sso"><input type="hidden" name="SAMLRequest" value="r2"/><input type="hidden" name="postLocationUrl" value="p"/></form>`
                );
            case "POST login.mobywatel.gov.pl/sso":
                return redirect("https://login.mobywatel.gov.pl/", 302, "sessionKey=k; Path=/");
            case "GET login.mobywatel.gov.pl/":
                return html(`<app-root></app-root>`);
            case "GET login.mobywatel.gov.pl/api/login/auth/qr-code":
                expect(cookies).toContain("sessionKey=k");
                return json({
                    token: "a;b;c;d;e;f;g;0f8fad5b-d9cb-469f-a165-70867728950e;i",
                    value: "data:image/png;base64,AAAA",
                });
            case "POST login.gov.pl/login/SingleSignOnClientService":
                expect(String(init?.body)).toBe("SAMLart=ART");
                return redirect("https://serwis.epuap.gov.pl/mlpz/userDataForConfirmedIdentity");
            case "GET serwis.epuap.gov.pl/mlpz/userDataForConfirmedIdentity":
                return withChoice
                    ? html(
                          `<form method="post" action="/mlpz/chooseContext"><input type="radio" name="ctx" value="person" id="p"/><label for="p">Osoba</label><input type="radio" name="ctx" value="org" id="o"/><label for="o">Firma</label><button type="submit">OK</button></form>`
                      )
                    : keycloakEndpointForm.clone();
            case "POST serwis.epuap.gov.pl/mlpz/chooseContext":
                expect(String(init?.body)).toContain("ctx=org");
                return keycloakEndpointForm.clone();
            case "POST edoreczenia.gov.pl/auth/realms/EDOR/broker/mlpz/endpoint":
                return redirect(
                    `${redirectUri}?state=${authState}&code=CODE`,
                    302,
                    "KEYCLOAK_IDENTITY=id; Path=/auth/realms/EDOR/; Secure"
                );
            case "POST edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/token": {
                const params = new URLSearchParams(String(init?.body));
                expect(params.get("code")).toBe("CODE");
                expect(params.get("client_id")).toBe("edor-dashboard");
                expect(params.get("code_verifier")).toHaveLength(43);

                return json({
                    access_token: jwt({
                        iat: nowSeconds(),
                        exp: nowSeconds() + 300,
                        person_identifier: "00000000000",
                        organization_epuap_id: "123",
                    }),
                    refresh_token: jwt({ iat: nowSeconds(), exp: nowSeconds() + 1800, jti: "r1" }),
                    expires_in: 300,
                });
            }
        }

        throw new Error(`unexpected ${method} ${url.href}`);
    };

    return { fetch };
};

// The state goes through JSON between phases, as it would through any storage.
const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("QR login flow", () => {
    it("runs the phases with JSON-serializable state", async () => {
        const { fetch } = fakeGov();
        const { state, qr } = await startQrLogin({ fetch });

        expect(qr.image).toMatch(/^data:image\/png/);
        expect(qr.topic).toBe("/topic/0f8fad5b-d9cb-469f-a165-70867728950e");
        expect(qr.deeplink).toMatch(/^mobywatel:\/\/app\/institutions\?qrCode=/);

        const result = await completeLogin(throughJson<LoginState>(state), { confirmation: CONFIRMATION }, { fetch });
        expect(result.kind).toBe("done");
        if (result.kind !== "done") return;

        expect(result.session.claims("dashboard")?.organization_epuap_id).toBe("123");
        // Only Keycloak cookies make it into the session.
        expect(result.session.toJSON().jar!.map(({ name }) => name).sort()).toEqual(["AUTH_SESSION_ID", "KEYCLOAK_IDENTITY"]);
    });

    it("returns a choice for context forms and resumes", async () => {
        const { fetch } = fakeGov({ withChoice: true });
        const { state } = await startQrLogin({ fetch });

        const first = await completeLogin(state, { confirmation: CONFIRMATION }, { fetch });
        expect(first.kind).toBe("choice");
        if (first.kind !== "choice") return;
        expect(first.options.map(({ label }) => label)).toEqual(["Osoba", "Firma"]);

        const second = await completeLogin(throughJson(first.state), { choice: "1" }, { fetch });
        expect(second.kind).toBe("done");
    });

    it("refreshes the QR code within the same mObywatel session", async () => {
        const { fetch } = fakeGov();
        const { state } = await startQrLogin({ fetch });
        const { qr } = await refreshQr(state, { fetch });

        expect(qr.token).toContain(";");
    });

    it("halts on an unexpected infrastructure response", async () => {
        const fetch = async () => new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } });

        await expect(startQrLogin({ fetch })).rejects.toBeInstanceOf(FlowHalt);
    });
});
