import type { UploadFile } from "../types/Mailbox.js";

/** Limits of the official send form. */
export const LIMITS = {
    /** Per file and in total, for regular and ePUAP messages. */
    maxFileBytes: 524_288_000,
    maxTotalBytes: 524_288_000,
    /** Mass and hybrid messages. */
    maxMassFileBytes: 15_728_640,
    maxAttachments: 100,
    maxFilenameLength: 128,
    maxSubjectLength: 255,
    maxTextLength: 5000,
    /** 1000 for public entities. A mass message starts at 15 recipients. */
    maxRecipients: 15,
    maxRecipientsPublicEntity: 1000,
    /** Attachment signed with Podpis Zaufany. */
    maxSignBytes: 10_485_760,
    /** Signature verification, .pdf and .xml only. */
    maxVerifyBytes: 15_728_640,
} as const;

/** Case-insensitive. */
export const ALLOWED_EXTENSIONS = [
    "txt", "ppt", "rtf", "docx", "png", "gzip", "xsd", "jp2", "dgn", "dxf", "dwg", "xmlenc", "asic", "rng", "xsl",
    "xslt", "pdf", "xls", "xlsx", "svg", "7z", "xps", "pptx", "wav", "m4a", "gz", "html", "xhtml", "odt", "csv", "mp3",
    "mpeg4", "ods", "jpg", "avi", "ogg", "gml", "geotiff", "odp", "jpeg", "mpg", "ogv", "doc", "tif", "mpeg", "zip",
    "tiff", "mp4", "tar", "xades", "cades", "css", "dwf", "pades", "tsl", "xmlsig", "xml",
] as const;

/** No whitespace and none of `: ~ " # % & * < > ? ! / { | } \`. */
export const EDELIVERY_FILENAME = /^[^:~" #%&*<>?!/{|}\\\s]+$/;

/** None of `\ / ? : * < > | % "`. */
export const EPUAP_FILENAME = /^[^\\/?:*<>|%"]+$/;

// Mirrors `checkMimetype` of the official mailbox, including its non-standard choices.
const MIME_TYPES: Record<string, string> = {
    xades: "application/xml",
    tsl: "application/xml",
    xmlsig: "application/xml",
    xmlenc: "application/xml",
    xsl: "application/xml",
    rng: "application/xml",
    xsd: "application/xml",
    xml: "application/xml",
    cades: "text/x-ttcn-asn",
    pades: "application/pdf",
    mpeg4: "video/mpeg",
    xhtml: "text/html",
    dgn: "application/vnd.dgn",
    dxf: "image/vnd.dxf",
    dwf: "model/vnd.dwf",
    jp2: "image/jp2",
    dwg: "image/vnd.dwg",
    asic: "application/vnd.etsi.asic-e+zip",
    xslt: "application/xslt+xml",
    gml: "application/gml+xml",
    geotiff: "image/tiff",
    gz: "application/gzip",
    gzip: "application/gzip",
    pdf: "application/pdf",
    txt: "text/plain",
    rtf: "application/rtf",
    csv: "text/csv",
    html: "text/html",
    css: "text/css",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    zip: "application/zip",
    "7z": "application/x-7z-compressed",
    tar: "application/x-tar",
    xps: "application/vnd.ms-xpsdocument",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    ogv: "video/ogg",
    mp4: "video/mp4",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
    avi: "video/x-msvideo",
};

export const extensionOf = (filename: string) => {
    const dot = filename.lastIndexOf(".");

    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

/** Empty string for unknown extensions, like the official client. */
export const mimeTypeFor = (filename: string) => MIME_TYPES[extensionOf(filename)] ?? "";

export const isAllowedExtension = (filename: string) =>
    (ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));

export const toBlob = ({ data, filename, contentType }: UploadFile) =>
    data instanceof Blob ? data : new Blob([data as BlobPart], { type: contentType ?? mimeTypeFor(filename) });

const sizeOf = ({ data }: UploadFile) => (data instanceof Blob ? data.size : data.byteLength);

/** Same checks as the official send form. Returns the problems found; empty means valid. */
export const validateUpload = (
    files: UploadFile[],
    { service, mass }: { service?: "eDelivery" | "ePUAP"; mass?: boolean } = {}
) => {
    const problems: string[] = [];
    const maxFileBytes = mass ? LIMITS.maxMassFileBytes : LIMITS.maxFileBytes;
    const maxTotalBytes = mass ? LIMITS.maxMassFileBytes : LIMITS.maxTotalBytes;
    const filenamePattern = service === "ePUAP" ? EPUAP_FILENAME : EDELIVERY_FILENAME;

    if (files.length > LIMITS.maxAttachments) {
        problems.push(`too many attachments (${files.length} > ${LIMITS.maxAttachments})`);
    }

    let total = 0;
    for (const file of files) {
        const size = sizeOf(file);
        total += size;

        if (size > maxFileBytes) problems.push(`${file.filename}: file too large (${size} B)`);
        if (file.filename.length > LIMITS.maxFilenameLength) {
            problems.push(`${file.filename}: filename longer than ${LIMITS.maxFilenameLength}`);
        }
        if (!filenamePattern.test(file.filename)) problems.push(`${file.filename}: filename contains forbidden characters`);
        if (!isAllowedExtension(file.filename)) problems.push(`${file.filename}: extension not accepted`);
    }

    if (total > maxTotalBytes) problems.push(`total size too large (${total} B)`);

    return problems;
};
