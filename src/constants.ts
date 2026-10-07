export const HOSTS = {
    /** Dashboard, mailbox API and the `edor-dashboard` Keycloak. */
    dashboard: "https://edoreczenia.gov.pl",
    /** Keycloak for `edor-app` and `edor-mu`, address search, permission management. */
    ow: "https://ow.edoreczenia.gov.pl",
    /** Operator's (Poczta Polska) UA API — attachment files. */
    uaapi: "https://uaapi-ow.poczta-polska.pl",
    epuap: "https://epuap.gov.pl",
    epuapService: "https://serwis.epuap.gov.pl",
    loginGov: "https://login.gov.pl",
    mobywatel: "https://login.mobywatel.gov.pl",
} as const;

export const REALM_PATH = "/auth/realms/EDOR";

/** API base URLs. Comments name the matching key in the official apps' `config.json`. */
export const API = {
    /** `uaAPI` — messages, folders, drafts, evidences, settings, ePUAP. */
    beuis: `${HOSTS.dashboard}/api/beuis/v2`,
    /** `pocztaAPI` — file upload and download. */
    uaapi: `${HOSTS.uaapi}/api/v3`,
    /** `seAPI` — electronic address search. */
    se: `${HOSTS.ow}/api/se/v4`,
    /** `pmAPI` — mailbox users, roles, systems and folders. */
    pm: `${HOSTS.ow}/api/permission-management/v1`,
    /** `terytAPI` — territorial division dictionary. */
    teryt: `${HOSTS.dashboard}/api/bae-teryt/v1`,
    /** `kppAPI` — paths already start with `/api/bae-integrator-kpp`. */
    kpp: HOSTS.dashboard,
    /** `discoveryAPI` — addresses the user has access to. */
    discovery: `${HOSTS.dashboard}/api/spdp/v1`,
    /** `baeAPI` — electronic address registry. */
    bae: `${HOSTS.dashboard}/api/bae/v1`,
    /** `baePeselAPI` — personal data from the PESEL registry. */
    baePesel: `${HOSTS.dashboard}/api/bae-pesel/v1`,
    /** `requestManagerAPI` */
    requestManager: `${HOSTS.dashboard}/api/rm/v1`,
    /** `mobywatelAPI` — header and menu configuration. */
    menu: `${HOSTS.dashboard}/api/menu/v1`,
    /** ePUAP file servlet, authorized with a `TGSID` form field instead of a bearer token. */
    epuapDownload: `${HOSTS.epuap}/file-download-servlet/DownloadServlet`,
} as const;

export type ClientName = "dashboard" | "app" | "mu";

export type OidcClient = {
    id: string;
    /** Keycloak host; the issuer is `host + REALM_PATH`. */
    host: string;
    redirectUri: (ade?: string) => string;
};

/** The three Keycloak clients share one SSO session. */
export const CLIENTS: Record<ClientName, OidcClient> = {
    dashboard: {
        id: "edor-dashboard",
        host: HOSTS.dashboard,
        redirectUri: () => `${HOSTS.dashboard}/`,
    },
    /** Mailbox client. Its tokens are bound to a single address passed as `login_hint`. */
    app: {
        id: "edor-app",
        host: HOSTS.ow,
        redirectUri: (ade) => `${HOSTS.dashboard}/aplikacja/${ade ?? ""}`,
    },
    mu: {
        id: "edor-mu",
        host: HOSTS.ow,
        redirectUri: () => `${HOSTS.ow}/mu/`,
    },
};

/** Keycloak identity provider alias that brokers to ePUAP and then login.gov.pl. */
export const IDP_HINT = "mlpz";

export const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export const oidcEndpoint = (host: string, endpoint: "auth" | "token" | "logout" | "userinfo") =>
    `${host}${REALM_PATH}/protocol/openid-connect/${endpoint}`;

/** Ends the ePUAP session. `tgsid` is the `authentication.session_index` claim of an `edor-app` token. */
export const epuapLogoutUrl = (tgsid?: string) => {
    const params = new URLSearchParams({ ORIGIN: "logout", LOGOUT: "Y", redirectTo: "GovMainPageURL" });
    if (tgsid) params.set("TGSID", tgsid);

    return `${HOSTS.epuapService}/mlpz/login?${params}`;
};
