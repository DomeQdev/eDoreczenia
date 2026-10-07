const CHUNK_SIZE = 0x8000;

export const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
    }

    return btoa(binary);
};

/** Accepts base64 and base64url, ignoring whitespace. */
export const base64ToBytes = (base64: string) => {
    const binary = atob(base64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/"));

    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const bytesToBase64Url = (bytes: Uint8Array) =>
    bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const utf8Encode = (text: string) => new TextEncoder().encode(text);

export const base64ToUtf8 = (base64: string) => new TextDecoder().decode(base64ToBytes(base64));

/** Random base64url string, used for OIDC `state` and `nonce`. */
export const randomToken = (length = 60) => {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil((length * 3) / 4) + 2));

    return bytesToBase64Url(bytes).slice(0, length);
};

/** Reads a JWT payload without verifying its signature. */
export const decodeJwt = <T = Record<string, unknown>>(jwt: string): T | null => {
    const payload = jwt.split(".")[1];
    if (!payload) return null;

    try {
        return JSON.parse(base64ToUtf8(payload)) as T;
    } catch {
        return null;
    }
};

/** `AE:PL-12345-67890-ABCDE-12` → `AE:PL-xxxxx-xxxxx-ABCDE-xx` */
export const maskAde = (ade: string | null | undefined) =>
    ade?.replace(/^([A-Z]{2}:[A-Z]{2}-)\d{5}-\d{5}-([A-Z0-9]{5})-\d{2}$/, "$1xxxxx-xxxxx-$2-xx") ?? "";
