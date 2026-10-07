/**
 * Regex-based reading of the ePUAP `wnio:Dokument` XML, with no DOM dependency. The letter body
 * is in `wnio:TrescDokumentu`; attachments are `str:Zalacznik[format, kodowanie, nazwaPliku]`
 * holding `str:DaneZalacznika` — base64 in received letters, a file URL in sent ones.
 */
export type EpuapEmbeddedFile = {
    filename: string;
    format: string;
    encoding: string;
    /** Embedded data without whitespace, if the attachment is embedded. */
    base64: string | null;
    /** File URL, if the attachment is not embedded. */
    url: string | null;
};

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const ATTACHMENT = /<(?:[\w-]+:)?Zalacznik\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Zalacznik>/g;
const ATTACHMENT_DATA = /<(?:[\w-]+:)?DaneZalacznika\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?DaneZalacznika>/;

const MIME_TYPES: Record<string, string> = {
    pdf: "application/pdf",
    xml: "application/xml",
    xades: "application/xml",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text",
    txt: "text/plain",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    zip: "application/zip",
};

export const xmlUnescape = (text: string) =>
    text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
        if (!entity.startsWith("#")) return XML_ENTITIES[entity.toLowerCase()] ?? match;

        const isHex = entity[1] === "x" || entity[1] === "X";
        const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);

        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    });

const readAttribute = (attributes: string, name: string) => {
    const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);

    return match ? xmlUnescape(match[2] ?? match[3] ?? "") : "";
};

export const extractAttachments = (xml: string): EpuapEmbeddedFile[] =>
    [...xml.matchAll(ATTACHMENT)].map(([, attributes = "", content = ""]) => {
        const data = (ATTACHMENT_DATA.exec(content)?.[1] ?? "").trim();
        const isUrl = /^https?:\/\//i.test(xmlUnescape(data));
        const isBase64 = !isUrl && data.length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(data);

        return {
            filename: readAttribute(attributes, "nazwaPliku") || "zalacznik",
            format: readAttribute(attributes, "format"),
            encoding: readAttribute(attributes, "kodowanie"),
            base64: isBase64 ? data.replace(/\s+/g, "") : null,
            url: isUrl ? xmlUnescape(data) : null,
        };
    });

/** Drops attachment data and signatures, keeping the structure and the letter text. */
export const stripForDisplay = (xml: string) =>
    xml
        .replace(/(<(?:[\w-]+:)?DaneZalacznika\b[^>]*>)[\s\S]*?(<\/(?:[\w-]+:)?DaneZalacznika>)/g, "$1$2")
        .replace(/<(?:[\w-]+:)?Signature\b[\s\S]*?<\/(?:[\w-]+:)?Signature>/g, "");

/** MIME type from the `format` attribute, or from the filename extension. */
export const guessContentType = (format: string, filename: string) => {
    if (/^[a-z]+\/[\w.+-]+$/i.test(format)) return format.toLowerCase();

    const extension = filename.split(".").pop()?.toLowerCase() ?? "";

    return MIME_TYPES[extension] ?? "application/octet-stream";
};
