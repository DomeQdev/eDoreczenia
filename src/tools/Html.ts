/**
 * Regex-based HTML form parsing, so no DOM is needed. The government pages it has to
 * handle (SAML auto-POST, context selection) are simple enough for this.
 */
export type FormField = {
    name: string;
    value: string;
    /** `hidden`, `text`, `radio`, `checkbox`, `submit`, `select`… */
    type: string;
    checked?: boolean;
    label?: string;
};

export type FormChoice = {
    name: string;
    value: string;
    label: string;
};

export type ParsedForm = {
    /** Absolute URL. */
    action: string;
    method: "GET" | "POST";
    id: string | null;
    name: string | null;
    fields: FormField[];
    /** Radio, select and valued submit options. More than one means the form needs a decision. */
    choices: FormChoice[];
};

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export const decodeEntities = (text: string) =>
    text
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");

export const stripTags = (html: string) =>
    decodeEntities(html.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim();

export const parseAttributes = (tag: string) => {
    const attributes: Record<string, string> = {};
    const body = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");

    for (const [, name = "", doubleQuoted, singleQuoted, unquoted] of body.matchAll(ATTRIBUTE)) {
        attributes[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? unquoted ?? "");
    }

    return attributes;
};

export const resolveUrl = (href: string, base: URL) => {
    try {
        return new URL(href || base.href, base).href;
    } catch {
        return base.href;
    }
};

const parseForm = (openTag: string, inner: string, baseUrl: URL): ParsedForm => {
    const attributes = parseAttributes(openTag);
    const fields: FormField[] = [];
    const choices: FormChoice[] = [];

    const labels = new Map<string, string>();
    for (const [, labelAttributes, content = ""] of inner.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
        const target = parseAttributes(`<label ${labelAttributes}>`).for;
        if (target) labels.set(target, stripTags(content));
    }

    for (const [tag] of inner.matchAll(/<input\b[^>]*>/gi)) {
        const input = parseAttributes(tag);
        if (!input.name) continue;

        const type = (input.type ?? "text").toLowerCase();
        const value = input.value ?? "";
        const label = (input.id && labels.get(input.id)) || input["aria-label"] || input.title || undefined;

        fields.push({ name: input.name, value, type, checked: "checked" in input, label });
        if (type === "radio" || (type === "submit" && value)) {
            choices.push({ name: input.name, value, label: label ?? value });
        }
    }

    for (const [, buttonAttributes, content = ""] of inner.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
        const button = parseAttributes(`<button ${buttonAttributes}>`);
        if (!button.name || (button.type ?? "submit").toLowerCase() !== "submit") continue;

        const value = button.value ?? "";
        const label = stripTags(content) || value;

        fields.push({ name: button.name, value, type: "submit", label });
        choices.push({ name: button.name, value, label });
    }

    for (const [, selectAttributes, options = ""] of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
        const name = parseAttributes(`<select ${selectAttributes}>`).name;
        if (!name) continue;

        let selected: string | null = null;
        for (const [, optionAttributes, content = ""] of options.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
            const option = parseAttributes(`<option ${optionAttributes}>`);
            const label = stripTags(content);
            const value = option.value ?? label;

            if ("selected" in option) selected ??= value;
            choices.push({ name, value, label });
        }

        fields.push({ name, value: selected ?? "", type: "select" });
    }

    return {
        action: resolveUrl(attributes.action ?? "", baseUrl),
        method: attributes.method?.toUpperCase() === "POST" ? "POST" : "GET",
        id: attributes.id ?? null,
        name: attributes.name ?? null,
        fields,
        choices,
    };
};

export const parseForms = (html: string, baseUrl: URL) =>
    [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)].map(([whole, inner = ""]) =>
        parseForm(whole.slice(0, whole.indexOf(">") + 1), inner, baseUrl)
    );

/**
 * What a browser would submit: hidden and text values, checked radios and checkboxes, and
 * the submit button when there is exactly one. `overrides` replace fields of the same name.
 */
export const formPayload = (form: ParsedForm, overrides: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    const submitCount = form.fields.filter((field) => field.type === "submit").length;

    for (const field of form.fields) {
        if (field.name in overrides) continue;

        switch (field.type) {
            case "hidden":
            case "text":
            case "password":
            case "email":
            case "select":
                params.append(field.name, field.value);
                break;
            case "radio":
            case "checkbox":
                if (field.checked) params.append(field.name, field.value);
                break;
            case "submit":
                if (submitCount === 1) params.append(field.name, field.value);
                break;
        }
    }

    for (const [name, value] of Object.entries(overrides)) params.append(name, value);

    return params;
};

/** True when the form has only hidden fields and at most one submit button. */
export const isAutoSubmittable = (form: ParsedForm) =>
    form.fields.every((field) => field.type === "hidden" || field.type === "submit") &&
    form.fields.filter((field) => field.type === "submit").length <= 1;

/** Target of `<meta http-equiv="refresh" content="0;url=…">`, if present. */
export const parseMetaRefresh = (html: string, base: URL) => {
    const tag = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i.exec(html)?.[0];
    if (!tag) return null;

    const url = /url\s*=\s*['"]?([^'">\s]+)/i.exec(parseAttributes(tag).content ?? "")?.[1];

    return url ? resolveUrl(url, base) : null;
};

/** Absolute `href`s of links containing `fragment`. */
export const findLinks = (html: string, base: URL, fragment: string) =>
    [...html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
        .map(([, doubleQuoted, singleQuoted]) => decodeEntities(doubleQuoted ?? singleQuoted ?? ""))
        .filter((href) => href.includes(fragment))
        .map((href) => resolveUrl(href, base));
