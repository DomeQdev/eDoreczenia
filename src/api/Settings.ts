import { API } from "../constants.js";
import { EdoError } from "../errors.js";
import type {
    MailboxSettings,
    MessageNotification,
    RuleInput,
    RuleList,
    RulePatch,
    SettingsPatch,
    Subscription,
    SubscriptionName,
    SubscriptionPut,
    WebhookPayload,
} from "../types/Admin.js";
import { idsSegment, type ApiContext } from "./Transport.js";

/*
 * Webhooks: the mailbox POSTs a `WebhookPayload` to each subscribed URL — `messageCallback` (new
 * message), `evidenceCallback` (new evidence), `inboxCallback` (message moved from a service to
 * the mailbox), `messageCreatedCallback` (send task finished) and `archiveCreatedCallback`
 * (archive ready). Validate incoming bodies with `parseWebhook` instead of polling.
 */

export class SettingsApi {
    constructor(private readonly context: ApiContext) {}

    private get transport() {
        return this.context.transport;
    }

    private get base() {
        return `${API.beuis}/${this.context.mailbox().eDeliveryAddress}`;
    }

    /** Notification e-mail and mailbox capacity. */
    get() {
        return this.transport.json<MailboxSettings>({ op: "settingsGet", url: `${this.base}/settings` });
    }

    update(patch: SettingsPatch) {
        return this.transport.json<MailboxSettings[]>({
            op: "settingsPatch",
            method: "PATCH",
            url: `${this.base}/settings`,
            body: patch,
        });
    }

    /** Like the official UI: lowercased, wrapped in an array. */
    setNotificationEmail(email: string) {
        return this.update([{ op: "replace", path: "email", value: [email.trim().toLowerCase()] }]);
    }

    /** Push notification switch; part of the spec, not shown in the web UI. */
    pushNotifications() {
        return this.transport.json<MessageNotification>({
            op: "notificationGet",
            url: `${this.base}/message_notification`,
        });
    }

    setPushNotifications(pushNotification: boolean) {
        return this.transport.json<unknown>({
            op: "notificationPatch",
            method: "PATCH",
            url: `${this.base}/message_notification`,
            body: { pushNotification },
        });
    }

    subscriptions() {
        return this.transport.json<Subscription[]>({ op: "subscriptionsGet", url: `${this.base}/message_subscriptions` });
    }

    /** Sets the callback URL of one event: `https://…` without query parameters. */
    setSubscription(name: SubscriptionName, url: string) {
        return this.setSubscriptions({ [`${name}Url`]: url });
    }

    /** Several callback URLs at once; the spec allows it, the official UI sends one at a time. */
    setSubscriptions(urls: SubscriptionPut) {
        return this.transport.json<{ subscriptionId: string }>({
            op: "subscriptionsPut",
            method: "PUT",
            url: `${this.base}/message_subscriptions`,
            body: urls,
        });
    }

    toggleSubscription(subscriptionId: string, status: boolean) {
        return this.transport.json<unknown>({
            op: "subscriptionsPatch",
            method: "PATCH",
            url: `${this.base}/message_subscriptions`,
            body: { subscriptionId, status },
            accept: "*/*",
        });
    }

    /** Removes all subscriptions of the mailbox. */
    deleteSubscriptions() {
        return this.transport.json<unknown>({
            op: "subscriptionsDelete",
            method: "DELETE",
            url: `${this.base}/message_subscriptions`,
        });
    }

    rules(query: { offset?: number; limit?: number } = {}) {
        return this.transport.json<RuleList>({ op: "rulesList", url: `${this.base}/rule_list`, query });
    }

    createRule(body: RuleInput) {
        return this.transport.json<unknown>({ op: "ruleCreate", method: "POST", url: `${this.base}/rule`, body });
    }

    updateRule(ruleId: string, body: RulePatch) {
        return this.transport.json<unknown>({
            op: "ruleUpdate",
            method: "PATCH",
            url: `${this.base}/rule/${encodeURIComponent(ruleId)}`,
            body,
        });
    }

    deleteRule(ruleIds: string | string[]) {
        return this.transport.json<unknown>({
            op: "ruleDelete",
            method: "DELETE",
            url: `${this.base}/rule/${idsSegment(ruleIds)}`,
        });
    }

    /** Country names, for hybrid shipments abroad. */
    countries() {
        return this.transport.json<string[]>({ op: "dictionaryCountries", url: `${API.beuis}/dictionary/countries` });
    }
}

/** Minimal validation of a webhook body: an address and a notification type. */
export const parseWebhook = (body: unknown) => {
    const payload = body as WebhookPayload | null;
    if (typeof payload?.eDeliveryAddress !== "string" || typeof payload.notificationType !== "string") {
        throw new EdoError("not an e-Doręczenia webhook payload");
    }

    return payload;
};
