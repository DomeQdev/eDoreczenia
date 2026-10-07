import { describe, expect, it } from "vitest";
import { EdoClient } from "../src/EdoClient.js";

const ADE = "AE:PL-12345-67890-ABCDE-12";

const createClient = () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body });

        if (url.endsWith("/drafts") && init?.method === "POST") return Response.json({ messageId: "D1" });
        if (url.endsWith("/drafts/D1/attachments")) return Response.json({ attachmentId: `A${calls.length}` });
        if (url.endsWith("/drafts/D1")) return Response.json({ messageId: "D1" });

        return new Response(null, { status: 204 });
    };

    const edo = new EdoClient({
        tokens: { accessToken: async () => "tok" },
        mailbox: { eDeliveryAddress: ADE, organizationEpuapId: "1" },
        fetch,
    });

    return { edo, calls };
};

describe("EdoClient drafts", () => {
    it("sends like the official client: draft, attachments, PUT, send", async () => {
        const { edo, calls } = createClient();
        await edo.drafts.composeAndSend({
            to: ["AE:PL-00000-00000-AAAAA-00"],
            subject: "Wniosek",
            text: "Treść",
            attachments: [{ filename: "wniosek.pdf", data: new Uint8Array([37, 80, 68, 70]) }],
        });

        expect(calls.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
            `POST /api/beuis/v2/${ADE}/drafts`,
            `POST /api/beuis/v2/${ADE}/drafts/D1/attachments`,
            `PUT /api/beuis/v2/${ADE}/drafts/D1`,
            `POST /api/beuis/v2/${ADE}/drafts/send`,
        ]);

        const form = calls[1]!.body as FormData;
        expect([...form.keys()]).toEqual(["fileId", "filename", "contentType", "alg", "description", "file"]);
        expect(form.get("contentType")).toBe("application/pdf");

        const put = JSON.parse(calls[2]!.body as string);
        expect(put.messageMetadata.to).toEqual([{ eDeliveryAddress: "AE:PL-00000-00000-AAAAA-00" }]);
        expect(put.attachments).toEqual([{ attachmentId: "A2", order: 0 }]);
        expect(JSON.parse(calls[3]!.body as string)).toEqual({ messageId: "D1" });
    });

    it("rejects filenames the official form rejects", async () => {
        const { edo } = createClient();
        const attachments = [{ filename: "z spacją.pdf", data: new Uint8Array(1) }];

        await expect(edo.drafts.compose({ to: ["x"], subject: "s", text: "t", attachments })).rejects.toThrow(/forbidden/);
    });
});
