import { HOSTS } from "../constants.js";
import type { BrowserHttp } from "../tools/BrowserHttp.js";

/** The `/web/api` layer of the login.gov.pl SPA (Węzeł Krajowy). */
export const LOGIN_GOV_API = `${HOSTS.loginGov}/web/api`;

export type LoginEntryType =
    | "TRUSTED_PROFILE"
    | "MOBILE_ID"
    | "BANKS"
    | "PERSONAL_ID"
    | "FOREIGN_IDENTITY"
    | "BANK"
    | "COOPERATIVE_BANK"
    | (string & {});

export type LoginEntry = {
    type: LoginEntryType;
    identityProviderId: string;
    displayName?: string;
    name?: string;
    bankName?: string;
    logoVersion?: string | number;
    disabled?: boolean;
    /** Offered only in the Polish UI. */
    onlyDomestic?: boolean;
    announcement?: { messages?: unknown };
    [key: string]: unknown;
};

export type LoginEntries = {
    serviceProvider?: {
        name?: string;
        foreign?: boolean;
        commercial?: boolean;
        foreignAuthentication?: boolean;
        [key: string]: unknown;
    };
    lastSelectedEntry?: LoginEntry | null;
    mainEntries: LoginEntry[];
    bankEntries?: LoginEntry[];
    cooperativeBankEntries?: LoginEntry[];
    voivodeships?: unknown[];
    foreignCountries?: { countryCode?: string; displayName: string; [key: string]: unknown }[];
};

export const getLoginEntries = async (
    http: BrowserHttp,
    { referer, lastSelectedIdentityProviderId }: { referer?: string; lastSelectedIdentityProviderId?: string } = {}
) => {
    const url = new URL(`${LOGIN_GOV_API}/login-entries`);
    if (lastSelectedIdentityProviderId) {
        url.searchParams.set("lastSelectedIdentityProviderId", lastSelectedIdentityProviderId);
    }

    const { data } = await http.getJson<LoginEntries>("login-gov-entries", url, {
        Accept: "application/v2+json",
        ...(referer && { Referer: referer }),
    });
    if (!Array.isArray(data?.mainEntries)) http.halt("login-gov-entries", "login-entries without mainEntries[]");

    return data;
};

export const getCooperativeBankEntries = async (http: BrowserHttp) => {
    const { data } = await http.getJson<LoginEntry[]>(
        "login-gov-coop-banks",
        `${LOGIN_GOV_API}/login-entries/cooperative-banks`
    );

    return data;
};

export const loginEntryLogoUrl = ({ identityProviderId, logoVersion }: Pick<LoginEntry, "identityProviderId" | "logoVersion">) =>
    `${LOGIN_GOV_API}/login-entries/${identityProviderId}/logo?version=${logoVersion ?? ""}`;

export const allEntries = (entries: LoginEntries) => [
    ...entries.mainEntries,
    ...(entries.bankEntries ?? []),
    ...(entries.cooperativeBankEntries ?? []),
];

export const findEntry = (entries: LoginEntries, type: LoginEntryType) =>
    allEntries(entries).find((entry) => entry.type === type && !entry.disabled) ?? null;

/**
 * Selects an identity provider, like clicking its tile. The SPA posts an empty form; the
 * response is usually an HTML auto-POST of a `SAMLRequest` to the provider.
 */
export const authenticate = async (
    http: BrowserHttp,
    identityProviderId: string,
    { referer, countryCode }: { referer?: string; countryCode?: string } = {}
) => {
    const url = new URL(`${LOGIN_GOV_API}/identity-providers/${encodeURIComponent(identityProviderId)}/authenticate`);
    if (countryCode) url.searchParams.set("countryCode", countryCode);

    const headers = { Origin: HOSTS.loginGov, ...(referer && { Referer: referer }) };

    const response = await http.request("login-gov-authenticate", url, {
        method: "POST",
        body: "",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    });
    if (response.response.status < 400) return response;

    // Fallback: a JSON `{}` body, a variant that was confirmed to work as well.
    return http.request("login-gov-authenticate", url, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/html, */*", ...headers },
        note: "retry as JSON",
    });
};
