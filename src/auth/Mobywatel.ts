import { HOSTS } from "../constants.js";
import { EdoError, QrExpiredError } from "../errors.js";
import { describeKeys, safeHost, type BrowserHttp } from "../tools/BrowserHttp.js";
import { STOMP, decodeSockJs, encodeSockJs, sockJsPath, topicFromQrToken } from "../tools/Stomp.js";

// The user authenticates in the mObywatel app; this module only waits for the outcome.

export const QR_TTL_MS = 5 * 60_000;
export const DEEPLINK_PREFIX = "mobywatel://app/institutions?qrCode=";

const STATUS_CHANNEL = `${HOSTS.mobywatel}/statuswebsocket`;

export type QrCode = {
    /** `;`-separated session token that binds the status channel. Do not log it. */
    token: string;
    /** `data:image/png;base64,…` */
    image: string;
    /** Opens the app on the same device. */
    deeplink: string;
    topic: string;
    /** Epoch ms. */
    expiresAt: number;
};

export type SamlConfirmation = {
    /** `login.gov.pl/login/SingleSignOnClientService` */
    action: string;
    samlart: string;
};

export type WebSocketConnector = (url: URL, headers: Headers) => Promise<WebSocket>;

export type WaitOptions = {
    signal?: AbortSignal;
    /** Defaults to the QR code's expiry. */
    timeoutMs?: number;
    connect?: WebSocketConnector;
    /** Reconnects after the channel drops. Default 5. */
    maxReconnects?: number;
};

type ListenOutcome =
    | { kind: "confirmed"; confirmation: SamlConfirmation }
    | { kind: "closed" }
    | { kind: "expired" }
    | { kind: "aborted" }
    | { kind: "error"; reason: string };

export const getQrCode = async (http: BrowserHttp): Promise<QrCode> => {
    const step = "mobywatel-qr";
    const { data } = await http.getJson<{ token?: unknown; value?: unknown }>(
        step,
        `${HOSTS.mobywatel}/api/login/auth/qr-code`,
        { Referer: `${HOSTS.mobywatel}/` }
    );

    if (typeof data?.token !== "string" || typeof data.value !== "string") {
        return http.halt(step, `qr-code JSON without token/value; keys: ${describeKeys(data)}`);
    }

    const { token, value: image } = data as { token: string; value: string };
    const topic = topicFromQrToken(token);
    if (!topic) http.halt(step, `qr-code token without topic field (len ${token.length})`);

    const imageKind = image.startsWith("data:image/") ? "data:image" : "text";
    http.trace.record({ step, note: `token ${token.split(";").length} fields, image ${imageKind}` });

    return { token, image, deeplink: DEEPLINK_PREFIX + token, topic, expiresAt: Date.now() + QR_TTL_MS };
};

type WebSocketWithHeaders = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/**
 * The status channel only works with the `sessionKey` and load balancer cookies, so the socket
 * has to be opened with custom headers. The global `WebSocket` of Node.js (undici) and Bun accepts
 * them as a non-standard second argument; elsewhere pass your own `connect`.
 */
export const defaultWebSocketConnector: WebSocketConnector = (url, headers) =>
    new Promise((resolve, reject) => {
        const webSocket = new (WebSocket as unknown as WebSocketWithHeaders)(url.href, {
            headers: Object.fromEntries(headers),
        });

        webSocket.addEventListener("open", () => resolve(webSocket), { once: true });
        webSocket.addEventListener("error", () => reject(new EdoError("status channel connection failed")), {
            once: true,
        });
    });

/** Waits on the SockJS + STOMP status channel for the user's confirmation. */
export const waitForConfirmation = async (
    http: BrowserHttp,
    qr: Pick<QrCode, "topic" | "expiresAt">,
    { signal, timeoutMs, connect = defaultWebSocketConnector, maxReconnects = 5 }: WaitOptions = {}
): Promise<SamlConfirmation> => {
    const step = "mobywatel-stomp";
    const deadline = Date.now() + (timeoutMs ?? Math.max(1000, qr.expiresAt - Date.now()));

    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new QrExpiredError();

        const info = await http.request(step, `${STATUS_CHANNEL}/info?t=${Date.now()}`, {
            headers: { Accept: "*/*", Referer: `${HOSTS.mobywatel}/` },
        });
        if (!info.response.ok) http.halt(step, `sockjs info → ${info.response.status}`);

        const { serverId, sessionId } = sockJsPath();
        const url = new URL(`${STATUS_CHANNEL}/${serverId}/${sessionId}/websocket`);
        const headers = new Headers({ Origin: HOSTS.mobywatel, "User-Agent": http.userAgent });
        const cookie = http.jar.headerFor(url);
        if (cookie) headers.set("Cookie", cookie);

        const webSocket = await connect(url, headers);
        http.trace.record({
            step,
            host: url.host,
            path: "/statuswebsocket/<id>/<id>/websocket",
            note: `connected (attempt ${attempt + 1}); cookies: ${http.jar.describe(url).join(",") || "none"}`,
        });

        const outcome = await listen(webSocket, qr.topic, deadline, signal, (note) => http.trace.record({ step, note }));
        switch (outcome.kind) {
            case "confirmed":
                return outcome.confirmation;
            case "expired":
                throw new QrExpiredError();
            case "aborted":
                signal?.throwIfAborted();
                throw new EdoError("cancelled");
            case "error":
                throw new EdoError(outcome.reason);
        }

        if (attempt >= maxReconnects) {
            throw new EdoError(`status channel closed ${attempt + 1}× without confirmation`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

const listen = (
    webSocket: WebSocket,
    topic: string,
    deadline: number,
    signal: AbortSignal | undefined,
    note: (text: string) => void
) =>
    new Promise<ListenOutcome>((resolve) => {
        let settled = false;

        const finish = (outcome: ListenOutcome) => {
            if (settled) return;
            settled = true;

            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            // Either call throws when the socket is already closed.
            try {
                webSocket.send(encodeSockJs([STOMP.disconnect()]));
            } catch {}
            try {
                webSocket.close(1000, "done");
            } catch {}

            resolve(outcome);
        };

        const timer = setTimeout(() => finish({ kind: "expired" }), Math.max(0, deadline - Date.now()));
        const onAbort = () => finish({ kind: "aborted" });
        signal?.addEventListener("abort", onAbort);

        webSocket.addEventListener("message", (event) => {
            const message = decodeSockJs(typeof event.data === "string" ? event.data : "");

            if (message.kind === "open") {
                webSocket.send(encodeSockJs([STOMP.connect()]));
            } else if (message.kind === "close") {
                note(`sockjs close ${message.code}`);
                finish({ kind: "closed" });
            } else if (message.kind === "frames") {
                for (const frame of message.frames) {
                    if (frame.command === "CONNECTED") {
                        webSocket.send(encodeSockJs([STOMP.subscribe(topic)]));
                        note(`STOMP CONNECTED v${frame.headers.version ?? "?"}, subscribed`);
                    } else if (frame.command === "ERROR") {
                        return finish({ kind: "error", reason: `STOMP ERROR: ${(frame.headers.message ?? "").slice(0, 100)}` });
                    } else if (frame.command === "MESSAGE") {
                        let body: { action?: unknown; samlart?: unknown } | null = null;
                        try {
                            body = JSON.parse(frame.body);
                        } catch {
                            // Reported below as a message without action/samlart.
                        }

                        if (typeof body?.action === "string" && typeof body.samlart === "string") {
                            note(`confirmed: action host ${safeHost(body.action)}`);
                            return finish({ kind: "confirmed", confirmation: { action: body.action, samlart: body.samlart } });
                        }
                        note(`MESSAGE without action/samlart; keys: ${describeKeys(body)}`);
                    }
                }
            }
        });
        webSocket.addEventListener("close", () => finish({ kind: "closed" }));
        webSocket.addEventListener("error", () => finish({ kind: "closed" }));
    });

/**
 * Hands the SAML artifact back to login.gov.pl as a form with a single `SAMLart` field
 * (case-sensitive), with login.mobywatel.gov.pl as the referer.
 */
export const submitArtifact = (http: BrowserHttp, { action, samlart }: SamlConfirmation, stopAt?: (url: URL) => boolean) =>
    http.request("saml-artifact", action, {
        method: "POST",
        body: new URLSearchParams({ SAMLart: samlart }),
        headers: { Origin: HOSTS.mobywatel, Referer: `${HOSTS.mobywatel}/`, "Upgrade-Insecure-Requests": "1" },
        stopAt,
    });
