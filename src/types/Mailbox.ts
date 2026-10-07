/**
 * Mailbox API models (beuis v2 / UA API v3), based on the UA API 3.0.8 specification — which
 * beuis mirrors — and on the official mailbox app. Fields not confirmed by either are optional,
 * and objects stay open to extra fields.
 */

export type Service = "ePUAP" | "eDelivery" | "All";
export type ShippingService = "electronic" | "hybrid";
export type SortDirection = "asc" | "desc";
export type PredefinedLabel = "INBOX" | "SENT" | "OUTBOX" | "DRAFT" | "TRASH" | (string & {});

/** `Stub` is an unopened message whose content is still being prepared. */
export type MessageType = "Message" | "Evidence" | "Stub" | "massMessageGrouped" | (string & {});

export type MessageStatus =
    | "Odrzucona"
    | "Nadana"
    | "Wysłana"
    | "Czeka na doręczenie"
    | "Doręczona"
    | "Uznana za doręczoną"
    | "Niedoręczona"
    | "Przekazana do Realizacji"
    | "W trakcie weryfikacji"
    | (string & {});

/**
 * Electronic: `BP.WP` / `BP.WX` — proof of sending (PDF / XML), `BP.OP` / `BP.OX` — proof of receipt.
 * Hybrid: `H.PN` — posted, `H.EPO` — received, `H.DW` — not delivered.
 * Technical: `A.1`, `A.2`, `D.1`, `E.1`, `E.2`.
 */
export type EvidenceType =
    | "A.1"
    | "A.2"
    | "B.1"
    | "B.2"
    | "B.3"
    | "D.1"
    | "D.2"
    | "D.3"
    | "E.1"
    | "E.2"
    | "BP.WX"
    | "BP.WP"
    | "BP.OX"
    | "BP.OP"
    | "H.DW"
    | "H.PN"
    | "H.EPO"
    | (string & {});

/** The mailbox the API calls operate on. */
export type MailboxRef = {
    eDeliveryAddress: string;
    organizationEpuapId: string;
};

export type Contributor = {
    firstName?: string;
    lastName?: string;
    /** Up to 1900 characters, the rest goes to `companyNameContinued`. */
    companyName?: string;
    companyNameContinued?: string;
    [key: string]: unknown;
};

export type Party = {
    eDeliveryAddress: string;
    contributor?: Contributor | null;
    address?: unknown;
    /** ePUAP only. */
    warehouseName?: string;
    /** ePUAP only. */
    responseAddress?: string;
    ePUAPId?: string;
    [key: string]: unknown;
};

export type Label = {
    label?: string;
    messageLocation?: string;
    [key: string]: unknown;
};

export type MessageControlData = {
    massMessage?: boolean;
    massMessageId?: string;
    opened?: boolean;
    /** Days left until an unopened message is deemed delivered. */
    daysToReceive?: number | string;
    status?: MessageStatus;
    statusDescription?: string;
    messageType?: MessageType;
    messageTaskId?: string;
    labels?: (Label | string)[];
    [key: string]: unknown;
};

export type HybridShipment = {
    shipmentNumber?: string;
    procedingType: "general" | "administrative" | "tax" | "court_civil" | "court_criminal";
    /** Printed in the sender field, up to 30 characters. */
    sendersInformation?: string;
    categoryService: "economic" | "priority";
    formatService?: "XS" | "S" | "M" | "L";
    printingMode: "duplex" | "simplex";
    overprintMode: "monochrome" | "color";
    returnService: "returntosender" | "destroy";
    proofOfDelivery?: boolean;
    posteRestante?: boolean;
    caseContent?: string;
    shippingMode: "registered" | "notRegistered";
};

export type MessageMetadata = {
    from?: Party;
    to?: Party[];
    subject?: string;
    messageId?: string;
    threadId?: string;
    caseId?: string;
    timestamp?: string;
    receiptDate?: string;
    submissionDate?: string;
    eventDate?: string;
    shippingService?: ShippingService | (string & {});
    additionalData?: unknown;
    service?: Service | (string & {});
    /** The message this one refers to. */
    refToMessageId?: string;
    hybridShipment?: HybridShipment;
    /** ePUAP document id, needed to reply. */
    cid?: string;
    /** ePUAP only (`/document/{id}`): base64 of the `wnio:Dokument` XML. */
    content?: string;
    [key: string]: unknown;
};

export type FileMetadata = {
    fileId?: string;
    filename?: string;
    contentType?: string;
    size?: number;
    /** SHA-3 is the only algorithm the spec allows. */
    alg?: string;
    hash?: string;
    description?: string;
    /** ePUAP only. */
    fileUri?: string;
    [key: string]: unknown;
};

export type Attachment = {
    attachmentId: string;
    order?: number;
    /** ePUAP: embedded in the XML (`true`) or served by the file servlet (`false`). */
    buildInAttachment?: boolean;
    /** `file.file` holds base64 content when sending directly. */
    file?: { fileMetadata?: FileMetadata; file?: string; [key: string]: unknown };
    [key: string]: unknown;
};

export type Evidence = {
    evidenceId?: string;
    messageId?: string;
    createDate?: string;
    eventDate?: string;
    reasonDetails?: string[];
    reasonId?: string;
    /** URL of the generated evidence file. */
    externalData?: string;
    downloaded?: boolean;
    type?: EvidenceType;
    from?: Party;
    to?: Party;
    [key: string]: unknown;
};

export type Message = {
    messageControlData?: MessageControlData;
    messageMetadata?: MessageMetadata;
    /** Only in `full` formats. */
    textBody?: string;
    attachments?: Attachment[];
    evidences?: Evidence[];
    [key: string]: unknown;
};

export type MassMessageInfo = {
    /** Draft with the recipients that could not be sent to for technical reasons. */
    newDraftId?: string;
    massMessageSentCorrectly?: number;
    massMessageEndedWithError?: number;
    massMessageRejected?: number;
    massMessageWaitingToSent?: number;
    massMessageTotal?: number;
};

export type MessageList = {
    messages?: Message[];
    total?: number;
    electronicCount?: number;
    endStatus?: { status?: string; [key: string]: unknown };
    /** The mailbox is close to full. */
    warning?: string;
    massMessageInfo?: MassMessageInfo;
    [key: string]: unknown;
};

/** 202 response of `GET /messages/{id}` while the message is still being prepared. */
export type MessagePending = {
    status: string;
};

/** 202 response of `POST /messages` and `POST /drafts/send`. */
export type SendResult = {
    messageTaskId?: string;
    warning?: string;
    [key: string]: unknown;
};

/** Send task outcome for one recipient. */
export type MessageTaskResult = {
    messageId?: string;
    addressee?: Party;
    error?: string;
    error_description?: string;
    [key: string]: unknown;
};

export type MessageTaskStatus = {
    messageTaskStatus: "FINISHED" | "PENDING";
};

export type EvidenceList = {
    evidences?: Evidence[];
    warning?: string;
    [key: string]: unknown;
};

/** API error as defined by the spec; responses carry an array of these. */
export type ErrorInfo = {
    error: string;
    error_description: string;
    messageId?: string;
};

export type Folder = {
    directoryId?: string;
    name?: string;
    label?: string;
    type?: "predefined" | "defined" | (string & {});
    numberOfUnreadMessages?: number;
    total?: number;
    [key: string]: unknown;
};

export type Thread = {
    opened?: boolean;
    threadId?: string;
    caseIDs?: string[];
    recipients?: unknown[];
    senders?: unknown[];
    firstMessageTitle?: string;
    firstMessageSubmissionDate?: string;
    lastMessageSubmissionDate?: string;
    messagesCount?: number;
    service?: string;
    [key: string]: unknown;
};

export type ThreadDetails = {
    messages?: { total?: number; messages?: Message[] };
    [key: string]: unknown;
};

export type ThreadList = {
    total?: number;
    Thread?: Thread[];
    [key: string]: unknown;
};

export type DraftAttachmentRef = {
    attachmentId: string;
    order: number;
};

export type DraftBody = {
    messageControlData?: { massMessage?: boolean; [key: string]: unknown };
    messageMetadata?: {
        caseId?: string;
        timestamp?: string;
        /** Up to 255 characters. */
        subject?: string;
        threadId?: string;
        from?: Party;
        to?: Party[];
        shippingService?: ShippingService;
        hybridShipment?: unknown;
        [key: string]: unknown;
    };
    /** Up to 5000 characters. */
    textBody?: string;
    attachments?: DraftAttachmentRef[];
    [key: string]: unknown;
};

export type MessageIdResponse = {
    messageId: string;
    [key: string]: unknown;
};

export type SignRedirect = {
    /** Signing operation id. */
    uuid: string;
    /** Podpis Zaufany (pz.gov.pl) page the user signs on. */
    url: string;
    [key: string]: unknown;
};

export type SendSignedResponse = {
    messages?: { messageId: string; [key: string]: unknown }[];
    [key: string]: unknown;
};

export type AttachmentSignRequest = {
    attachmentId: string;
    /** Draft id. */
    messageId: string;
    /** Lowercase "d", unlike everywhere else. */
    edeliveryAddress: string;
    service: "eDelivery" | "ePUAP";
    callbackUrl?: string;
};

export type AttachmentVerification = {
    firstName?: string;
    lastName?: string;
    signatureDate?: string;
    /** Anything other than `INVALID` means a valid signature. */
    verificationResult?: string;
    [key: string]: unknown;
};

export type EpuapDocument = Message & {
    messageMetadata?: MessageMetadata & { content?: string; cid?: string };
};

export type Base64Content = {
    content: string;
    fullFileName?: string;
    [key: string]: unknown;
};

export type EpuapDocumentKind =
    | "wniosek"
    | "podanie"
    | "skarga"
    | "odwołanie"
    | "zażalenie"
    | "informacja"
    | "zawiadomienie"
    | "opinia"
    | "decyzja"
    | "postanowienie"
    | "wezwanie"
    | "zaświadczenie"
    | "inne pismo";

export type EpuapAddress = {
    budynek?: string;
    ulica?: string;
    kodPocztowy?: string;
    lokal?: string;
    miejscowosc?: string;
    gmina?: string;
    powiat?: string;
    wojewodztwo?: string;
};

export type EpuapAttachmentEntry = {
    daneZalacznika: string;
    kodowanie: "URI";
    format: string;
    nazwaPliku: string;
    opisZalacznika: string;
};

/** `POST /sendMessages` — a general letter to an ePUAP mailbox. */
export type EpuapSendRequest = {
    trescDokumentu: {
        tytul: string;
        /** Letter text, up to 5000 characters. */
        informacje: string;
        zalaczniki?: EpuapAttachmentEntry[];
        informacjeDodatkowe?: EpuapAddress;
        rodzajWnioskuRozszerzony: { rodzaj: EpuapDocumentKind; jakiInny?: string };
    };
    daneDokumentu: {
        data: string;
        typDaty: "stworzony";
        adresaci: { instytucja: { nazwaInstytucji: string; adres: EpuapAddress } }[];
        nadawcy: {
            osoba?: {
                imie: string;
                nazwisko: string;
                idOsoby: "PESEL";
                identyfikator: string;
                email?: string;
                telefon?: string;
            };
            instytucja?: { nazwaInstytucji: string };
        }[];
    };
    signature: boolean;
    callbackUrl?: string;
    /** Recipient's mailbox, e.g. `/urzad/SkrytkaESP`. */
    mailboxAddress: string;
    opisDokumentu: { cid?: string; identyfikator?: string };
};

export type EpuapSendResponse = {
    uuid?: string;
    url?: string;
    /** `0` means failure. */
    code?: number;
    message?: string;
    [key: string]: unknown;
};

export type UploadFile = {
    data: Blob | Uint8Array | ArrayBuffer;
    filename: string;
    /** Derived from the extension when omitted. */
    contentType?: string;
};

export type FileResult = {
    bytes: Uint8Array;
    contentType: string;
    /** From `Content-Disposition`, if present. */
    filename: string | null;
};

/** `PATCH …/message_control_data` — label operations (trash, restore, move). */
export type ControlDataPatch = { op: "add" | "remove"; path: "labels"; value: string[] }[];

export type ArchiveTaskStatus =
    | "ARCHIVING_IN_PROGRESS"
    | "ERROR"
    | "READY_TO_DOWNLOAD"
    | "CANCEL_IN_PROGRESS"
    | "CANCELED"
    | "FINISHING_IN_PROGRESS"
    | "FINISHED"
    | "EXPIRED"
    | (string & {});

export type ArchiveTask = {
    taskId: string;
    taskStatus: ArchiveTaskStatus;
    creationDate?: string;
    /** Deadline for downloading a ready archive. */
    dateForDownload?: string;
    numberMessages?: number;
    withDeletingMessages?: boolean;
    errorDescription?: string;
    /** `HH:MM` */
    estimatedTimeToComplete?: string;
    downloadAndChangeStatus?: boolean;
    /** Up to 255 characters. */
    taskDescription?: string;
    [key: string]: unknown;
};

export type ArchiveTaskList = {
    tasks?: ArchiveTask[];
    total?: number;
    [key: string]: unknown;
};

/** `FINISH_WITH_DELETING_MESSAGES` deletes the archived messages too. */
export type ArchiveTaskChange = "CANCEL" | "FINISH_WITH_DELETING_MESSAGES" | "FINISH_WITHOUT_DELETING_MESSAGES";
