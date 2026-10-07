import { FlowHalt } from "../errors.js";
import { CookieJar, getSetCookies } from "./Cookies.js";
import { formPayload, isAutoSubmittable, parseForms, parseMetaRefresh, type ParsedForm } from "./Html.js";
import { Trace, type TraceSink } from "./Trace.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Wrapped because some runtimes throw when the global `fetch` is called with a foreign `this`.
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export type BrowserRequest = {
    method?: "GET" | "POST";
    body?: URLSearchParams | string | null;
    headers?: Record<string, string>;
    /** Follow redirects. Default `true`. */
    follow?: boolean;
    maxHops?: number;
    /** When a redirect target matches, it is returned as `stoppedAt` instead of being fetched (e.g. an OIDC callback). */
    stopAt?: (location: URL) => boolean;
    note?: string;
};

export type BrowserResponse = {
    response: Response;
    url: URL;
    text: string;
    hops: number;
    stoppedAt: URL | null;
    contentType: string;
};

export type BrowserHttpOptions = {
    userAgent: string;
    jar?: CookieJar;
    fetch?: FetchLike;
    onTrace?: TraceSink;
    acceptLanguage?: string;
};

export type AutoSubmitOptions = {
    stopAt?: (location: URL) => boolean;
    /** Stop as soon as a response matches. */
    until?: (response: BrowserResponse) => boolean;
    limit?: number;
};

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * HTTP client that walks the login chain the way a browser does: it keeps cookies and
 * follows redirects by hand (303 turns into GET, 307/308 keep the method and body).
 */
export class BrowserHttp {
    readonly jar: CookieJar;
    readonly trace: Trace;
    readonly userAgent: string;
    readonly fetch: FetchLike;
    private readonly acceptLanguage: string;

    constructor(options: BrowserHttpOptions) {
        this.userAgent = options.userAgent;
        this.jar = options.jar ?? new CookieJar();
        this.fetch = options.fetch ?? defaultFetch;
        this.trace = new Trace(options.onTrace ?? null);
        this.acceptLanguage = options.acceptLanguage ?? "pl-PL,pl;q=0.9";
    }

    halt(step: string, reason: string): never {
        this.trace.record({ step, note: `HALT: ${reason}` });
        throw new FlowHalt(step, reason, this.trace.snapshot());
    }

    async request(step: string, input: string | URL, options: BrowserRequest = {}): Promise<BrowserResponse> {
        const maxHops = options.maxHops ?? 15;
        let url = new URL(input);
        let method = options.method ?? "GET";
        let body = options.body ?? null;

        for (let hops = 0; ; ) {
            const headers = new Headers({
                "User-Agent": this.userAgent,
                Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Language": this.acceptLanguage,
                ...options.headers,
            });
            const cookie = this.jar.headerFor(url);
            if (cookie) headers.set("Cookie", cookie);
            if (method === "POST" && !headers.has("Content-Type")) {
                headers.set("Content-Type", "application/x-www-form-urlencoded");
            }

            let response: Response;
            try {
                response = await this.fetch(url.href, {
                    method,
                    headers,
                    body: method === "POST" ? (body ?? "") : undefined,
                    redirect: "manual",
                });
            } catch (error) {
                const note = `network error: ${String((error as Error)?.message ?? error).slice(0, 120)}`;
                this.trace.record({ step, method, host: url.host, path: url.pathname, note });
                throw error;
            }

            const setCookies = getSetCookies(response);
            this.jar.storeFromResponse(url, setCookies);

            const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
            this.trace.record({
                step,
                method,
                host: url.host,
                path: url.pathname,
                status: response.status,
                contentType,
                cookies: setCookies.map((header) => header.split("=")[0]!.trim()),
                note: hops === 0 ? options.note : `hop ${hops}`,
            });

            if (!REDIRECT_STATUSES.includes(response.status) || options.follow === false) {
                return { response, url, text: await response.text(), hops, stoppedAt: null, contentType };
            }

            const location = response.headers.get("location");
            if (!location) this.halt(step, `redirect ${response.status} without Location`);

            const next = new URL(location, url);
            await response.body?.cancel();

            if (options.stopAt?.(next)) {
                this.trace.record({ step, host: next.host, path: next.pathname, note: "stopAt matched (not fetched)" });
                return { response, url, text: "", hops, stoppedAt: next, contentType };
            }

            if (++hops > maxHops) this.halt(step, `too many redirects (${maxHops})`);
            if (response.status !== 307 && response.status !== 308) {
                method = "GET";
                body = null;
            }
            url = next;
        }
    }

    async getJson<T = unknown>(step: string, url: string | URL, headers?: Record<string, string>) {
        const result = await this.request(step, url, {
            headers: { Accept: "application/json, text/plain, */*", ...headers },
        });

        return { data: this.parseJson<T>(step, result), result };
    }

    async postJson<T = unknown>(step: string, url: string | URL, payload: unknown, headers?: Record<string, string>) {
        const result = await this.request(step, url, {
            method: "POST",
            body: payload === undefined ? "" : JSON.stringify(payload),
            headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", ...headers },
        });

        return { data: this.parseJson<T>(step, result), result };
    }

    /**
     * Submits forms that need no user input (SAML auto-POST) and follows meta refreshes.
     * Stops at a non-HTML page, at a `stopAt` redirect, when `until` matches, or on a page
     * whose forms all need a decision — those are returned as `pending`.
     */
    async submitAutoForms(
        step: string,
        start: BrowserResponse,
        { stopAt, until, limit = 12 }: AutoSubmitOptions = {}
    ): Promise<{ response: BrowserResponse; pending: ParsedForm[] }> {
        let response = start;

        for (let i = 0; i < limit; i++) {
            if (response.stoppedAt || !isHtml(response) || until?.(response)) break;

            const forms = parseForms(response.text, response.url);
            const referer = response.url.href;

            if (!forms.length) {
                const refresh = parseMetaRefresh(response.text, response.url);
                if (!refresh) break;

                response = await this.request(step, refresh, { stopAt, headers: { Referer: referer } });
                continue;
            }

            const form = forms.find(isAutoSubmittable);
            if (!form) return { response, pending: forms };

            const payload = formPayload(form);
            this.trace.record({
                step,
                fields: [...new Set(payload.keys())],
                note: `submitting form → ${safeHost(form.action)}`,
            });

            response = await this.request(step, form.action, {
                method: form.method,
                body: form.method === "POST" ? payload : null,
                headers: { Origin: response.url.origin, Referer: referer },
                stopAt,
            });
        }

        return { response, pending: [] };
    }

    private parseJson<T>(step: string, result: BrowserResponse): T {
        try {
            return JSON.parse(result.text) as T;
        } catch {
            return this.halt(step, `expected JSON, got ${result.contentType || "?"} ${result.response.status}`);
        }
    }
}

export const isHtml = ({ contentType, text }: BrowserResponse) =>
    contentType.includes("html") || /^\s*<(!doctype|html)/i.test(text.slice(0, 200));

export const isHtmlForm = (response: BrowserResponse) => isHtml(response) && /<form\b/i.test(response.text);

export const safeHost = (url: string) => {
    try {
        return new URL(url).host;
    } catch {
        return "?";
    }
};

/** Shape of a JSON value (keys only) for halt messages. */
export const describeKeys = (value: unknown) => {
    if (Array.isArray(value)) return `[array ${value.length}]`;
    if (value && typeof value === "object") return Object.keys(value).slice(0, 20).join(",");

    return typeof value;
};
