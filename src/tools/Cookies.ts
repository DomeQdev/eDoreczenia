/**
 * Implements the part of RFC 6265 used by the login domains: Domain, Path, Max-Age and
 * Expires. SameSite is ignored. The jar is plain JSON (`toJSON` / `fromJSON`), so the
 * login state and the Keycloak SSO session can be persisted anywhere.
 */
export type StoredCookie = {
    name: string;
    value: string;
    /** Without the leading dot. */
    domain: string;
    /** Sent to `domain` only, not to its subdomains. */
    hostOnly: boolean;
    path: string;
    /** Epoch ms, `null` for session cookies. */
    expires: number | null;
};

const keyOf = ({ domain, path, name }: StoredCookie) => `${domain}|${path}|${name}`;

const isExpired = (cookie: StoredCookie, now: number) => cookie.expires !== null && cookie.expires <= now;

export class CookieJar {
    private readonly cookies = new Map<string, StoredCookie>();

    static fromJSON(data: StoredCookie[] | null | undefined) {
        const jar = new CookieJar();
        for (const cookie of data ?? []) jar.set(cookie);
        jar.prune();

        return jar;
    }

    toJSON() {
        this.prune();

        return [...this.cookies.values()];
    }

    get size() {
        return this.cookies.size;
    }

    set(cookie: StoredCookie) {
        this.cookies.set(keyOf(cookie), cookie);
    }

    storeFromResponse(url: URL, setCookieHeaders: string[], now = Date.now()) {
        for (const header of setCookieHeaders) {
            const cookie = parseSetCookie(header, url, now);
            if (!cookie) continue;

            if (isExpired(cookie, now)) this.cookies.delete(keyOf(cookie));
            else this.set(cookie);
        }
    }

    cookiesFor(url: URL, now = Date.now()) {
        const host = url.hostname.toLowerCase();
        const path = url.pathname || "/";

        return [...this.cookies.values()]
            .filter(
                (cookie) =>
                    !isExpired(cookie, now) &&
                    (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
                    pathMatches(path, cookie.path)
            )
            .sort((a, b) => b.path.length - a.path.length);
    }

    headerFor(url: URL, now = Date.now()) {
        const cookies = this.cookiesFor(url, now);

        return cookies.length ? cookies.map(({ name, value }) => `${name}=${value}`).join("; ") : null;
    }

    /** Names of the cookies that would be sent to `url` — safe to log. */
    describe(url: URL) {
        return this.cookiesFor(url).map(({ name }) => name);
    }

    /** Removes cookies of `domain` and its subdomains. */
    clearDomain(domain: string) {
        for (const [key, cookie] of this.cookies) {
            if (domainMatches(cookie.domain, domain)) this.cookies.delete(key);
        }
    }

    clear() {
        this.cookies.clear();
    }

    /** Drops expired cookies. Session cookies stay — when the session ends is up to the jar's owner. */
    prune(now = Date.now()) {
        for (const [key, cookie] of this.cookies) {
            if (isExpired(cookie, now)) this.cookies.delete(key);
        }
    }
}

export const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export const pathMatches = (requestPath: string, cookiePath: string) => {
    if (requestPath === cookiePath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;

    return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
};

export const defaultPath = (url: URL) => {
    const path = url.pathname;
    if (!path.startsWith("/")) return "/";

    const lastSlash = path.lastIndexOf("/");

    return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
};

export const parseSetCookie = (header: string, url: URL, now = Date.now()): StoredCookie | null => {
    const [pair = "", ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) return null;

    const host = url.hostname.toLowerCase();
    const cookie: StoredCookie = {
        name: pair.slice(0, separator).trim(),
        value: pair.slice(separator + 1).trim(),
        domain: host,
        hostOnly: true,
        path: defaultPath(url),
        expires: null,
    };
    let maxAge: number | null = null;

    for (const attribute of attributes) {
        const [rawKey = "", ...rest] = attribute.trim().split("=");
        const key = rawKey.toLowerCase();
        const value = rest.join("=").trim();
        if (!value) continue;

        if (key === "domain") {
            const domain = value.toLowerCase().replace(/^\./, "");
            // A response may only set cookies for its own host or a parent domain.
            if (domainMatches(host, domain)) {
                cookie.domain = domain;
                cookie.hostOnly = false;
            }
        } else if (key === "path" && value.startsWith("/")) {
            cookie.path = value;
        } else if (key === "max-age" && Number.isFinite(Number(value))) {
            maxAge = Number(value);
        } else if (key === "expires" && !Number.isNaN(Date.parse(value))) {
            cookie.expires = Date.parse(value);
        }
    }

    if (maxAge !== null) cookie.expires = now + maxAge * 1000;

    return cookie;
};

export const getSetCookies = (response: Response): string[] => {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();

    const single = response.headers.get("set-cookie");

    return single ? [single] : [];
};
