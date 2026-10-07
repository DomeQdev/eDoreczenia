import { API } from "../constants.js";
import type {
    BaeSearchRequest,
    BaeSearchResponse,
    EdaSearchResponse,
    KppSearchRequest,
    KppSearchResponse,
    SearchCategory,
    TerytItem,
} from "../types/Admin.js";
import type { ApiContext } from "./Transport.js";

/*
 * Read-only recipient search and address dictionaries:
 * - SE API: the electronic address registry, by address, name or PESEL/NIP/REGON/KRS,
 * - KPP: the public entity directory (offices with their addresses),
 * - TERYT: voivodeships → districts → communities → cities → streets.
 *
 * SE errors look like `{ errorCodes: [{ errorCode, errorId?, errorDescription? }] }` and end up
 * in `ApiError.details`.
 */

/** Category groups used by the official search filters. */
export const SEARCH_CATEGORIES: Record<"publicInstitution" | "publicTrustProfession" | "individual", SearchCategory[]> = {
    publicInstitution: ["COMPANY", "ORGANISATION", "PUBLIC_INSTITUTION"],
    publicTrustProfession: [
        "ADVOCATE",
        "LEGAL_ADVISOR",
        "TAX_ADVISOR",
        "RESTRUCTURING_ADVISOR",
        "PATENT_ATTORNEY",
        "NOTARY",
        "COUNSELLOR_OF_GCRP",
    ],
    individual: ["INDIVIDUAL"],
};

const KPP_ATTRIBUTES = ["postalCode", "KRS", "NIP", "REGON", "buildingNumber", "fullName", "flatNumber", "locality", "street"];

export class SearchApi {
    constructor(private readonly context: ApiContext) {}

    private get transport() {
        return this.context.transport;
    }

    /** The official client sends its own address along with every search. */
    private ownAddress() {
        try {
            return this.context.mailbox().eDeliveryAddress;
        } catch {
            return undefined;
        }
    }

    bae(request: BaeSearchRequest) {
        return this.transport.json<BaeSearchResponse>({
            op: "seBaeSearch",
            method: "POST",
            url: `${API.se}/search/bae_search`,
            body: { senderEda: this.ownAddress(), offset: 1, limit: 20, ...request },
        });
    }

    /** Registry data of an address: is it active, does it carry warnings, who owns it. */
    byAddress(ade: string | string[]) {
        return this.bae({ recipientEdasOnly: true, recipientEdas: [ade].flat() });
    }

    /** Checks up to 1000 addresses. Do not send to inactive ones or ones with a `BLOCK_WARNING`. */
    edas(recipientEdas: string[]) {
        return this.transport.json<EdaSearchResponse>({
            op: "seEdaSearch",
            method: "POST",
            url: `${API.se}/search/eda-search`,
            body: { recipientEdas, senderEda: this.ownAddress(), offset: 0, limit: 1000 },
        });
    }

    /** Confirms address data; defaults to the mailbox's own address, as the official UI does. */
    edaConfirmation(recipientEda?: string) {
        const own = this.ownAddress();

        return this.transport.json<Record<string, unknown>>({
            op: "seEdaConfirmation",
            method: "POST",
            url: `${API.se}/search/eda-confirmation`,
            body: { senderEda: own, recipientEda: recipientEda ?? own },
        });
    }

    /** Public entity suggestions for a phrase of 3+ characters: name, NIP, REGON, KRS or address. */
    publicEntities(phrase: string, options: Partial<KppSearchRequest> = {}) {
        return this.transport.json<KppSearchResponse>({
            op: "kppSearch",
            method: "POST",
            url: `${API.kpp}/api/bae-integrator-kpp/v1/search`,
            body: { phrase, phraseAttributes: KPP_ATTRIBUTES, status: "ACTIVE", publicType: "PUBLIC", score: 15, ...options },
        });
    }

    /** The central directory used by the dashboard; also matches `deliveryAddress`. */
    publicEntitiesCentral(phrase: string, options: Partial<KppSearchRequest> = {}) {
        return this.transport.json<KppSearchResponse>({
            op: "kppSearchCentral",
            client: "dashboard",
            method: "POST",
            url: `${API.kpp}/api/bae-integrator-kpp/central/v1/search`,
            body: {
                phrase,
                phraseAttributes: [...KPP_ATTRIBUTES, "deliveryAddress"],
                status: "ACTIVE",
                publicType: "PUBLIC",
                score: 15,
                ...options,
            },
        });
    }

    voivodeships() {
        return this.transport.json<TerytItem[]>({ op: "terytVoivodeships", url: `${API.teryt}/voivodeships` });
    }

    districts(voivodeshipId: string, search?: string) {
        return this.transport.json<TerytItem[]>({
            op: "terytDistricts",
            url: `${API.teryt}/districts`,
            query: { "voivodeship-id": voivodeshipId, "search-param": search },
        });
    }

    communities(districtId: string, search?: string) {
        return this.transport.json<TerytItem[]>({
            op: "terytCommunities",
            url: `${API.teryt}/communities`,
            query: { "district-id": districtId, "search-param": search },
        });
    }

    community(communityId: string) {
        return this.transport.json<TerytItem>({
            op: "terytCommunity",
            url: `${API.teryt}/communities/${encodeURIComponent(communityId)}`,
        });
    }

    cities(communityId: string, search?: string) {
        return this.transport.json<TerytItem[]>({
            op: "terytCities",
            url: `${API.teryt}/cities`,
            query: { "community-id": communityId, "search-param": search },
        });
    }

    city(communityId: string, cityId: string) {
        return this.transport.json<TerytItem>({
            op: "terytCity",
            url: `${API.teryt}/cities/${encodeURIComponent(communityId)}/${encodeURIComponent(cityId)}`,
        });
    }

    streets(cityId: string, search?: string) {
        return this.transport.json<TerytItem[]>({
            op: "terytStreets",
            url: `${API.teryt}/streets`,
            query: { "city-id": cityId, "search-param": search },
        });
    }

    street(cityId: string, streetId: string) {
        return this.transport.json<TerytItem>({
            op: "terytStreet",
            url: `${API.teryt}/streets/${encodeURIComponent(cityId)}/${encodeURIComponent(streetId)}`,
        });
    }

    countries() {
        return this.transport.json<{ countryCode: string; name: string }[]>({
            op: "terytCountries",
            url: `${API.teryt}/countries`,
        });
    }
}
