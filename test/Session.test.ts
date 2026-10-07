import { describe, expect, it } from "vitest";
import { EdoSession } from "../src/auth/Session.js";
import { CookieJar } from "../src/tools/Cookies.js";

describe("EdoSession", () => {
    it("survives a JSON round trip with cookies and tokens", async () => {
        const jar = new CookieJar();
        jar.storeFromResponse(new URL("https://edoreczenia.gov.pl/auth/realms/EDOR/x"), [
            "KEYCLOAK_IDENTITY=abc; Path=/auth/realms/EDOR/; Secure; HttpOnly",
        ]);

        const now = Date.now();
        const session = new EdoSession({
            jar: jar.toJSON(),
            tokens: {
                dashboard: {
                    client: "dashboard",
                    accessToken: "a",
                    refreshToken: "r",
                    idToken: null,
                    accessExpiresAt: now + 300_000,
                    refreshExpiresAt: now + 1_800_000,
                    refreshJti: null,
                    obtainedAt: now,
                },
            },
        });

        const restored = EdoSession.fromJSON(JSON.parse(JSON.stringify(session)));

        expect(restored.tokens("dashboard")?.accessToken).toBe("a");
        expect(
            CookieJar.fromJSON(restored.toJSON().jar).headerFor(new URL("https://edoreczenia.gov.pl/auth/realms/EDOR/protocol"))
        ).toBe("KEYCLOAK_IDENTITY=abc");
        expect(await restored.accessToken("dashboard")).toBe("a");
        expect(restored.isAlive()).toBe(true);
        expect(restored.nextRefreshAt()).toBe(now + 300_000 - 30_000);
    });
});
