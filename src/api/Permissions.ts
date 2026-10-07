import { API, type ClientName } from "../constants.js";
import type {
    DirectoryInput,
    InvitationInput,
    PendingInvitation,
    PmMailboxDetails,
    PmPermissions,
    PmRoles,
    PmSystem,
    PmUsers,
    PmUserWithRoles,
    RoleDetails,
    RoleInput,
    SystemInput,
} from "../types/Admin.js";
import type { ApiContext, Query } from "./Transport.js";

/*
 * Mailbox permission management, as in the MU app. It uses `edor-mu` tokens bound to a single
 * mailbox (`session.authorize("mu", { ade })`), except for invitations, which the official
 * mailbox calls with an `edor-app` token. MU does not offer systems for `CitizenEntity` mailboxes.
 */

type Json = Record<string, unknown>;

export class PermissionsApi {
    constructor(
        private readonly context: ApiContext,
        private readonly client: ClientName = "mu"
    ) {}

    private get transport() {
        return this.context.transport;
    }

    private address(ade?: string) {
        return ade ?? this.context.mailbox().eDeliveryAddress;
    }

    private mailboxPath(ade?: string) {
        return `/manage/addresses/${this.address(ade)}`;
    }

    private get<T = Json>(op: string, path: string, query?: Query, client = this.client) {
        return this.transport.json<T>({ op, client, url: `${API.pm}${path}`, query });
    }

    private send<T = Json>(op: string, method: string, path: string, body?: unknown, client = this.client) {
        return this.transport.json<T>({ op, client, method, url: `${API.pm}${path}`, body });
    }

    details(ade?: string) {
        return this.get<PmMailboxDetails>("pmAddressDetails", `${this.mailboxPath(ade)}/details`);
    }

    /** Permissions of the signed-in user in the mailbox. */
    myPermissions(ade?: string) {
        return this.get<PmPermissions>("pmAddressPermissions", `${this.mailboxPath(ade)}/permissions`);
    }

    createAddress(body: Json) {
        return this.send("pmAddressCreate", "POST", "/addresses", body);
    }

    updateAddresses(body: Json) {
        return this.send("pmAddressesPatch", "PATCH", "/addresses", body);
    }

    deleteAddress(ade?: string) {
        return this.send("pmAddressDelete", "DELETE", `/addresses/${this.address(ade)}`);
    }

    changeAdmin(body: Json, ade?: string) {
        return this.send("pmAddressAdminPatch", "PATCH", `/addresses/${this.address(ade)}/admin`, body);
    }

    addAdmin(body: Json, ade?: string) {
        return this.send("pmUsersAdminPost", "POST", `/addresses/${this.address(ade)}/users/admin`, body);
    }

    removeAdmin(ade?: string) {
        return this.send("pmUsersAdminDelete", "DELETE", `/addresses/${this.address(ade)}/users/admin`);
    }

    users(query: { roleName?: string } = {}, ade?: string) {
        return this.get<PmUsers>("pmUsers", `${this.mailboxPath(ade)}/users`, query);
    }

    user(userId: string, ade?: string) {
        return this.get<PmUserWithRoles>("pmUser", `${this.mailboxPath(ade)}/users/${encodeURIComponent(userId)}`);
    }

    userRoles(userId: string, ade?: string) {
        return this.get("pmUserRoles", `${this.mailboxPath(ade)}/users/${encodeURIComponent(userId)}/roles`);
    }

    /** `{ roles: [] }` revokes access, which is how the official UI does it. */
    setUserRoles(userId: string, body: { roles: string[] }, ade?: string) {
        return this.send("pmUserRolesPatch", "PATCH", `${this.mailboxPath(ade)}/roles/users/${encodeURIComponent(userId)}`, body);
    }

    removeUser(userId: string, ade?: string) {
        return this.send("pmUserDelete", "DELETE", `${this.mailboxPath(ade)}/users/${encodeURIComponent(userId)}`);
    }

    /** The signed-in user's own data, e.g. contact details. */
    updateMe(body: Json) {
        return this.send("pmUsersPatch", "PATCH", "/users", body);
    }

    /** Invitation waiting for the signed-in user; empty when there is none. */
    invitations(ade?: string) {
        return this.get<PendingInvitation>(
            "pmInvitations",
            `/invitation/addresses/${this.address(ade)}`,
            undefined,
            "app"
        );
    }

    answerInvitation(body: { accepted: boolean }, ade?: string) {
        return this.send(
            "pmInvitationAnswer",
            "POST",
            `/invitation/addresses/${this.address(ade)}`,
            body,
            "app"
        );
    }

    invite(body: InvitationInput, ade?: string) {
        return this.send("pmInvite", "POST", `${this.mailboxPath(ade)}/users/invitation`, body, "app");
    }

    cancelInvitation(userId: string, ade?: string) {
        return this.send(
            "pmInvitationDelete",
            "DELETE",
            `${this.mailboxPath(ade)}/users/invitation/${encodeURIComponent(userId)}`,
            undefined,
            "app"
        );
    }

    roles(ade?: string) {
        return this.get<PmRoles>("pmRoles", `${this.mailboxPath(ade)}/roles`);
    }

    role(roleName: string, ade?: string) {
        return this.get<RoleDetails>("pmRole", `${this.mailboxPath(ade)}/roles/${encodeURIComponent(roleName)}`);
    }

    initialRolePermissions(ade?: string) {
        return this.get<PmPermissions>("pmInitialRolePermissions", `${this.mailboxPath(ade)}/initial-role-permissions`);
    }

    createRole(body: RoleInput, ade?: string) {
        return this.send("pmRoleCreate", "POST", `${this.mailboxPath(ade)}/roles`, body);
    }

    updateRole(roleName: string, body: RoleInput, ade?: string) {
        return this.send("pmRoleUpdate", "PATCH", `${this.mailboxPath(ade)}/roles/${encodeURIComponent(roleName)}`, body);
    }

    deleteRole(roleName: string, ade?: string) {
        return this.send("pmRoleDelete", "DELETE", `${this.mailboxPath(ade)}/roles/${encodeURIComponent(roleName)}`);
    }

    systems(ade?: string) {
        return this.get<{ systemsData?: PmSystem[] }>("pmSystems", `${this.mailboxPath(ade)}/systems`);
    }

    system(systemId: string, ade?: string) {
        return this.get<{ system: PmSystem }>("pmSystem", `${this.mailboxPath(ade)}/systems/${encodeURIComponent(systemId)}`);
    }

    systemRoles(systemId: string, ade?: string) {
        return this.get("pmSystemRoles", `${this.mailboxPath(ade)}/systems/${encodeURIComponent(systemId)}/roles`);
    }

    /**
     * Registers an API integration with exactly one of `csr` and `qualifiedCertificate`, usually
     * with `roles: ["operator"]`. Its client id becomes `<ADE>.SYSTEM.<NAME>`.
     */
    createSystem(body: SystemInput, ade?: string) {
        return this.send<{ systemId: string }>("pmSystemCreate", "POST", `${this.mailboxPath(ade)}/systems`, body);
    }

    updateSystem(systemId: string, body: SystemInput, ade?: string) {
        return this.send("pmSystemUpdate", "PATCH", `${this.mailboxPath(ade)}/systems/${encodeURIComponent(systemId)}`, body);
    }

    deleteSystem(systemId: string, ade?: string) {
        return this.send("pmSystemDelete", "DELETE", `${this.mailboxPath(ade)}/systems/${encodeURIComponent(systemId)}`);
    }

    /** MU reads folders from UA API v3. */
    directories(ade?: string) {
        return this.transport.json<Json[]>({
            op: "pmDirectories",
            client: this.client,
            url: `${API.uaapi}/${this.address(ade)}/directories`,
        });
    }

    /** Name and label are uppercased; the label is unique and cannot change later. */
    createDirectory(body: DirectoryInput, ade?: string) {
        return this.send("pmDirectoryCreate", "POST", `${this.mailboxPath(ade)}/directories`, {
            ...body,
            directoryName: body.directoryName.trim().toUpperCase(),
            directoryLabel: body.directoryLabel.trim().toUpperCase(),
        });
    }

    updateDirectory(directoryId: string, body: DirectoryInput, ade?: string) {
        return this.send("pmDirectoryUpdate", "PUT", `${this.mailboxPath(ade)}/directories/${encodeURIComponent(directoryId)}`, body);
    }

    /** The folder has to be empty. */
    deleteDirectoryByLabel(directoryLabel: string, ade?: string) {
        return this.send(
            "pmDirectoryDelete",
            "DELETE",
            `${this.mailboxPath(ade)}/directories/${encodeURIComponent(directoryLabel)}`
        );
    }

    /** Deletes by id through UA API v3, as MU does. */
    deleteDirectory(directoryId: string, ade?: string) {
        return this.transport.json<unknown>({
            op: "pmDirectoryDeleteById",
            client: this.client,
            method: "DELETE",
            url: `${API.uaapi}/${this.address(ade)}/directories/${encodeURIComponent(directoryId)}`,
        });
    }
}
