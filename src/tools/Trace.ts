/**
 * Entries hold only hosts, paths, statuses and cookie or field *names* — never values —
 * so a trace can be logged or attached to a bug report.
 */
export type TraceEntry = {
    t: string;
    step: string;
    method?: string;
    host?: string;
    path?: string;
    status?: number;
    contentType?: string;
    /** Names of cookies set by the response. */
    cookies?: string[];
    /** Names of submitted form or JSON fields. */
    fields?: string[];
    note?: string;
};

export type TraceSink = (entry: TraceEntry) => void;

export class Trace {
    readonly entries: TraceEntry[] = [];

    constructor(
        private readonly sink: TraceSink | null = null,
        private readonly limit = 400
    ) {}

    record(entry: Omit<TraceEntry, "t">) {
        const full: TraceEntry = { t: new Date().toISOString(), ...entry };

        this.entries.push(full);
        if (this.entries.length > this.limit) this.entries.shift();
        this.sink?.(full);

        return full;
    }

    snapshot() {
        return [...this.entries];
    }
}
