import { API } from "../constants.js";
import { ApiError } from "../errors.js";
import { base64ToBytes, base64ToUtf8 } from "../tools/Encoding.js";
import { mimeTypeFor, toBlob } from "../tools/Files.js";
import type {
    Base64Content,
    EpuapAttachmentEntry,
    EpuapDocument,
    EpuapSendRequest,
    EpuapSendResponse,
    FileResult,
    SignRedirect,
    UploadFile,
} from "../types/Mailbox.js";
import { assertReadable, type MessageRef, type ReadOptions } from "./Messages.js";
import { idsSegment, readFile, type ApiContext } from "./Transport.js";

/*
 * ePUAP letters in the e-Delivery mailbox. They have numeric ids and their content is a base64
 * `wnio:Dokument` XML (see `EpuapXml`). Receiving one requires signing an UPD (official
 * acknowledgement of delivery) with Podpis Zaufany: `sendUpdBack`, then `sendSignedDocument`.
 */

export class EpuapApi {
    constructor(private readonly context: ApiContext) {}

    private get transport() {
        return this.context.transport;
    }

    /** Metadata, base64 XML `content` and the attachment list. Guarded like `messages.get`. */
    document(ref: MessageRef, options: ReadOptions = {}) {
        const id = assertReadable(ref, options);

        return this.transport.json<EpuapDocument>({
            op: "epuapDocument",
            url: `${API.beuis}/document/${encodeURIComponent(id)}`,
        });
    }

    /** HTML rendering of the document. */
    async visualization(ref: MessageRef, options: ReadOptions = {}) {
        const id = assertReadable(ref, options);
        const { content } = await this.transport.json<Base64Content>({
            op: "epuapVisualization",
            url: `${API.beuis}/documentVisualization/${encodeURIComponent(id)}`,
        });

        return base64ToUtf8(content);
    }

    /** The official acknowledgement packaged with the original document. */
    async withUpoAndAttachments(ref: MessageRef, options: ReadOptions = {}): Promise<FileResult> {
        const id = assertReadable(ref, options);
        const { content, fullFileName } = await this.transport.json<Base64Content>({
            op: "epuapUpoPackage",
            url: `${API.beuis}/document/${encodeURIComponent(id)}/ContainingUpoAndAttachment`,
        });

        return { bytes: base64ToBytes(content), contentType: "application/octet-stream", filename: fullFileName ?? null };
    }

    /** Attachment embedded in the XML or kept in the ePUAP file store. */
    async attachment(fileId: string, buildInAttachment: boolean) {
        const { content } = await this.transport.json<Base64Content>({
            op: "epuapAttachment",
            url: `${API.beuis}/attachment/${encodeURIComponent(fileId)}/get`,
            query: { buildInAttachment },
        });

        return base64ToBytes(content);
    }

    /**
     * Downloads a non-embedded file (`fileUri` pointing at the ePUAP servlet). The servlet takes
     * the `authentication.session_index` claim of the `edor-app` token as a `TGSID` form field,
     * and no bearer token.
     */
    async downloadServletFile(fileUri: string, maxBytes = 100 * 1024 * 1024) {
        const op = "epuapDownload";
        const url = new URL(fileUri);
        const fileId = url.searchParams.get("fileId");
        if (url.origin + url.pathname !== API.epuapDownload || !fileId) throw new ApiError(op, 0, "unexpected-uri");

        // Makes sure the claims below come from a valid token.
        await this.transport.tokens.accessToken("app");
        const tgsid = this.context.session?.claims("app")?.authentication?.session_index;
        if (!tgsid) throw new ApiError(op, 0, "no-session-index");

        const response = await this.transport.fetch(`${API.epuapDownload}?${new URLSearchParams({ fileId })}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "*/*",
                "User-Agent": this.transport.userAgent,
            },
            body: new URLSearchParams({ TGSID: tgsid }),
        });

        if (!response.ok) {
            await response.body?.cancel();
            throw new ApiError(op, response.status);
        }
        if (response.headers.get("content-type")?.includes("html")) {
            await response.body?.cancel();
            throw new ApiError(op, response.status, "html-instead-of-file");
        }

        return readFile(op, response, maxBytes);
    }

    deleteDocument(ids: string | string[]) {
        return this.transport.json<{ details?: unknown[] }>({
            op: "epuapDocumentDelete",
            method: "DELETE",
            url: `${API.beuis}/document/${idsSegment(ids)}`,
        });
    }

    deleteFile(fileId: string) {
        return this.transport.json<unknown>({
            op: "epuapFileDelete",
            method: "DELETE",
            url: `${API.beuis}/attachment/${encodeURIComponent(fileId)}`,
        });
    }

    /** Uploads to the ePUAP file store. Reference the result with `fileUrl(fileId)`. */
    uploadFile(file: UploadFile, { encoding = "", description = "" }: { encoding?: string; description?: string } = {}) {
        const blob = toBlob(file);
        const form = new FormData();
        form.append("filename", file.filename);
        form.append("mimeType", file.contentType ?? mimeTypeFor(file.filename));
        form.append("encoding", encoding);
        form.append("file", blob, file.filename);
        form.append("size", String(blob.size));
        form.append("alg", "");
        form.append("description", description);

        return this.transport.json<{ fileId: string }>({
            op: "epuapUploadFile",
            method: "POST",
            url: `${API.beuis}/uploadFile`,
            body: form,
        });
    }

    fileUrl(fileId: string) {
        return `${API.epuapDownload}?fileId=${fileId}`;
    }

    /** Uploads files and returns ready `zalaczniki` entries for `send`. */
    async uploadAttachments(files: UploadFile[]) {
        const entries: EpuapAttachmentEntry[] = [];
        for (const file of files) {
            const { fileId } = await this.uploadFile(file);
            entries.push({
                daneZalacznika: this.fileUrl(fileId),
                kodowanie: "URI",
                format: "",
                nazwaPliku: file.filename,
                opisZalacznika: "",
            });
        }

        return entries;
    }

    /**
     * Sends a general letter. Without a signature the result is final (`code: 0` throws); with one,
     * the user signs at the returned `url` and `sendSignedDocument(uuid)` finishes sending.
     */
    async send(request: EpuapSendRequest) {
        const result = await this.transport.json<EpuapSendResponse>({
            op: "epuapSend",
            method: "POST",
            url: `${API.beuis}/sendMessages`,
            body: request,
        });
        if (!request.signature && result?.code === 0) throw new ApiError("epuapSend", 200, "code-0", result);

        return result;
    }

    /** Finishes sending a signed document or UPD, after pz.gov.pl redirects back with `status=SUCCESS`. */
    async sendSignedDocument(uuidDocument: string, organizationEpuapId?: string) {
        const result = await this.transport.json<{ code?: number; message?: string }>({
            op: "epuapSendSigned",
            method: "POST",
            url: `${API.beuis}/sendSignedDocument`,
            body: { uuidDocument, ...(organizationEpuapId ? { organizationEpuapId } : {}) },
            accept: "*/*",
        });
        if (result?.code === 0) throw new ApiError("epuapSendSigned", 200, "code-0", result);

        return result;
    }

    /**
     * Starts receiving an ePUAP letter (a `messageType: "Evidence"` entry) by signing its UPD.
     * Once the user signs and `sendSignedDocument(uuid)` runs, the letter counts as delivered.
     */
    sendUpdBack(messageId: string, callbackUrl: string, organizationEpuapId?: string) {
        return this.transport.json<SignRedirect>({
            op: "epuapSendUpdBack",
            method: "POST",
            url: `${API.beuis}/sendUPDBack`,
            body: {
                organizationEpuapId: organizationEpuapId ?? this.context.mailbox().organizationEpuapId,
                id: messageId,
                signature: true,
                callbackUrl,
            },
        });
    }
}
