import type { TraceEntry } from "./tools/Trace.js";

// Messages never contain tokens, cookies, message content, PESEL numbers or full addresses,
// so every error thrown by this library is safe to log as-is.

export class EdoError extends Error {
    override name = "EdoError";
}

/** Non-2xx API response, or a response body of an unexpected kind. */
export class ApiError extends EdoError {
    override name = "ApiError";

    constructor(
        readonly operation: string,
        readonly status: number,
        readonly code: string | null = null,
        /** Parsed error body. Deliberately left out of the message. */
        readonly details?: unknown
    ) {
        super(`${operation} ${status}${code ? ` (${code})` : ""}`);
    }
}

/** Keycloak token endpoint error. */
export class OidcError extends EdoError {
    override name = "OidcError";

    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message);
    }
}

/** The SSO session is gone and the user has to sign in with mObywatel again. */
export class SessionExpiredError extends EdoError {
    override name = "SessionExpiredError";
}

export class QrExpiredError extends EdoError {
    override name = "QrExpiredError";

    constructor() {
        super("QR code expired without confirmation");
    }
}

/**
 * The login flow got a response it does not recognize. The library never tries to work
 * around such a response; `step` and the value-free `trace` show where it stopped.
 */
export class FlowHalt extends EdoError {
    override name = "FlowHalt";

    constructor(
        readonly step: string,
        readonly reason: string,
        readonly trace: TraceEntry[] = []
    ) {
        super(`${step}: ${reason}`);
    }
}

/**
 * Opening an unopened message confirms its delivery, which has legal effect.
 * Thrown when that could happen without an explicit `acknowledgeReceipt: true`.
 */
export class ReceiptGuardError extends EdoError {
    override name = "ReceiptGuardError";

    constructor(reason: string) {
        super(`receipt guard: ${reason}`);
    }
}

/** Log-safe one-line description of any error, with URLs and addresses masked. */
export const describeError = (error: unknown) => {
    if (error instanceof ApiError || error instanceof ReceiptGuardError) return error.message;

    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    return message
        .replace(/https?:\/\/\S+/g, "<url>")
        .replace(/[A-Z]{2}:[A-Z]{2}-[A-Z0-9-]+/g, "<ade>")
        .slice(0, 200);
};

const isCode = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9 _.:-]{1,80}$/.test(value);

/** Picks a code-like field (e.g. `"UAAPI0174"`, `"503 SERVICE_UNAVAILABLE"`) out of an error body. */
export const parseErrorBody = (text: string): { code: string | null; details: unknown } => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { code: null, details: undefined };
    }

    // UA API errors come as `[{ error, error_description }]`, SE API ones as `{ errorCodes: [{ errorCode }] }`.
    const list = Array.isArray(parsed) ? parsed : (parsed as { errorCodes?: unknown } | null)?.errorCodes;
    if (Array.isArray(list)) {
        const first = (list[0] ?? {}) as Record<string, unknown>;
        const code = first.error ?? first.errorCode;
        if (isCode(code)) return { code, details: parsed };
    }

    const body = (Array.isArray(list) ? (list[0] ?? {}) : parsed) as Record<string, unknown> | null;
    for (const key of ["error", "errorCode", "code", "status"]) {
        const value = body?.[key];
        if (isCode(value)) return { code: value, details: body };
    }

    return { code: null, details: body };
};
