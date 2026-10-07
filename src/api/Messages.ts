import { API } from "../constants.js";
import { ApiError, ReceiptGuardError } from "../errors.js";
import type {
    ArchiveTask,
    ArchiveTaskChange,
    ArchiveTaskList,
    ControlDataPatch,
    Evidence,
    EvidenceList,
    EvidenceType,
    FileResult,
    Folder,
    Message,
    MessageList,
    MessagePending,
    MessageTaskResult,
    MessageTaskStatus,
    SendResult,
    Service,
    ShippingService,
    SortDirection,
    ThreadDetails,
    ThreadList,
} from "../types/Mailbox.js";
import { idsSegment, type ApiContext } from "./Transport.js";

/*
 * Opening a message means `GET /{ADE}/messages/{id}` in a `full` format — the spec defines
 * reading as exactly that, and the official mailbox has no separate "mark as read". For a
 * received, unopened message this confirms delivery, with legal effect. Every call that can do
 * it goes through `assertReadable`: without `acknowledgeReceipt: true` it only accepts list
 * items that are already opened or sent. Listing (`format=metadata`) has no side effects.
 */

export type MessageFormat = "full" | "fullExtended" | "metadata" | "minimal";

export type MessageListQuery = {
    label?: string;
    offset?: number;
    limit?: number;
    format?: "metadata";
    sortColumn?: "subject" | "sender" | "recipient" | "submissionDate" | "receiptDate" | "eventDate" | "timestamp";
    sortDirection?: SortDirection;
    massMessagesGrouped?: boolean;
    massMessageId?: string;
    /** The official UI searches from 3 characters. */
    sender?: string;
    recipient?: string;
    subject?: string;
    submissionDateFrom?: Date | string;
    submissionDateTo?: Date | string;
    receiptDateFrom?: Date | string;
    receiptDateTo?: Date | string;
    eventDateFrom?: Date | string;
    eventDateTo?: Date | string;
    attachments?: boolean;
    opened?: boolean;
    shippingService?: ShippingService;
    service?: Service;
};

export type ThreadQuery = {
    sender?: string;
    recipient?: string;
    caseId?: string;
    offset?: number;
    limit?: number;
    submissionDateFrom?: Date | string;
    submissionDateTo?: Date | string;
    eventDateFrom?: Date | string;
    eventDateTo?: Date | string;
    messageTitle?: string;
    sortDirection?: SortDirection;
    sortColumn?: "lastMessageSubmissionDate" | "subject" | "sender";
    service?: Service;
};

export type EvidenceQuery = {
    type?: EvidenceType;
    /** Only downloaded, or only not yet downloaded evidences. */
    downloaded?: boolean;
    sortColumn?: "eventDate";
    sortDirection?: SortDirection;
};

export type ArchiveTaskQuery = {
    offset?: number;
    limit?: number;
    sortDirection?: SortDirection;
    taskId?: string;
    sortColumn?: "creationDate" | "dateForDownload";
};

export type ReadOptions = {
    /**
     * Open the message even if it may not have been received yet. This confirms delivery
     * (UPO/UPD) with the date of this call.
     */
    acknowledgeReceipt?: boolean;
};

/** A list item (preferred — the guard can see `opened`) or a bare message id. */
export type MessageRef = Message | string;

export const labelsOf = (message: Message) =>
    (message.messageControlData?.labels ?? [])
        .flatMap((label) => (typeof label === "string" ? [label] : [label.label, label.messageLocation]))
        .filter((label): label is string => !!label)
        .map((label) => label.toUpperCase());

export const messageIdOf = (ref: MessageRef) => {
    const id = typeof ref === "string" ? ref : ref.messageMetadata?.messageId;
    if (!id) throw new ReceiptGuardError("no messageId");

    return id;
};

/** ePUAP messages have numeric ids; e-Delivery ones look like `PPSA-…`. */
export const isEpuapMessage = (ref: MessageRef) =>
    (typeof ref !== "string" && ref.messageMetadata?.service === "ePUAP") || /^[0-9]{1,15}$/.test(messageIdOf(ref));

/** The single place that decides whether reading content is safe, i.e. cannot confirm delivery. */
export const assertReadable = (ref: MessageRef, { acknowledgeReceipt }: ReadOptions = {}) => {
    const id = messageIdOf(ref);
    if (acknowledgeReceipt) return id;

    if (typeof ref === "string") {
        throw new ReceiptGuardError("message state unknown (pass the list item, or acknowledgeReceipt: true)");
    }
    if (labelsOf(ref).includes("SENT") || ref.messageControlData?.opened === true) return id;

    throw new ReceiptGuardError("message not opened yet — opening acknowledges receipt (pass acknowledgeReceipt: true)");
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MessagesApi {
    constructor(
        private readonly context: ApiContext,
        private readonly defaultService: Service = "All"
    ) {}

    private get transport() {
        return this.context.transport;
    }

    private get address() {
        return this.context.mailbox().eDeliveryAddress;
    }

    private get base() {
        return `${API.beuis}/${this.address}`;
    }

    /**
     * Message list (metadata only, no side effects). Defaults follow the official mailbox:
     * INBOX by `receiptDate`, SENT by `submissionDate` with mass messages grouped.
     */
    list(query: MessageListQuery = {}) {
        const { eDeliveryAddress, organizationEpuapId } = this.context.mailbox();
        const label = (query.label ?? "INBOX").toUpperCase();
        const groupedByDefault = !(label === "INBOX" || label === "TRASH" || query.massMessageId);

        return this.transport.json<MessageList>({
            op: "messagesList",
            method: "POST",
            url: `${API.beuis}/messages`,
            query: {
                offset: 0,
                limit: 20,
                format: "metadata",
                massMessagesGrouped: groupedByDefault ? true : undefined,
                ...query,
                label,
                sortColumn: query.sortColumn ?? (label === "SENT" ? "submissionDate" : "receiptDate"),
                sortDirection: query.sortDirection ?? "desc",
                service: query.service ?? this.defaultService,
            },
            body: { eDeliveryAddress, organizationEpuapID: organizationEpuapId },
        });
    }

    /** Walks through all pages of the list. */
    async *iterate({ maxItems, ...query }: Omit<MessageListQuery, "offset"> & { maxItems?: number } = {}) {
        const limit = query.limit ?? 20;
        let offset = 0;
        let yielded = 0;

        while (true) {
            const page = await this.list({ ...query, offset, limit });
            const messages = page.messages ?? [];

            for (const message of messages) {
                yield message;
                if (maxItems && ++yielded >= maxItems) return;
            }

            offset += messages.length;
            if (messages.length < limit || (page.total !== undefined && offset >= page.total)) return;
        }
    }

    /** Predefined and custom folders with counters. */
    folders(service: Service = this.defaultService) {
        const { eDeliveryAddress, organizationEpuapId } = this.context.mailbox();

        return this.transport.json<Folder[]>({
            op: "numberMessages",
            method: "POST",
            url: `${API.beuis}/numberMessages`,
            query: { service },
            body: { eDeliveryAddress, organizationEpuapId },
        });
    }

    threads(query: ThreadQuery = {}) {
        const { eDeliveryAddress, organizationEpuapId } = this.context.mailbox();

        return this.transport.json<ThreadList>({
            op: "threadsList",
            method: "POST",
            url: `${API.beuis}/threads`,
            query: {
                sortColumn: "lastMessageSubmissionDate",
                sortDirection: "desc",
                ...query,
                service: query.service ?? this.defaultService,
            },
            body: { eDeliveryAddress, organizationEpuapId },
        });
    }

    /** Messages of a thread (metadata). */
    thread(threadId: string, query: ThreadQuery = {}) {
        const { eDeliveryAddress, organizationEpuapId } = this.context.mailbox();

        return this.transport.json<ThreadDetails>({
            op: "threadGet",
            method: "POST",
            url: `${API.beuis}/threads/${encodeURIComponent(threadId)}`,
            query: { ...query, service: query.service ?? this.defaultService },
            body: { eDeliveryAddress, organizationEpuapId },
        });
    }

    /**
     * A single message. `full` (default) includes the text and the attachment list, `fullExtended`
     * also the attachment contents — both open the message and go through the receipt guard.
     * `metadata` and `minimal` are not reads and skip the guard.
     */
    async get(ref: MessageRef, { format = "full", ...options }: ReadOptions & { format?: MessageFormat } = {}) {
        const id = format === "full" || format === "fullExtended" ? assertReadable(ref, options) : messageIdOf(ref);
        const [message] = await this.getMany([id], format);
        if (!message) throw new ApiError("messageGet", 200, "empty");

        return message;
    }

    /**
     * Up to 50 messages at once, WITHOUT the receipt guard — `full` formats open all of them.
     * A message still being prepared (HTTP 202) throws an `ApiError` with code `pending:<status>`.
     */
    async getMany(messageIds: string[], format: MessageFormat = "metadata"): Promise<Message[]> {
        const data = await this.transport.json<Message[] | Message | MessagePending | undefined>({
            op: "messageGet",
            // The address is encoded only here, as the official client does.
            url: `${API.beuis}/${encodeURIComponent(this.address)}/messages/${idsSegment(messageIds)}`,
            query: { format },
        });

        if (Array.isArray(data)) return data;

        const pendingStatus = data?.status;
        if (typeof pendingStatus === "string") throw new ApiError("messageGet", 202, `pending:${pendingStatus}`);

        return data ? [data as Message] : [];
    }

    /** Attachment file through UA API v3, as the official UI downloads it. */
    downloadAttachment(ref: MessageRef, attachmentId: string, options: ReadOptions = {}) {
        const messageId = assertReadable(ref, options);

        return this.transport.file({
            op: "attachmentDownload",
            method: "POST",
            url: `${API.uaapi}/${this.address}/attachments/download`,
            body: { attachmentId, messageId },
        });
    }

    /** Attachment file through beuis. */
    getAttachment(ref: MessageRef, attachmentId: string, options: ReadOptions = {}) {
        const id = assertReadable(ref, options);

        return this.transport.file({
            op: "attachmentGet",
            url: `${this.base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
        });
    }

    /** HTML rendering of an attachment. Works for drafts too (pass the draft id). */
    attachmentVisualization(ref: MessageRef, attachmentId: string, options: ReadOptions = {}) {
        const id = assertReadable(ref, options);

        return this.transport.file({
            op: "attachmentVisualization",
            url: `${this.base}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/visualization`,
        });
    }

    /** The whole message as a ZIP — text, attachments and evidences. */
    downloadArchive(ref: MessageRef, options: ReadOptions = {}) {
        const id = assertReadable(ref, options);

        return this.transport.file({
            op: "messageArchiveFile",
            url: `${this.base}/messages/${encodeURIComponent(id)}/message-archive-file`,
            accept: "application/zip,application/json",
        });
    }

    /** Evidence file: `purde` for electronic, `puh` for hybrid. `BP.*P` types are PDFs, `BP.*X` XML. */
    downloadEvidence(evidence: Pick<Evidence, "evidenceId"> | string, kind: "purde" | "puh" = "purde") {
        const id = typeof evidence === "string" ? evidence : evidence.evidenceId!;

        return this.transport.file({
            op: "evidenceGet",
            url: `${this.base}/evidences/${kind}/${encodeURIComponent(id)}`,
        });
    }

    /** Proof of receipt of a hybrid shipment (`H.EPO`). */
    downloadHybridReceipt(messageId: string) {
        return this.transport.file({
            op: "evidencePuhEpo",
            url: `${this.base}/evidences/puhepo/messageId/${encodeURIComponent(messageId)}`,
        });
    }

    /** All technical evidences of a message, as a ZIP. */
    downloadTechnicalEvidences(messageId: string) {
        return this.transport.file({
            op: "technicalEvidences",
            url: `${this.base}/evidences/${encodeURIComponent(messageId)}/technical-evidences-file`,
            accept: "application/zip,application/json",
        });
    }

    /** Evidences of every message still in the mailbox. `downloaded: false` makes syncing easy. */
    evidences(query: EvidenceQuery = {}) {
        return this.transport.json<EvidenceList>({
            op: "evidencesList",
            url: `${this.base}/messages/evidences`,
            query,
        });
    }

    evidence(evidenceId: string) {
        return this.transport.json<Evidence[]>({
            op: "evidenceMeta",
            url: `${this.base}/messages/evidences/${encodeURIComponent(evidenceId)}`,
        });
    }

    /** Evidences of one message; does not read its content. */
    messageEvidences(messageId: string, query: EvidenceQuery = {}) {
        return this.transport.json<EvidenceList>({
            op: "messageEvidences",
            url: `${this.base}/messages/${encodeURIComponent(messageId)}/evidences`,
            query,
        });
    }

    /** Send task outcome per recipient: a `messageId` or an error. */
    task(messageTaskId: string) {
        return this.transport.json<MessageTaskResult[]>({
            op: "messageTask",
            url: `${this.base}/messages/tasks/${encodeURIComponent(messageTaskId)}`,
        });
    }

    taskStatus(messageTaskId: string) {
        return this.transport.json<MessageTaskStatus>({
            op: "messageTaskStatus",
            url: `${this.base}/messages/tasks/${encodeURIComponent(messageTaskId)}/status`,
        });
    }

    /** Polls a send task until it finishes, then returns its outcome. */
    async waitForTask(messageTaskId: string, { intervalMs = 2000, timeoutMs = 120_000 } = {}) {
        const deadline = Date.now() + timeoutMs;

        while (true) {
            const { messageTaskStatus } = await this.taskStatus(messageTaskId);
            if (messageTaskStatus === "FINISHED") return this.task(messageTaskId);
            if (Date.now() > deadline) throw new ApiError("messageTaskStatus", 200, "timeout");

            await delay(intervalMs);
        }
    }

    /** Label operations in JSON Patch style. */
    patchLabels(messageIds: string | string[], patch: ControlDataPatch) {
        return this.transport.json<{ labels?: { label?: string; messageLocation?: string }[] }[]>({
            op: "messageControlData",
            method: "PATCH",
            url: `${this.base}/messages/${idsSegment(messageIds)}/message_control_data`,
            body: patch,
        });
    }

    moveToTrash(messageIds: string | string[]) {
        return this.patchLabels(messageIds, [{ op: "add", path: "labels", value: ["TRASH"] }]);
    }

    restoreFromTrash(messageIds: string | string[]) {
        return this.patchLabels(messageIds, [{ op: "remove", path: "labels", value: ["TRASH"] }]);
    }

    move(messageIds: string | string[], folderLabel: string) {
        return this.patchLabels(messageIds, [{ op: "add", path: "labels", value: [folderLabel] }]);
    }

    /** The official mailbox only allows this from the trash. */
    deletePermanently(messageIds: string | string[]) {
        return this.transport.json<unknown[]>({
            op: "messageDelete",
            method: "DELETE",
            url: `${this.base}/messages/${idsSegment(messageIds)}`,
        });
    }

    /**
     * Sends a message directly, as defined by the spec. The official web mailbox never does this —
     * it sends through drafts (`drafts.composeAndSend`) — so beuis support is unverified.
     * Attachments go in `attachments[].file = { fileMetadata, file }` with base64 content.
     */
    send(message: Message) {
        return this.transport.json<SendResult>({
            op: "messageSend",
            method: "POST",
            url: `${this.base}/messages`,
            body: message,
        });
    }

    /**
     * Folders as defined by the spec. The official UI creates them through the permissions API
     * instead (`permissions.createDirectory`), which also sets role access.
     */
    directories() {
        return this.transport.json<Folder[]>({ op: "directoriesList", url: `${this.base}/directories` });
    }

    /** Name up to 30 characters. Returns the folder list. */
    createDirectory(directoryName: string, directoryLabel?: string) {
        return this.transport.json<Folder[]>({
            op: "directoryCreate",
            method: "POST",
            url: `${this.base}/directories`,
            body: { directoryName, ...(directoryLabel && { directoryLabel }) },
        });
    }

    renameDirectory(directoryId: string, newDirectoryName: string) {
        return this.transport.json<unknown>({
            op: "directoryUpdate",
            method: "PATCH",
            url: `${this.base}/directories/${encodeURIComponent(directoryId)}`,
            body: { newDirectoryName },
        });
    }

    deleteDirectory(directoryId: string) {
        return this.transport.json<unknown>({
            op: "directoryDelete",
            method: "DELETE",
            url: `${this.base}/directories/${encodeURIComponent(directoryId)}`,
        });
    }

    archiveTasks(query: ArchiveTaskQuery = {}) {
        return this.transport.json<ArchiveTaskList>({
            op: "archiveTaskList",
            url: `${this.base}/message-archive-task-list`,
            query: { limit: 10, sortColumn: "creationDate", sortDirection: "desc", ...query },
        });
    }

    /** Orders a ZIP of several messages, e.g. when one is over 15 MB (error UAAPI0174). */
    createArchiveTask(messageIds: string[], taskDescription = "") {
        return this.transport.json<{ taskId: string }>({
            op: "archiveTaskCreate",
            method: "POST",
            url: `${this.base}/message-archive-task`,
            body: { messageId: messageIds, taskDescription },
        });
    }

    changeArchiveTask(taskId: string, changeStatus: ArchiveTaskChange) {
        return this.transport.json<ArchiveTaskList | ArchiveTask>({
            op: "archiveTaskPatch",
            method: "PATCH",
            url: `${this.base}/message-archive-task`,
            body: { taskId, changeStatus },
        });
    }

    downloadArchiveTask(taskId: string) {
        return this.transport.file({
            op: "archiveTaskDownload",
            url: `${this.base}/message-archive-task/${encodeURIComponent(taskId)}/download`,
            accept: "application/zip,application/json",
        });
    }
}
