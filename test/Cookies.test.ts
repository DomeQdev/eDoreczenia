import { describe, expect, it } from "vitest";
import { CookieJar, parseSetCookie } from "../src/tools/Cookies.js";

describe("CookieJar", () => {
    it("stores host-only cookies and sends them back for a matching path", () => {
        const jar = new CookieJar();
        jar.storeFromResponse(new URL("https://edoreczenia.gov.pl/auth/realms/EDOR/protocol/openid-connect/auth?x=1"), [
            "AUTH_SESSION_ID=abc; Path=/auth/realms/EDOR/; HttpOnly; Secure; SameSite=None",
            "KC_RESTART=zzz; Path=/auth/realms/EDOR/",
        ]);

        expect(jar.headerFor(new URL("https://edoreczenia.gov.pl/auth/realms/EDOR/broker/mlpz/login"))).toBe(
            "AUTH_SESSION_ID=abc; KC_RESTART=zzz"
        );
        expect(jar.headerFor(new URL("https://edoreczenia.gov.pl/api/x"))).toBeNull();
        expect(jar.headerFor(new URL("https://ow.edoreczenia.gov.pl/auth/realms/EDOR/x"))).toBeNull();
    });

    it("sends domain cookies to subdomains", () => {
        const jar = new CookieJar();
        jar.storeFromResponse(new URL("https://login.gov.pl/login/x"), ["dtCookie=1; Domain=.gov.pl; Path=/"]);

        expect(jar.headerFor(new URL("https://serwis.epuap.gov.pl/mlpz/login"))).toBe("dtCookie=1");
    });

    it("keeps a cookie with a foreign Domain host-only", () => {
        const jar = new CookieJar();
        jar.storeFromResponse(new URL("https://login.gov.pl/"), ["evil=1; Domain=example.com; Path=/"]);

        expect(jar.headerFor(new URL("https://example.com/"))).toBeNull();
        expect(jar.headerFor(new URL("https://login.gov.pl/"))).toBe("evil=1");
    });

    it("removes a cookie on Max-Age=0", () => {
        const jar = new CookieJar();
        const url = new URL("https://a.pl/");
        jar.storeFromResponse(url, ["s=1; Path=/"]);
        jar.storeFromResponse(url, ["s=1; Path=/; Max-Age=0"]);

        expect(jar.headerFor(url)).toBeNull();
    });

    it("derives the default path from the request URL", () => {
        const cookie = parseSetCookie("BIGipServer=x; Secure", new URL("https://login.gov.pl/login/login"));

        expect(cookie?.path).toBe("/login");
        expect(cookie?.hostOnly).toBe(true);
    });

    it("describes cookies by name only", () => {
        const jar = new CookieJar();
        jar.storeFromResponse(new URL("https://a.pl/"), ["secret=verysecret; Path=/"]);

        expect(jar.describe(new URL("https://a.pl/x"))).toEqual(["secret"]);
    });
});
