import { describe, expect, it } from "vitest";
import { MessagesApi, assertReadable } from "../src/api/Messages.js";
import { Transport, buildQuery, filenameFromDisposition } from "../src/api/Transport.js";
import { ReceiptGuardError } from "../src/errors.js";
import type { FetchLike } from "../src/tools/BrowserHttp.js";
import type { Message } from "../src/types/Mailbox.js";

const ADE = "AE:PL-12345-67890-ABCDE-12";

const message = (opened: boolean | undefined, labels = ["INBOX"]): Message => ({
    messageControlData: { opened, labels: labels.map((label) => ({ label })) },
    messageMetadata: { messageId: "PPSA-1" },
});

const createApi = (fetch: FetchLike) =>
    new MessagesApi({
        transport: new Transport({ tokens: { accessToken: async () => "tok" }, userAgent: "test", fetch }),
        session: null,
        mailbox: () => ({ eDeliveryAddress: ADE, organizationEpuapId: "1" }),
    });

const recordingApi = () => {
    const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const api = createApi(async (url, init) => {
        calls.push({
            url,
            method: init?.method ?? "GET",
            body: init?.body,
            auth: new Headers(init?.headers).get("Authorization"),
        });

        return Response.json([{ messageMetadata: { messageId: "PPSA-1" } }]);
    });

    return { api, calls };
};

describe("assertReadable", () => {
    it("allows opened received messages and sent messages", () => {
        expect(assertReadable(message(true))).toBe("PPSA-1");
        expect(assertReadable(message(false, ["SENT"]))).toBe("PPSA-1");
    });

    it("blocks unopened, unknown and bare ids without acknowledgeReceipt", () => {
        expect(() => assertReadable(message(false))).toThrow(ReceiptGuardError);
        expect(() => assertReadable(message(undefined))).toThrow(ReceiptGuardError);
        expect(() => assertReadable("PPSA-1")).toThrow(ReceiptGuardError);
        expect(assertReadable("PPSA-1", { acknowledgeReceipt: true })).toBe("PPSA-1");
    });
});

describe("MessagesApi", () => {
    it("does not hit the network for a guarded open", async () => {
        const { api, calls } = recordingApi();

        await expect(api.get(message(false))).rejects.toThrow(ReceiptGuardError);
        expect(calls).toHaveLength(0);
    });

    it("opens with format=full and a bearer token", async () => {
        const { api, calls } = recordingApi();
        const opened = await api.get(message(true));

        expect(opened.messageMetadata?.messageId).toBe("PPSA-1");
        expect(calls[0]!.url).toBe(
            `https://edoreczenia.gov.pl/api/beuis/v2/${encodeURIComponent(ADE)}/messages/PPSA-1?format=full`
        );
        expect(calls[0]!.auth).toBe("Bearer tok");
    });

    it("lists with the official defaults", async () => {
        const { api, calls } = recordingApi();
        await api.list({ label: "sent" });
        const url = new URL(calls[0]!.url);

        expect(url.pathname).toBe("/api/beuis/v2/messages");
        expect(url.searchParams.get("label")).toBe("SENT");
        expect(url.searchParams.get("sortColumn")).toBe("submissionDate");
        expect(url.searchParams.get("massMessagesGrouped")).toBe("true");
        expect(JSON.parse(calls[0]!.body as string)).toEqual({ eDeliveryAddress: ADE, organizationEpuapID: "1" });
    });

    it("moves to trash with a labels patch", async () => {
        const { api, calls } = recordingApi();
        await api.moveToTrash(["a", "b"]);

        expect(calls[0]!.method).toBe("PATCH");
        expect(calls[0]!.url).toContain(`/${ADE}/messages/a%2Cb/message_control_data`);
        expect(JSON.parse(calls[0]!.body as string)).toEqual([{ op: "add", path: "labels", value: ["TRASH"] }]);
    });

    it("skips the guard for metadata and minimal formats", async () => {
        const { api, calls } = recordingApi();
        await api.get(message(false), { format: "metadata" });

        expect(new URL(calls[0]!.url).searchParams.get("format")).toBe("metadata");
        await expect(api.get(message(false), { format: "fullExtended" })).rejects.toThrow(ReceiptGuardError);
    });

    it("maps a 202 pending response and spec error arrays", async () => {
        const pending = createApi(async () => Response.json({ status: "PENDING" }, { status: 202 }));
        await expect(pending.get(message(true))).rejects.toMatchObject({ code: "pending:PENDING" });

        const failing = createApi(async () =>
            Response.json([{ error: "UAAPI0174", error_description: "too big" }], { status: 400 })
        );
        await expect(failing.taskStatus("x")).rejects.toMatchObject({ status: 400, code: "UAAPI0174" });
    });
});

describe("Transport helpers", () => {
    it("builds a query without empty values, with ISO dates", () => {
        expect(buildQuery({ a: 1, b: undefined, c: "", d: new Date("2026-01-02T00:00:00Z"), e: false })).toBe(
            "?a=1&d=2026-01-02T00%3A00%3A00.000Z&e=false"
        );
    });

    it("parses Content-Disposition", () => {
        expect(filenameFromDisposition(`attachment; filename="pismo.pdf"`)).toBe("pismo.pdf");
        expect(filenameFromDisposition(`attachment; filename*=UTF-8''pi%C5%9Bmo.pdf`)).toBe("piśmo.pdf");
    });
});
