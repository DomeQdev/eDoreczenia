import { API, DEFAULT_USER_AGENT, type ClientName } from "../constants.js";
import { ApiError, OidcError, SessionExpiredError } from "../errors.js";
import { BrowserHttp, defaultFetch, type FetchLike } from "../tools/BrowserHttp.js";
import { CookieJar, type StoredCookie } from "../tools/Cookies.js";
import { decodeJwt } from "../tools/Encoding.js";
import type { TraceSink } from "../tools/Trace.js";
import type { MailboxRef } from "../types/Mailbox.js";
import {
    authorizeViaSso,
    logout,
    refreshTokens,
    type AppTokenClaims,
    type DashboardTokenClaims,
    type TokenSet,
} from "./Oidc.js";

export type SessionData = {
    userAgent?: string;
    jar?: StoredCookie[];
    tokens: Partial<Record<ClientName, TokenSet>>;
    mailbox?: MailboxRef | null;
};

export type SessionOptions = {
    fetch?: FetchLike;
    /** Called after every change, e.g. to persist the session. */
    onChange?: (data: SessionData) => void | Promise<void>;
    onTrace?: TraceSink;
    /** Refresh access tokens this long before they expire. Default 30 s. */
    refreshMarginMs?: number;
};

/** Entry of `discoveryPlus/authorizedAddressesExtended`. */
export type AuthorizedAddress = {
    eDeliveryAddress: string;
    EDAStatus?: string;
    EDARelationshipStatus?: string;
    organizationFullName?: string;
    organizationEpuapId?: string;
    userRole?: string;
    context?: string;
    [key: string]: unknown;
};

/**
 * Tokens of the three OIDC clients, the Keycloak SSO cookies and the selected mailbox.
 *
 * Access tokens live 5 minutes and refresh tokens 30 minutes (SSO idle timeout). `accessToken()`
 * refreshes transparently, falls back to SSO when the refresh token is gone, and throws
 * `SessionExpiredError` when neither works. The state is plain JSON (`toJSON` / `fromJSON`).
 */
export class EdoSession {
    private data: SessionData;
    private readonly fetch: FetchLike;
    private readonly margin: number;
    private readonly pending = new Map<ClientName, Promise<TokenSet>>();

    constructor(
        data: SessionData,
        private readonly options: SessionOptions = {}
    ) {
        this.data = { userAgent: DEFAULT_USER_AGENT, jar: [], mailbox: null, ...data };
        this.fetch = options.fetch ?? defaultFetch;
        this.margin = options.refreshMarginMs ?? 30_000;
    }

    static fromJSON(data: SessionData, options?: SessionOptions) {
        return new EdoSession(structuredClone(data), options);
    }

    toJSON(): SessionData {
        return structuredClone(this.data);
    }

    get userAgent() {
        return this.data.userAgent ?? DEFAULT_USER_AGENT;
    }

    get mailbox() {
        return this.data.mailbox ?? null;
    }

    tokens(client: ClientName) {
        return this.data.tokens[client] ?? null;
    }

    /** Access token claims, without signature verification. */
    claims(client: "app"): AppTokenClaims | null;
    claims(client: "dashboard"): DashboardTokenClaims | null;
    claims(client: ClientName): Record<string, unknown> | null;
    claims(client: ClientName) {
        const tokens = this.data.tokens[client];

        return tokens ? decodeJwt(tokens.accessToken) : null;
    }

    /** True while some token can still be used or refreshed without the user. */
    isAlive(now = Date.now()) {
        return this.allTokens().some(
            (tokens) =>
                tokens.accessExpiresAt > now || (tokens.refreshToken && (tokens.refreshExpiresAt ?? 0) > now)
        );
    }

    /** Earliest moment a token needs refreshing, for scheduling `keepAlive`. */
    nextRefreshAt() {
        const times = this.allTokens()
            .filter((tokens) => tokens.refreshToken)
            .map((tokens) => Math.min(tokens.accessExpiresAt - this.margin, (tokens.refreshExpiresAt ?? Infinity) - 60_000));

        return times.length ? Math.min(...times) : null;
    }

    async accessToken(client: ClientName, { forceRefresh = false }: { forceRefresh?: boolean } = {}) {
        const tokens = this.data.tokens[client];
        if (tokens && !forceRefresh && tokens.accessExpiresAt - this.margin > Date.now()) return tokens.accessToken;

        return (await this.renew(client)).accessToken;
    }

    /** Refreshes the client's tokens. Concurrent calls share a single request. */
    renew(client: ClientName) {
        let renewal = this.pending.get(client);
        if (!renewal) {
            renewal = this.doRenew(client).finally(() => this.pending.delete(client));
            this.pending.set(client, renewal);
        }

        return renewal;
    }

    /** Tokens for a client through SSO, e.g. `mu`, or `app` for another mailbox. */
    async authorize(client: ClientName, { ade }: { ade?: string } = {}) {
        const tokens = await this.sso(client, ade);
        if (!tokens) throw new SessionExpiredError(`${client}: no SSO session`);

        return tokens;
    }

    /** Mailboxes the user can access, queried with the PESEL from the dashboard token. */
    async listMailboxes(): Promise<AuthorizedAddress[]> {
        const pesel = this.claims("dashboard")?.person_identifier;
        if (!pesel) throw new SessionExpiredError("dashboard token missing (person_identifier)");

        const token = await this.accessToken("dashboard");
        const response = await this.fetch(`${API.discovery}/discoveryPlus/authorizedAddressesExtended`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": this.userAgent,
            },
            body: JSON.stringify({ idType: "PESEL", idValue: pesel }),
        });
        if (!response.ok) throw new ApiError("authorizedAddressesExtended", response.status);

        const { eDeliveryAddressData = [] } = (await response.json()) as { eDeliveryAddressData?: AuthorizedAddress[] };

        return eDeliveryAddressData.filter(({ eDeliveryAddress }) => typeof eDeliveryAddress === "string" && eDeliveryAddress);
    }

    /**
     * Selects a mailbox and gets an `edor-app` token for it. Without `ade` the only available
     * mailbox is selected; with several, it fails with an `ambiguous` code.
     */
    async selectMailbox(ade?: string) {
        const claimedEpuapId = this.claims("dashboard")?.organization_epuap_id;
        let picked: AuthorizedAddress | undefined;

        if (ade && claimedEpuapId) {
            picked = { eDeliveryAddress: ade, organizationEpuapId: claimedEpuapId };
        } else {
            const all = await this.listMailboxes();
            picked = ade ? all.find((address) => address.eDeliveryAddress === ade) : all.length === 1 ? all[0] : undefined;
            if (!picked) {
                throw new ApiError("selectMailbox", 0, ade ? "mailbox-not-found" : `ambiguous (${all.length} mailboxes)`);
            }
        }

        const organizationEpuapId = picked.organizationEpuapId || claimedEpuapId;
        if (!organizationEpuapId) throw new ApiError("selectMailbox", 0, "no-organizationEpuapId");

        await this.authorize("app", { ade: picked.eDeliveryAddress });
        this.data.mailbox = { eDeliveryAddress: picked.eDeliveryAddress, organizationEpuapId };
        await this.changed();

        return this.data.mailbox;
    }

    /** Renews tokens that are about to expire. Run it periodically to keep the session alive. */
    async keepAlive() {
        const refreshed: ClientName[] = [];
        const expired: ClientName[] = [];

        for (const { client, accessExpiresAt } of this.allTokens()) {
            if (accessExpiresAt - this.margin * 2 > Date.now()) continue;

            try {
                await this.renew(client);
                refreshed.push(client);
            } catch (error) {
                if (!(error instanceof SessionExpiredError)) throw error;
                expired.push(client);
            }
        }

        return { refreshed, expired };
    }

    /** Logs out of Keycloak for every client and clears the state. */
    async logout() {
        for (const tokens of this.allTokens()) {
            await logout({ tokens, userAgent: this.userAgent, fetch: this.fetch }).catch(() => false);
        }

        this.data = { userAgent: this.data.userAgent, jar: [], tokens: {}, mailbox: null };
        await this.changed();
    }

    private async doRenew(client: ClientName) {
        const current = this.data.tokens[client];

        if (current?.refreshToken && (current.refreshExpiresAt ?? Infinity) > Date.now()) {
            try {
                const next = await refreshTokens({ tokens: current, userAgent: this.userAgent, fetch: this.fetch });
                this.data.tokens[client] = next;
                await this.changed();

                return next;
            } catch (error) {
                const rejected =
                    error instanceof OidcError &&
                    (error.code === "invalid_grant" || error.status === 400 || error.status === 401);
                if (!rejected) throw error;
            }
        }

        // `app` and `mu` tokens are bound to a mailbox, the dashboard token is not.
        const ade = client === "dashboard" ? undefined : (current?.ade ?? this.data.mailbox?.eDeliveryAddress);
        const tokens = await this.sso(client, ade);
        if (tokens) return tokens;

        delete this.data.tokens[client];
        await this.changed();
        throw new SessionExpiredError(`${client}: session expired — QR login required`);
    }

    private async sso(client: ClientName, ade?: string) {
        if (!this.data.jar?.length) return null;

        const http = new BrowserHttp({
            userAgent: this.userAgent,
            jar: CookieJar.fromJSON(this.data.jar),
            fetch: this.fetch,
            onTrace: this.options.onTrace,
        });
        const tokens = await authorizeViaSso(http, client, { ade });

        this.data.jar = http.jar.toJSON();
        if (tokens) this.data.tokens[client] = tokens;
        await this.changed();

        return tokens;
    }

    private allTokens() {
        return Object.values(this.data.tokens).filter((tokens): tokens is TokenSet => tokens !== undefined);
    }

    private async changed() {
        await this.options.onChange?.(this.toJSON());
    }
}
