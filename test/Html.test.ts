import { describe, expect, it } from "vitest";
import { formPayload, isAutoSubmittable, parseForms, parseMetaRefresh } from "../src/tools/Html.js";

const base = new URL("https://serwis.epuap.gov.pl/mlpz/context?ORIGIN=x");

describe("parseForms", () => {
    it("parses a SAML auto-POST form", () => {
        const html = `<html><body onload="document.forms[0].submit()">
            <form method="POST" action="https://login.gov.pl/login/SingleSignOnService">
                <input type="hidden" name="SAMLRequest" value="PHNhbWxwOk&#x2b;F1dGhu"/>
                <input type="hidden" name="RelayState" value="abc" />
                <noscript><input type="submit" value="Dalej"/></noscript>
            </form></body></html>`;

        const forms = parseForms(html, base);
        expect(forms).toHaveLength(1);

        const form = forms[0]!;
        expect(form.method).toBe("POST");
        expect(form.action).toBe("https://login.gov.pl/login/SingleSignOnService");
        expect(isAutoSubmittable(form)).toBe(true);

        const payload = formPayload(form);
        expect(payload.get("SAMLRequest")).toBe("PHNhbWxwOk+F1dGhu");
        expect(payload.get("RelayState")).toBe("abc");
    });

    it("detects radio choices and applies overrides", () => {
        const html = `<form method="post" action="/mlpz/chooseContext">
            <input type="hidden" name="token" value="t">
            <input type="radio" name="context" value="PERSON" id="c1"><label for="c1">Osoba fizyczna</label>
            <input type="radio" name="context" value="ORG" id="c2"><label for="c2">Organizacja</label>
            <button type="submit" name="go" value="1">Dalej</button>
        </form>`;
        const form = parseForms(html, base)[0]!;

        expect(form.action).toBe("https://serwis.epuap.gov.pl/mlpz/chooseContext");
        expect(isAutoSubmittable(form)).toBe(false);
        expect(form.choices.map(({ label }) => label)).toEqual(["Osoba fizyczna", "Organizacja", "Dalej"]);

        const payload = formPayload(form, { context: "PERSON" });
        expect(payload.get("context")).toBe("PERSON");
        expect(payload.get("token")).toBe("t");
        expect(payload.get("go")).toBe("1");
    });

    it("treats several submit buttons as a choice", () => {
        const html = `<form action="/x" method="post"><input type="hidden" name="a" value="1">
            <button name="ctx" value="p">Osoba</button><button name="ctx" value="o">Firma</button></form>`;
        const form = parseForms(html, base)[0]!;

        expect(isAutoSubmittable(form)).toBe(false);
        expect(form.choices).toHaveLength(2);
        expect(formPayload(form, { ctx: "o" }).getAll("ctx")).toEqual(["o"]);
    });

    it("reads meta refresh targets", () => {
        expect(parseMetaRefresh(`<meta http-equiv="refresh" content="0; url=/mlpz/next?x=1">`, base)).toBe(
            "https://serwis.epuap.gov.pl/mlpz/next?x=1"
        );
        expect(parseMetaRefresh(`<meta charset="utf-8">`, base)).toBeNull();
    });
});
