/**
 * Models of settings, address search, permission management and the dashboard, taken from the
 * official mailbox, MU and dashboard apps. Objects stay open to extra fields.
 */

export type MailboxSettings = {
    /** Address that gets new-message notifications. */
    email?: string;
    /** Capacities are numeric strings. */
    settings?: { totalCapacity?: string; usedCapacity?: string; [key: string]: unknown };
    [key: string]: unknown;
};

export type SettingsPatch = { op: "replace"; path: "email"; value: string[] }[];

export type SubscriptionName =
    | "messageCallback"
    | "evidenceCallback"
    | "inboxCallback"
    | "messageCreatedCallback"
    | "archiveCreatedCallback";

/** Webhook subscription for mailbox events. */
export type Subscription = {
    id: string;
    name: SubscriptionName | (string & {});
    url: string;
    status: boolean;
    [key: string]: unknown;
};

/** Callback URLs, without query parameters. */
export type SubscriptionPut = Partial<Record<`${SubscriptionName}Url`, string>>;

export type MessageNotification = {
    pushNotification: boolean;
};

/**
 * Body POSTed to a subscription URL. Message, evidence and inbox callbacks list ids in
 * `notification`; `messageCreatedCallback` carries send task results and
 * `archiveCreatedCallback` archive tasks.
 */
export type WebhookPayload = {
    eDeliveryAddress: string;
    notificationType: string;
    electronicCount?: number;
    notification?: (
        | { id: string; threadId?: string; type?: string }
        | {
              messageTaskId: string;
              messages?: { messageId?: string; addressee?: unknown; error?: string; error_description?: string }[];
          }
        | { taskId: string; taskStatus: string; [key: string]: unknown }
    )[];
    [key: string]: unknown;
};

export type RuleConditionType = "senderEda" | "senderName" | "caseId" | "subject";

export type RuleCondition = {
    conditionType: RuleConditionType;
    /** Space-separated tokens, quoted phrases. 3–128 characters (no minimum for `senderEda`). */
    conditionText: string;
};

/** Moves matching incoming messages to a folder. */
export type Rule = {
    ruleId: string;
    ruleName: string;
    enableRule: boolean;
    directory?: { label?: string; [key: string]: unknown };
    conditions: RuleCondition[];
    [key: string]: unknown;
};

export type RuleList = {
    total?: number;
    rules?: Rule[];
    [key: string]: unknown;
};

export type RuleInput = {
    ruleName: string;
    enableRule: boolean;
    conditions: RuleCondition[];
    directoryLabel: string;
    directoryId?: string;
};

/** A full rule, a toggle, or a move up (`-1`) / down (`1`). */
export type RulePatch = RuleInput | { enableRule: boolean } | { moveOrder: -1 | 1 };

export type ReferenceRegistry = "pesel" | "regon" | "krs" | "nip" | "ue" | "kppId";

export type SearchCategory =
    | "INDIVIDUAL"
    | "ADVOCATE"
    | "LEGAL_ADVISOR"
    | "TAX_ADVISOR"
    | "RESTRUCTURING_ADVISOR"
    | "PATENT_ATTORNEY"
    | "NOTARY"
    | "COUNSELLOR_OF_GCRP"
    | "PUBLIC_INSTITUTION"
    | "COURT_ENFORCEMENT_OFFICER"
    | "COMPANY"
    | "ORGANISATION"
    | (string & {});

export type SearchAddress = {
    countryCode: string;
    city: string;
    street?: string;
    buildingNumber?: string;
    flatNumber?: string;
    /** `NN-NNN` */
    postalCode?: string;
};

export type BaeSearchRequest = {
    /** Searcher's own address; the official client always sends it. */
    senderEda?: string;
    recipientEdasOnly: boolean;
    recipientEdas?: string[];
    name?: string;
    surname?: string;
    entityName?: string;
    officialIds?: { id: string; referenceRegistry: ReferenceRegistry }[];
    searchCategory?: SearchCategory[];
    searchByParentIds?: boolean;
    address?: SearchAddress[];
    offset?: number;
    limit?: number;
};

export type EdaStatus =
    | "ACTIVE"
    | "CLOSED_RECOVERABLE"
    | "CLOSED_UNRECOVERABLE"
    | "STRUCK_OFF"
    | "RESERVED"
    | (string & {});

export type RecipientEda = {
    recipientEda: string;
    edaStatus: EdaStatus;
    /** Do not send to an address with a `BLOCK_WARNING`. */
    warning?: { type: "NOT_BLOCK_WARNING" | "BLOCK_WARNING"; description?: string };
    /** Truthy for the public service (designated operator), otherwise a qualified one. */
    designatedOperator?: boolean | "Y" | "N";
    dateOfEnteringToBAE?: string;
    dateOfRemovalFromBAE?: string;
    additionalServiceOW?: { activationDate?: string; resignationDate?: string };
    [key: string]: unknown;
};

export type BaeSubjectData = {
    /** `1` is the current record, higher values are archived ones. */
    index: number;
    isPublic?: boolean;
    professionalTitle?: string;
    legalForm?: string;
    entityName?: string;
    name?: string;
    surname?: string;
    officialIds?: { id: string; referenceRegistry: string }[];
    address?: (Partial<SearchAddress> & {
        addressType?: ("correspondence" | "headquarters")[];
        postOfficeBox?: string;
        postalOffice?: string;
    })[];
    [key: string]: unknown;
};

export type BaeSearchResponse = {
    totalResults?: number;
    baeSearchResponses?: { recipientEda?: RecipientEda; baeSearchData?: BaeSubjectData[] }[];
    [key: string]: unknown;
};

export type EdaSearchResponse = {
    edaSearchResponses?: {
        recipientEda?: RecipientEda;
        recipient?: { entityName?: string; name?: string; surname?: string; officialIds?: unknown[] };
    }[];
    [key: string]: unknown;
};

export type KppSearchRequest = {
    phrase: string;
    phraseAttributes?: string[];
    status?: "ACTIVE";
    publicType?: "PUBLIC";
    score?: number;
};

export type KppOrganization = {
    fullName: string;
    /** The entity's e-Delivery address. */
    deliveryAddress?: string;
    epuapAddress?: string;
    adeObligationStatus?: "MANDATORY" | "OPTIONAL";
    publicIdentifiers?: { type: string; value: string }[];
    addresses?: {
        purpose?: string;
        street?: string;
        buildingNumber?: string;
        flatNumber?: string;
        postalCode?: string;
        locality?: string;
        countryCode?: string;
    }[];
    [key: string]: unknown;
};

export type KppSearchResponse = {
    organizations?: { businessdata: KppOrganization }[];
    [key: string]: unknown;
};

export type TerytItem = {
    id: string;
    name: string;
    type?: string;
    [key: string]: unknown;
};

export type PredefinedRole = "owner" | "admin" | "operator" | "operatorreader";
export type PermissionScope = "read_messages" | "write_messages" | (string & {});

export type PmUser = {
    userId: string;
    name: string;
    surname: string;
    email?: string;
    registerId: string;
    referenceRegistry: "pesel" | "eu";
    status: "ACTIVE" | "CONFIRMATION_READY" | "INACTIVE";
    invitationMessage?: string;
    [key: string]: unknown;
};

export type PmUserWithRoles = {
    user: PmUser;
    roles?: { roles: { roleName: string }[] };
};

export type PmUsers = {
    usersData?: PmUserWithRoles[];
    [key: string]: unknown;
};

export type InvitationInput = {
    roles: string[];
    name: string;
    surname: string;
    email: string;
    referenceRegistry: "pesel" | "eu";
    registerId: string;
    invitationMessage?: string;
};

export type PendingInvitation = {
    ownerName?: string;
    roles?: string[];
    invitationMessage?: string;
    [key: string]: unknown;
};

export type PmRoles = {
    roles?: { roleName: string; predefinedRole: boolean; description?: string }[];
    [key: string]: unknown;
};

export type RoleDetails = {
    roleName: string;
    description?: string;
    permissions: { resource: string; name?: string; scopes: PermissionScope[]; predefinedResource?: boolean }[];
    assignedUsers?: { userId: string; name?: string; surname?: string }[];
    [key: string]: unknown;
};

export type RoleInput = {
    roleName: string;
    description?: string;
    permissions: { resource: string; scopes: PermissionScope[] }[];
};

export type PmPermissions = {
    resources?: {
        resource: string;
        name?: string;
        resourcePermissions: { scope: PermissionScope; roles: string[] }[];
    }[];
    [key: string]: unknown;
};

export type DirectoryInput = {
    /** Uppercase, 3–30 characters. */
    directoryName: string;
    /** Uppercase, 3–30 characters, unique and immutable. */
    directoryLabel: string;
    /** Custom roles only. */
    permissions: { roleName: string; scopes: PermissionScope[] }[];
};

export type PmMailboxDetails = {
    context?: string;
    ownerName?: string;
    resourceStatus?: "active" | "suspended" | "closed";
    additionalData?: string;
    admins?: {
        name: string;
        surname: string;
        referenceRegistry: "pesel" | "eu";
        registerId: string;
        roleName: string;
    }[];
    [key: string]: unknown;
};

export type PmSystem = {
    systemId: string;
    systemName: string;
    description?: string;
    /** Base64 DER. */
    certificate?: string;
    certificateRemovalDate?: string;
    [key: string]: unknown;
};

/** Exactly one of `csr` and `qualifiedCertificate`, each a base64-encoded PEM. */
export type SystemInput = {
    systemName: string;
    description?: string;
    csr?: string;
    qualifiedCertificate?: string;
    roles: string[];
};

export type MailboxContext =
    | "PublicEntity"
    | "CitizenEntity"
    | "EntrepreneurEntity"
    | "PublicTrustProfessionEntity"
    | "NonPublicNonNaturalPersonEntity"
    | (string & {});

export type DiscoveryAddress = {
    eDeliveryAddress: string;
    userRole?: string;
    context?: MailboxContext;
    EDAStatus?: "RESERVED" | "ACTIVE" | "CLOSED_RECOVERABLE" | "CLOSED_UNRECOVERABLE" | (string & {});
    EDARelationshipStatus?: "ACTIVE" | "ACTIVATION_READY" | "CONFIRMATION_READY" | "INACTIVE" | (string & {});
    EDADescription?: string;
    validTo?: string;
    /** e.g. `"ePUAP"` */
    additionalData?: string;
    legalForm?: string;
    organizationEpuapId?: string;
    organizationFullName?: string;
    gracePeriodEndDate?: string;
    deletionDate?: string;
    uaApiUrl?: string;
    oidcApiUrl?: string;
    providerName?: string;
    [key: string]: unknown;
};

export type AddressStatus = {
    addressStatus?: string;
    isGracePeriod?: boolean;
    isReopenAllowed?: boolean;
    assigmentDegree?: unknown;
    disclosureStatus?: "EXPOSED" | "UNDISCLOSED";
    designatedOperator?: "Y" | "N";
    entityType?: "PUBLIC_ENTITY" | "PRIVATE_ENTITY";
    subContext?: string;
    [key: string]: unknown;
};

export type EdaOperationName =
    | "CLOSURE"
    | "MODIFICATION"
    | "REOPEN"
    | "DISCLOSURE"
    | "REGISTRATION"
    | "TRANSFER_TO_KDU"
    | "TRANSFER_TO_OW"
    | "STARTING_BANKRUPTCY_PROCEEDINGS"
    | "ENDING_BANKRUPTCY_PROCEEDINGS"
    | "GRANTING_ACCESS"
    | "GRANTING_ACCESS_COURT_RULING_OR_ADMINISTRATIVE_ACT"
    | "REVOKING_ACCESS_COURT_RULING_OR_ADMINISTRATIVE_ACT"
    | "CLOSURE_ACT";

/** Electronic address registry application (partial shape), signed afterwards at `signingUrl`. */
export type EdaOperationRequest = {
    operationName: EdaOperationName;
    eDeliveryAddress?: string;
    entityType: string;
    isMainEda: boolean;
    callbackUrl: string;
    attachments: string[];
    sender?: { email: string; name: string; surname: string; pesel?: string; euid?: string; senderRole: string };
    [key: string]: unknown;
};

export type SubmittedRequest = {
    requestId: number | string;
    requestType?: string;
    requestStatus?: "REJECTED" | "VERIFIED" | (string & {});
    timestamp?: string;
    edeliveryAddress?: string;
    [key: string]: unknown;
};

export type MenuRequest = {
    context: "EDOR" | "OBYWATEL";
    system: "E_DORECZENIA";
};
