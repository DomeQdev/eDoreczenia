import { describe, expect, it } from "vitest";
import { STOMP, decodeSockJs, decodeStomp, encodeSockJs, encodeStomp, sockJsPath, topicFromQrToken } from "../src/tools/Stomp.js";

describe("Stomp", () => {
    it("encodes CONNECT", () => {
        const frame = STOMP.connect();

        expect(frame.startsWith("CONNECT\naccept-version:1.2,1.1,1.0\nheart-beat:10000,10000\n\n")).toBe(true);
        expect(frame.endsWith("\u0000")).toBe(true);
    });

    it("round-trips a frame", () => {
        const raw = encodeStomp({
            command: "MESSAGE",
            headers: { destination: "/topic/x", "content-type": "application/json" },
            body: '{"a":1}',
        });
        const frame = decodeStomp(raw)!;

        expect(frame.command).toBe("MESSAGE");
        expect(frame.headers.destination).toBe("/topic/x");
        expect(JSON.parse(frame.body)).toEqual({ a: 1 });
    });

    it("decodes SockJS messages", () => {
        const connected = encodeSockJs([encodeStomp({ command: "CONNECTED", headers: { version: "1.2" }, body: "" })]);
        const message = decodeSockJs(`a${connected}`);

        expect(message.kind).toBe("frames");
        if (message.kind === "frames") expect(message.frames[0]!.command).toBe("CONNECTED");
        expect(decodeSockJs("o").kind).toBe("open");
        expect(decodeSockJs("h").kind).toBe("heartbeat");
        expect(decodeSockJs('c[3000,"Go away!"]')).toEqual({ kind: "close", code: 3000, reason: "Go away!" });
    });

    it("generates SockJS path segments", () => {
        const { serverId, sessionId } = sockJsPath();

        expect(serverId).toMatch(/^\d{3}$/);
        expect(sessionId).toMatch(/^[a-z0-9]{8}$/);
    });

    it("derives the topic from the QR token", () => {
        expect(topicFromQrToken("a;b;c;d;e;f;g;topic-id;i")).toBe("/topic/topic-id");
        expect(topicFromQrToken("x 0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(
            "/topic/0f8fad5b-d9cb-469f-a165-70867728950e"
        );
        expect(topicFromQrToken("nothing")).toBeNull();
    });
});
