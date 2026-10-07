import { DashboardApi } from "./api/Dashboard.js";
import { DraftsApi } from "./api/Drafts.js";
import { EpuapApi } from "./api/Epuap.js";
import { MessagesApi } from "./api/Messages.js";
import { PermissionsApi } from "./api/Permissions.js";
import { SearchApi } from "./api/Search.js";
import { SettingsApi } from "./api/Settings.js";
import { Transport, requireMailbox, type ApiContext, type TokenProvider } from "./api/Transport.js";
import type { EdoSession } from "./auth/Session.js";
import { DEFAULT_USER_AGENT } from "./constants.js";
import { EdoError } from "./errors.js";
import type { FetchLike } from "./tools/BrowserHttp.js";
import type { MailboxRef, Service } from "./types/Mailbox.js";

export type EdoClientOptions = {
    /** Session from `loginWithQr`. Pass `tokens` instead to use tokens obtained elsewhere. */
    session?: EdoSession;
    tokens?: TokenProvider;
    /** Defaults to the session's selected mailbox. */
    mailbox?: MailboxRef;
    /** `service` filter of lists and counters. Default `"All"`. */
    service?: Service;
    userAgent?: string;
    fetch?: FetchLike;
    /** Default 100 MB. */
    maxDownloadBytes?: number;
};

/**
 * ```ts
 * const session = await loginWithQr({ onQr: (qr) => show(qr.image) });
 * await session.selectMailbox();
 *
 * const edo = new EdoClient({ session });
 * const { messages = [] } = await edo.messages.list({ label: "INBOX" });
 * const opened = messages.filter((message) => message.messageControlData?.opened);
 * const full = await edo.messages.get(opened[0]); // no side effects, already opened
 * ```
 *
 * Opening an unopened message, or downloading its files, needs `acknowledgeReceipt: true` in the
 * call — it confirms delivery with legal effect.
 */
export class EdoClient {
    readonly transport: Transport;
    readonly messages: MessagesApi;
    readonly drafts: DraftsApi;
    readonly epuap: EpuapApi;
    readonly settings: SettingsApi;
    readonly search: SearchApi;
    readonly permissions: PermissionsApi;
    readonly dashboard: DashboardApi;

    private readonly session: EdoSession | null;
    private readonly fixedMailbox: MailboxRef | null;

    constructor(options: EdoClientOptions) {
        const tokens = options.tokens ?? options.session;
        if (!tokens) throw new EdoError("EdoClient: pass `session` or `tokens`");

        this.session = options.session ?? null;
        this.fixedMailbox = options.mailbox ?? null;
        this.transport = new Transport({
            tokens,
            userAgent: options.userAgent ?? this.session?.userAgent ?? DEFAULT_USER_AGENT,
            fetch: options.fetch,
            maxDownloadBytes: options.maxDownloadBytes,
        });

        const context: ApiContext = {
            transport: this.transport,
            session: this.session,
            mailbox: () => this.mailbox,
        };

        this.messages = new MessagesApi(context, options.service);
        this.drafts = new DraftsApi(context);
        this.epuap = new EpuapApi(context);
        this.settings = new SettingsApi(context);
        this.search = new SearchApi(context);
        this.permissions = new PermissionsApi(context);
        this.dashboard = new DashboardApi(context);
    }

    get mailbox() {
        return requireMailbox(this.fixedMailbox ?? this.session?.mailbox);
    }
}
