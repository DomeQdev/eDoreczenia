import { API } from "../constants.js";
import { EdoError } from "../errors.js";
import type {
    AddressStatus,
    DiscoveryAddress,
    EdaOperationRequest,
    MenuRequest,
    SubmittedRequest,
} from "../types/Admin.js";
import type { ApiContext, Query } from "./Transport.js";

/*
 * Dashboard APIs, all called with the `edor-dashboard` token: the user's addresses (discovery),
 * the electronic address registry (opening, changing and closing addresses, applications),
 * PESEL registry data and the menu configuration.
 */

type Json = Record<string, unknown>;

const DEFAULT_MENU: MenuRequest = { context: "OBYWATEL", system: "E_DORECZENIA" };

export class DashboardApi {
    constructor(private readonly context: ApiContext) {}

    private get transport() {
        return this.context.transport;
    }

    private resolveAddress(ade?: string) {
        return ade ?? this.context.mailbox().eDeliveryAddress;
    }

    private pesel() {
        const pesel = this.context.session?.claims("dashboard")?.person_identifier;
        if (!pesel) throw new EdoError("dashboard token without person_identifier");

        return pesel;
    }

    private json<T>(op: string, method: string, url: string, extra: { body?: unknown; query?: Query } = {}) {
        return this.transport.json<T>({ op, client: "dashboard", method, url, ...extra });
    }

    /** Addresses available to a person; defaults to the PESEL from the dashboard token. */
    authorizedAddressesExtended(body?: { idType: string; idValue: string }) {
        return this.json<{ eDeliveryAddressData?: DiscoveryAddress[]; endStatus?: unknown; errorList?: unknown[] }>(
            "authorizedAddressesExtended",
            "POST",
            `${API.discovery}/discoveryPlus/authorizedAddressesExtended`,
            { body: body ?? { idType: "PESEL", idValue: this.pesel() } }
        );
    }

    authorizedAddresses(body?: { idType: string; idValue: string; sendingMessagesPossible?: boolean }) {
        return this.json<{ eDeliveryAddressData?: DiscoveryAddress[] }>(
            "authorizedAddresses",
            "POST",
            `${API.discovery}/discoveryPlus/authorizedAddresses`,
            { body: body ?? { idType: "PESEL", idValue: this.pesel() } }
        );
    }

    address(ade?: string) {
        return this.json<Json>("baeAddress", "GET", `${API.bae}/addresses/${this.resolveAddress(ade)}`);
    }

    addressStatus(ade?: string) {
        return this.json<AddressStatus>("baeAddressStatus", "GET", `${API.bae}/addresses/status/${this.resolveAddress(ade)}`);
    }

    addressesStatus(body: Json) {
        return this.json<Json>("baeAddressesStatus", "POST", `${API.bae}/addresses/status`, { body });
    }

    /** Registry entities of the signed-in user. */
    subjects() {
        return this.json<Json>("baeSubjects", "GET", `${API.bae}/addresses/subjectBAE`);
    }

    subject(kppId: string) {
        return this.json<Json>("baeSubject", "GET", `${API.bae}/addresses/subjectBAE/${encodeURIComponent(kppId)}`);
    }

    /** A person's addresses (`{ id: pesel, referenceRegistry: "PESEL" }`), or details of a single address. */
    searchByRegistryNumber(body: { id: string; referenceRegistry: string }, ade?: string, showDetailedInfo?: boolean) {
        return this.json<unknown>("baeSearchBy", "POST", `${API.bae}/addresses/search-by/${ade ?? ""}`, {
            body,
            query: { showDetailedInfo },
        });
    }

    serviceProviders() {
        return this.json<{ serviceProviderBusinessId: string; name: string; isOw: boolean }[]>(
            "baeServiceProviders",
            "GET",
            `${API.bae}/service-provider`
        );
    }

    serviceProviderAddresses(body: Json) {
        return this.json<Json>("baeServiceProviderAddresses", "POST", `${API.bae}/service_providers/addresses`, { body });
    }

    /** Registry application (open, change, close an address…). Sign it at the returned `signingUrl`. */
    processAddressOperation(body: EdaOperationRequest) {
        return this.json<{ requestId: number; signingUrl: string }>("baeOperation", "POST", `${API.bae}/addresses/operation`, {
            body,
        });
    }

    activateAddress(requestId: string) {
        return this.json<{ eDeliveryAddress?: string }>("baeActivate", "POST", `${API.bae}/addresses/operation/activation`, {
            query: { requestId },
        });
    }

    activateAddressByAde(ade: string, body: { notificationEmail: string }) {
        return this.json<unknown>("baeActivateAde", "POST", `${API.bae}/addresses/activation/${ade}`, { body });
    }

    addSignedApplication(requestId: string, body: { url: string; attachments: string[] }) {
        return this.json<unknown>("baeSignReload", "POST", `${API.bae}/addresses/operation/signReload`, {
            body,
            query: { requestId },
        });
    }

    /**
     * Body: `{ attachments: [{ fileName, contentType, fileSize, content (base64), attachmentType,
     * fileDescription }], isPublicEntity }`. Returns the attachment ids.
     */
    createAttachments(body: Json) {
        return this.json<string[]>("baeAttachmentsCreate", "POST", `${API.bae}/addresses/attachments`, { body });
    }

    deleteAttachments(attachmentIds: string[]) {
        return this.json<Json>("baeAttachmentsDelete", "DELETE", `${API.bae}/addresses/attachments`, {
            query: { attachmentIds },
        });
    }

    /** Applications a person has submitted; defaults to the PESEL from the dashboard token. */
    submittedRequests(body?: { id: string; referenceRegistry: string }) {
        return this.json<SubmittedRequest[]>("baeSubmittedRequests", "POST", `${API.bae}/addresses/submitted-requests`, {
            body: body ?? { id: this.pesel(), referenceRegistry: "PESEL" },
        });
    }

    submittedRequest(requestId: string) {
        return this.json<Json>(
            "baeSubmittedRequest",
            "POST",
            `${API.bae}/addresses/submitted-requests/${encodeURIComponent(requestId)}`
        );
    }

    submittedRequestAttachment(requestId: string) {
        return this.transport.file({
            op: "baeSubmittedRequestAttachment",
            client: "dashboard",
            url: `${API.bae}/addresses/submitted-requests/${encodeURIComponent(requestId)}/attachment`,
        });
    }

    /**
     * Target of the `POST` form that hands the chosen address (with `ua_url`, `oidc_url`,
     * `providerName`, `status`) to an external provider that opened the dashboard with `rmClientId`.
     */
    processOrderUrl() {
        return `${API.requestManager}/process-order`;
    }

    /** PESEL registry data of the signed-in user. */
    personalData() {
        return this.json<Json>("baePeselPersonalData", "GET", `${API.baePesel}/personalData`);
    }

    menuCentral(body: MenuRequest = DEFAULT_MENU) {
        return this.json<Json>("menuCentral", "POST", `${API.menu}/edor-api/centr/configuration`, { body });
    }

    menuOw(body: MenuRequest = DEFAULT_MENU) {
        return this.json<Json>("menuOw", "POST", `${API.menu}/edor-api/ow/configuration`, { body });
    }
}
