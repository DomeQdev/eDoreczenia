/**
 * STOMP 1.2 over the SockJS websocket transport — the status channel of login.mobywatel.gov.pl.
 *
 * SockJS server messages: `o` (open), `h` (heartbeat), `a[...]` (JSON array of STOMP frames),
 * `c[code,"reason"]` (close). The client sends JSON arrays of STOMP frames as strings.
 */
export type StompFrame = {
    command: string;
    headers: Record<string, string>;
    body: string;
};

export type SockJsMessage =
    | { kind: "open" }
    | { kind: "heartbeat" }
    | { kind: "frames"; frames: StompFrame[] }
    | { kind: "close"; code: number; reason: string }
    | { kind: "unknown" };

export const encodeStomp = ({ command, headers, body }: StompFrame) => {
    const lines = [command, ...Object.entries(headers).map(([key, value]) => `${key}:${value}`)];

    return `${lines.join("\n")}\n\n${body}\u0000`;
};

/** Returns `null` for heartbeats. */
export const decodeStomp = (raw: string): StompFrame | null => {
    const text = raw.replace(/\u0000$/, "");
    if (!text.trim()) return null;

    const separator = text.indexOf("\n\n");
    const head = separator === -1 ? text : text.slice(0, separator);
    const [command = "", ...headerLines] = head.split("\n");

    const headers: Record<string, string> = {};
    for (const line of headerLines) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1);
    }

    return { command: command.trim(), headers, body: separator === -1 ? "" : text.slice(separator + 2) };
};

export const decodeSockJs = (data: string): SockJsMessage => {
    if (data === "o") return { kind: "open" };
    if (data === "h") return { kind: "heartbeat" };

    if (data.startsWith("a")) {
        const frames = (JSON.parse(data.slice(1)) as string[])
            .map(decodeStomp)
            .filter((frame): frame is StompFrame => frame !== null);

        return { kind: "frames", frames };
    }

    if (data.startsWith("c")) {
        const [code, reason] = JSON.parse(data.slice(1)) as [number, string];

        return { kind: "close", code, reason };
    }

    return { kind: "unknown" };
};

export const encodeSockJs = (frames: string[]) => JSON.stringify(frames);

export const STOMP = {
    connect: () =>
        encodeStomp({
            command: "CONNECT",
            headers: { "accept-version": "1.2,1.1,1.0", "heart-beat": "10000,10000" },
            body: "",
        }),
    subscribe: (destination: string, id = "sub-0") =>
        encodeStomp({ command: "SUBSCRIBE", headers: { id, destination }, body: "" }),
    disconnect: (receipt = `close-${Date.now()}`) =>
        encodeStomp({ command: "DISCONNECT", headers: { receipt }, body: "" }),
};

const SESSION_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random SockJS `serverId` (3 digits) and `sessionId` (8 characters). */
export const sockJsPath = () => {
    const serverId = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    const sessionId = Array.from(
        crypto.getRandomValues(new Uint8Array(8)),
        (byte) => SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length]
    ).join("");

    return { serverId, sessionId };
};

/**
 * The topic is the 8th `;`-separated field of the QR token, the same way the mObywatel
 * SPA derives it. Falls back to the first UUID in the token.
 */
export const topicFromQrToken = (token: string) => {
    const field = token.split(";")[7] || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(token)?.[0];

    return field ? `/topic/${field}` : null;
};
