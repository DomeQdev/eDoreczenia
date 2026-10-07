import { API } from "../constants.js";
import { EdoError } from "../errors.js";
import { mimeTypeFor, toBlob, validateUpload } from "../tools/Files.js";
import type {
    AttachmentSignRequest,
    AttachmentVerification,
    DraftAttachmentRef,
    DraftBody,
    Message,
    MessageIdResponse,
    MessageList,
    Party,
    SendResult,
    SendSignedResponse,
    ShippingService,
    SignRedirect,
    UploadFile,
} from "../types/Mailbox.js";
import { idsSegment, type ApiContext } from "./Transport.js";

/*
 * Sending follows the official client: create a draft, upload attachments (multipart), PUT
 * the full content, then `POST /drafts/send`. The signed variant replaces the last step with
 * `POST /drafts/sign`, signing on pz.gov.pl and `POST /{uuid}/drafts/sendSigned`.
 */

export type DraftListQuery = {
    offset?: number;
    limit?: number;
    format?: string;
    recipient?: string;
    subject?: string;
    attachments?: boolean;
    label?: string;
    shippingService?: ShippingService;
    sortColumn?: string;
    sortDirection?: "asc" | "desc";
};

export type ComposeInput = {
    to: (string | Party)[];
    subject: string;
    text: string;
    attachments?: UploadFile[];
    /** For replies: the original's thread. */
    threadId?: string;
    /** For replies: the original's case. */
    caseId?: string;
    /** Defaults to the mailbox address itself. */
    from?: Party;
    massMessage?: boolean;
};

type SignAttachmentInput = Omit<AttachmentSignRequest, "edeliveryAddress" | "service"> & Partial<AttachmentSignRequest>;

export class DraftsApi {
    constructor(private readonly context: ApiContext) {}

    private get transport() {
        return this.context.transport;
    }

    private get address() {
        return this.context.mailbox().eDeliveryAddress;
    }

    private get base() {
        return `${API.beuis}/${this.address}/drafts`;
    }

    list(query: DraftListQuery = {}) {
        return this.transport.json<MessageList>({ op: "draftsList", url: this.base, query });
    }

    get(draftId: string, format?: string) {
        return this.transport.json<Message>({
            op: "draftGet",
            url: `${this.base}/${encodeURIComponent(draftId)}`,
            query: { format },
        });
    }

    create(body: DraftBody) {
        return this.transport.json<MessageIdResponse>({ op: "draftCreate", method: "POST", url: this.base, body });
    }

    /** The official client also uses this PUT for partial changes, e.g. attachment order. */
    update(draftId: string, body: DraftBody) {
        return this.transport.json<MessageIdResponse>({
            op: "draftUpdate",
            method: "PUT",
            url: `${this.base}/${encodeURIComponent(draftId)}`,
            body,
        });
    }

    delete(draftIds: string | string[]) {
        return this.transport.json<unknown>({
            op: "draftDelete",
            method: "DELETE",
            url: `${this.base}/${idsSegment(draftIds)}`,
        });
    }

    addAttachment(draftId: string, file: UploadFile, description = "") {
        const form = new FormData();
        form.append("fileId", crypto.randomUUID());
        form.append("filename", file.filename);
        form.append("contentType", file.contentType ?? mimeTypeFor(file.filename));
        form.append("alg", "");
        form.append("description", description);
        form.append("file", toBlob(file), file.filename);

        return this.transport.json<{ attachmentId: string }>({
            op: "draftAttachmentAdd",
            method: "POST",
            url: `${this.base}/${encodeURIComponent(draftId)}/attachments`,
            body: form,
        });
    }

    /** Uploads through UA API v3, which the official client uses when forwarding. */
    addAttachmentViaUaApi(draftId: string, file: UploadFile, description = "") {
        const blob = toBlob(file);
        const form = new FormData();
        form.append("filename", file.filename);
        form.append("contentType", file.contentType ?? mimeTypeFor(file.filename));
        form.append("size", String(blob.size));
        form.append("alg", "SHA-3");
        form.append("description", description);
        form.append("file", blob, file.filename);

        return this.transport.json<{ attachmentId: string; fileMetadata?: { filename?: string } }>({
            op: "draftAttachmentUpload",
            method: "POST",
            url: `${API.uaapi}/${this.address}/${encodeURIComponent(draftId)}/attachments/upload`,
            body: form,
        });
    }

    getAttachment(draftId: string, attachmentId: string) {
        return this.transport.file({
            op: "draftAttachmentGet",
            url: `${this.base}/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
        });
    }

    deleteAttachment(draftId: string, attachmentId: string) {
        return this.transport.json<unknown>({
            op: "draftAttachmentDelete",
            method: "DELETE",
            url: `${this.base}/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
        });
    }

    deleteAllAttachments(draftId: string) {
        return this.transport.json<unknown>({
            op: "draftAttachmentsDelete",
            method: "DELETE",
            url: `${this.base}/${encodeURIComponent(draftId)}/attachments`,
        });
    }

    /** Sends without a signature. Per-recipient outcome: `messages.waitForTask(messageTaskId)`. */
    send(draftId: string) {
        return this.transport.json<SendResult>({
            op: "draftSend",
            method: "POST",
            url: `${this.base}/send`,
            body: { messageId: draftId },
        });
    }

    /**
     * Starts signing with Podpis Zaufany. The user opens `url`; afterwards pz.gov.pl redirects to
     * `callbackUrl?ACTION=signMessage&status=SUCCESS`, and `sendSigned(uuid)` finishes sending.
     */
    sign(draftId: string, callbackUrl: string) {
        return this.transport.json<SignRedirect>({
            op: "draftSign",
            method: "POST",
            url: `${this.base}/sign`,
            body: { messageId: draftId, callbackUrl },
        });
    }

    /** The path holds the signing uuid instead of the address. Sends one message per recipient. */
    sendSigned(signUuid: string) {
        return this.transport.json<SendSignedResponse>({
            op: "draftSendSigned",
            method: "POST",
            url: `${API.beuis}/${signUuid}/drafts/sendSigned`,
        });
    }

    /** Starts signing an attachment; after the user signs, call `attachmentSigned(uuidDocument)`. */
    signAttachment(request: SignAttachmentInput) {
        return this.transport.json<{ uuidDocument: string; signUrl: string }>({
            op: "attachmentSign",
            method: "POST",
            url: `${API.beuis}/attachments/sign`,
            body: { edeliveryAddress: this.address, service: "eDelivery", ...request } satisfies AttachmentSignRequest,
        });
    }

    /** Puts the signed file into the draft and returns its new `attachmentId`. */
    attachmentSigned(uuidDocument: string) {
        return this.transport.json<{ attachmentId: string }>({
            op: "attachmentSigned",
            method: "POST",
            url: `${API.beuis}/attachments/signed`,
            body: { uuId: uuidDocument },
        });
    }

    /** Verifies signatures of a .pdf or .xml attachment up to 15 MB. An empty array means unsigned. */
    verifyAttachment(request: Omit<SignAttachmentInput, "callbackUrl">) {
        return this.transport.json<AttachmentVerification[]>({
            op: "attachmentVerify",
            method: "POST",
            url: `${API.beuis}/attachments/verify`,
            body: { edeliveryAddress: this.address, service: "eDelivery", ...request },
        });
    }

    buildBody(input: ComposeInput, attachments: DraftAttachmentRef[] = []): DraftBody {
        return {
            ...(input.massMessage && { messageControlData: { massMessage: true } }),
            messageMetadata: {
                timestamp: new Date().toISOString(),
                subject: input.subject,
                from: input.from ?? { eDeliveryAddress: this.address },
                to: input.to.map((recipient) =>
                    typeof recipient === "string" ? { eDeliveryAddress: recipient } : recipient
                ),
                shippingService: "electronic",
                ...(input.threadId && { threadId: input.threadId }),
                ...(input.caseId && { caseId: input.caseId }),
            },
            textBody: input.text,
            ...(attachments.length && { attachments }),
        };
    }

    /** Creates a draft ready to `send(draftId)` or `sign(draftId, callbackUrl)`. */
    async compose(input: ComposeInput) {
        const problems = validateUpload(input.attachments ?? [], { service: "eDelivery", mass: input.massMessage });
        if (problems.length) throw new EdoError(`attachments invalid: ${problems.join("; ")}`);

        const { messageId: draftId } = await this.create({
            messageMetadata: {
                timestamp: new Date().toISOString(),
                subject: "",
                from: { eDeliveryAddress: this.address },
                to: [{ eDeliveryAddress: "" }],
                shippingService: "electronic",
            },
            textBody: "",
        });

        const attachments: DraftAttachmentRef[] = [];
        for (const [order, file] of (input.attachments ?? []).entries()) {
            const { attachmentId } = await this.addAttachment(draftId, file);
            attachments.push({ attachmentId, order });
        }

        await this.update(draftId, this.buildBody(input, attachments));

        return { draftId, attachments };
    }

    async composeAndSend(input: ComposeInput) {
        const { draftId } = await this.compose(input);

        return { draftId, result: await this.send(draftId) };
    }

    /** Reply input: addressed to the original sender, same thread and case, `RE: ` subject. */
    replyTo(
        original: Message,
        input: Omit<ComposeInput, "to" | "subject" | "threadId" | "caseId"> & { subject?: string }
    ): ComposeInput {
        const { from, subject: originalSubject, threadId, caseId } = original.messageMetadata ?? {};
        const subject = input.subject ?? `RE: ${originalSubject ?? ""}`;

        return {
            ...input,
            to: from
                ? [{ eDeliveryAddress: from.eDeliveryAddress, ...(from.contributor && { contributor: from.contributor }) }]
                : [],
            subject: subject.length > 255 ? `${subject.slice(0, 252)}...` : subject,
            threadId,
            caseId,
        };
    }

    async attachments(draftId: string) {
        return (await this.get(draftId)).attachments ?? [];
    }
}
