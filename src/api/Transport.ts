import type { EdoSession } from "../auth/Session.js";
import type { ClientName } from "../constants.js";
import { ApiError, EdoError, parseErrorBody } from "../errors.js";
import { defaultFetch, type FetchLike } from "../tools/BrowserHttp.js";
import type { FileResult, MailboxRef } from "../types/Mailbox.js";

// The official API authorizes with the bearer token alone; no cookies, Origin or Referer needed.

export type TokenProvider = {
    accessToken(client: ClientName, options?: { forceRefresh?: boolean }): Promise<string>;
};

export type QueryValue = string | number | boolean | Date | null | undefined | (string | number)[];
export type Query = Record<string, QueryValue>;

export type TransportOptions = {
    tokens: TokenProvider;
    userAgent: string;
    fetch?: FetchLike;
    /** Default 100 MB. */
    maxDownloadBytes?: number;
};

export type ApiRequest = {
    /** Operation name used in error messages. */
    op: string;
    /** Default `"app"`. */
    client?: ClientName;
    /** Default `"GET"`. */
    method?: string;
    url: string;
    query?: Query;
    /** Sent as JSON, or as multipart when it is a `FormData`. */
    body?: unknown;
    headers?: Record<string, string>;
    accept?: string;
};

/** What the API modules share: the transport, the session (if any) and the selected mailbox. */
export type ApiContext = {
    transport: Transport;
    session: EdoSession | null;
    /** Throws when no mailbox is selected. */
    mailbox(): MailboxRef;
};

export const requireMailbox = (mailbox: MailboxRef | null | undefined) => {
    if (!mailbox?.eDeliveryAddress) {
        throw new EdoError("mailbox not selected — call session.selectMailbox() or pass `mailbox`");
    }

    return mailbox;
};

/** Path segment for one or more ids; several are joined with commas. */
export const idsSegment = (ids: string | string[]) => encodeURIComponent([ids].flat().join(","));

export const buildQuery = (query: Query | undefined) => {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query ?? {})) {
        if (value === undefined || value === null || value === "") continue;

        if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
        else params.set(key, value instanceof Date ? value.toISOString() : String(value));
    }

    const search = params.toString();

    return search ? `?${search}` : "";
};

const parseBody = <T>(text: string): T => {
    if (!text) return undefined as T;

    try {
        return JSON.parse(text) as T;
    } catch {
        // Some operations answer with plain text, e.g. a bare id.
        return text as T;
    }
};

export class Transport {
    readonly tokens: TokenProvider;
    readonly userAgent: string;
    readonly fetch: FetchLike;
    private readonly maxDownloadBytes: number;

    constructor(options: TransportOptions) {
        this.tokens = options.tokens;
        this.userAgent = options.userAgent;
        this.fetch = options.fetch ?? defaultFetch;
        this.maxDownloadBytes = options.maxDownloadBytes ?? 100 * 1024 * 1024;
    }

    /** An empty response resolves to `undefined`. */
    async json<T>(request: ApiRequest): Promise<T> {
        const response = await this.send(request, "application/json");

        return parseBody<T>(await response.text());
    }

    /** A JSON response is treated as an error. */
    async file(request: ApiRequest): Promise<FileResult> {
        const response = await this.send(request, "application/octet-stream,application/json");

        return readFile(request.op, response, this.maxDownloadBytes);
    }

    private async send(
        { op, client = "app", method = "GET", url, query, body, headers, accept }: ApiRequest,
        defaultAccept: string
    ) {
        const isForm = body instanceof FormData;
        const payload = body === undefined ? undefined : isForm ? body : JSON.stringify(body);
        const target = url + buildQuery(query);

        // A 401 is retried once with a forcibly refreshed token.
        for (let attempt = 0; ; attempt++) {
            const token = await this.tokens.accessToken(client, { forceRefresh: attempt > 0 });
            const requestHeaders = new Headers({
                Authorization: `Bearer ${token}`,
                Accept: accept ?? defaultAccept,
                "User-Agent": this.userAgent,
                ...headers,
            });
            if (payload !== undefined && !isForm) requestHeaders.set("Content-Type", "application/json");

            const response = await this.fetch(target, { method, headers: requestHeaders, body: payload });

            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel();
                continue;
            }

            if (!response.ok) {
                const { code, details } = parseErrorBody(await response.text().catch(() => ""));
                throw new ApiError(op, response.status, code, details);
            }

            return response;
        }
    }
}

export const readFile = async (op: string, response: Response, maxBytes: number): Promise<FileResult> => {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";

    if (contentType === "application/json") {
        const { code, details } = parseErrorBody(await response.text());
        throw new ApiError(op, response.status, code ?? "json-instead-of-file", details);
    }

    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
        await response.body?.cancel();
        throw new ApiError(op, response.status, "too-large");
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ApiError(op, response.status, "too-large");

    return { bytes, contentType, filename: filenameFromDisposition(response.headers.get("content-disposition")) };
};

export const filenameFromDisposition = (header: string | null) => {
    if (!header) return null;

    const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ""));
        } catch {
            // Malformed encoding; fall back to the plain `filename`.
        }
    }

    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);

    return plain ? (plain[2] ?? plain[1] ?? "").trim() : null;
};
