# edoreczenia

Unofficial TypeScript client for [e-Doręczenia](https://edoreczenia.gov.pl), the Polish public electronic delivery service. It signs in through login.gov.pl with the mObywatel QR code and gives typed access to the mailbox: messages, drafts and sending, evidences, ePUAP letters, settings and webhooks, address search, permissions and the dashboard.

> [!WARNING]
> This is not an official client. It talks to the same endpoints as the official web apps, and those can change without notice.
>
> Opening an unopened message **confirms its delivery, with legal effect**. Read [Receipt guard](#receipt-guard) before you touch message content.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Signing in](#signing-in)
- [Session](#session)
- [Client](#client)
- [Messages](#messages)
- [Drafts and sending](#drafts-and-sending)
- [ePUAP letters](#epuap-letters)
- [Settings and webhooks](#settings-and-webhooks)
- [Address search](#address-search)
- [Permissions](#permissions)
- [Dashboard](#dashboard)
- [Errors](#errors)
- [Utilities](#utilities)
- [Low-level API](#low-level-api)
- [Security notes](#security-notes)
- [Development](#development)

## Features

- QR sign-in with mObywatel, either in one call or as resumable phases with plain JSON state.
- Automatic token refresh, with SSO fallback across the three Keycloak clients.
- A receipt guard that refuses to open unopened messages unless you say so explicitly.
- Typed models based on the UA API 3.0.8 specification and the official apps.
- No runtime dependencies, only web-standard APIs: `fetch`, Web Crypto, `TextEncoder`, `btoa` / `atob`, `structuredClone`, `WebSocket`.

## Requirements

- Node.js 20 or newer, or another runtime with the same global web APIs.
- For the QR confirmation step, a `WebSocket` that can send custom headers. The global `WebSocket` of Node.js and Bun can; in other runtimes, provide your own connector (see [WebSocket connector](#websocket-connector)).

The library is server-side only. Browsers cannot send the cookies the login chain needs, and the government endpoints do not allow cross-origin calls.

## Installation

```sh
npm install edoreczenia
```

The package is ESM-only and ships its own type definitions.

## Quick start

```ts
import { EdoClient, loginWithQr } from "edoreczenia";

const session = await loginWithQr({
    onQr: (qr) => showToUser(qr.image), // data:image/png;base64,…
});

await session.selectMailbox();

const edo = new EdoClient({ session });

const { messages = [] } = await edo.messages.list({ label: "INBOX" });
for (const message of messages) {
    console.log(message.messageMetadata?.subject, message.messageControlData?.opened);
}

// Safe: the message is already opened, so this has no legal effect.
const opened = messages.find((message) => message.messageControlData?.opened);
if (opened) {
    const full = await edo.messages.get(opened);
    console.log(full.textBody);
}
```

## Concepts

### Clients and tokens

e-Doręczenia uses one Keycloak realm with three OIDC clients that share a single SSO session:

| Client      | Keycloak client  | Used for                                                    |
| ----------- | ---------------- | ----------------------------------------------------------- |
| `dashboard` | `edor-dashboard` | Signing in, the user's addresses, the address registry      |
| `app`       | `edor-app`       | The mailbox: messages, drafts, settings, search             |
| `mu`        | `edor-mu`        | Permission management: users, roles, systems, folders       |

Signing in yields a `dashboard` token. `app` and `mu` tokens are bound to one mailbox and are obtained through SSO, without the user. `EdoSession` handles this on demand.

### Mailbox

A mailbox is identified by its electronic delivery address (ADE, e.g. `AE:PL-12345-67890-ABCDE-12`) together with the organization's ePUAP id:

```ts
type MailboxRef = { eDeliveryAddress: string; organizationEpuapId: string };
```

`session.selectMailbox()` picks one and gets an `app` token for it. Alternatively, pass `mailbox` to `EdoClient` yourself.

### Receipt guard

Fetching a message in a `full` format is what the official mailbox does when you open it, and the specification defines reading the same way. For a received message that has not been opened yet, this confirms delivery, with the date of the call as the date of receipt.

Every method that can do this goes through `assertReadable`. Without `acknowledgeReceipt: true` it allows only:

- list items with `messageControlData.opened === true`,
- list items labelled `SENT`.

A bare message id is refused, because its state is unknown. Refusals throw `ReceiptGuardError` before any request is sent.

```ts
await edo.messages.get(item); // throws ReceiptGuardError if `item` is unopened
await edo.messages.get(item, { acknowledgeReceipt: true }); // opens it, with legal effect
await edo.messages.get(item, { format: "metadata" }); // never a read, no guard
```

Listing messages (`format=metadata`) never changes `opened` or `receiptDate`.

## Signing in

### One call

```ts
import { loginWithQr } from "edoreczenia";

const session = await loginWithQr({
    onQr: (qr) => render(qr.image),
    onChoice: (options) => options[0]!.id,
    onState: (state) => saveLoginState(state),
    qrRefreshes: 2,
});
```

| Option        | Description                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `onQr`        | Required. Called with every QR code to show, including automatic replacements.                              |
| `onChoice`    | Picks an option when ePUAP asks for a decision, e.g. person or company context. Without it, a choice throws `FlowHalt`. |
| `onState`     | Called with the login state after each phase.                                                                |
| `qrRefreshes` | How many times an expired QR code is replaced. Default `2`, about 15 minutes in total.                       |
| `signal`      | `AbortSignal` that cancels waiting for the confirmation.                                                     |
| `connect`     | Custom [WebSocket connector](#websocket-connector).                                                          |
| `userAgent`   | User agent sent along the login chain. Defaults to a desktop Chrome.                                        |
| `fetch`       | Custom `fetch` implementation.                                                                               |
| `onTrace`     | Receives [trace entries](#tracing-and-flowhalt) as they are recorded.                                        |

### QR code

```ts
type QrCode = {
    token: string; // binds the status channel; do not log it
    image: string; // data:image/png;base64,…
    deeplink: string; // mobywatel://app/institutions?qrCode=… — opens the app on the same device
    topic: string;
    expiresAt: number; // epoch ms; a code is valid for 5 minutes (QR_TTL_MS)
};
```

On a phone, show a link to `deeplink` instead of the image.

### Phases

The flow can be split across requests or processes. Each phase takes and returns a `LoginState`, which is plain JSON:

```ts
import { awaitQrConfirmation, completeLogin, refreshQr, startQrLogin } from "edoreczenia";

// 1. Keycloak → ePUAP → login.gov.pl → mObywatel, ending with a QR code.
const { state, qr, entries } = await startQrLogin();

// 2. Waits until the user confirms in the mObywatel app. Throws QrExpiredError after 5 minutes.
const confirmation = await awaitQrConfirmation(state);

// 3. SAML artifact → ePUAP → Keycloak → tokens.
let result = await completeLogin(state, { confirmation });
while (result.kind === "choice") {
    const picked = await askUser(result.options); // [{ id: "0", label: "Osoba" }, …]
    result = await completeLogin(result.state, { choice: picked.id });
}

const session = result.session;
```

| Function                                       | Description                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `startQrLogin(options?)`                       | Runs the chain up to the QR code. Returns `{ state, qr, entries }`, where `entries` are the login.gov.pl methods. Accepts `userAgent`, `fetch`, `onTrace` and `method` (default `"MOBILE_ID"`, the only automated one). |
| `refreshQr(state, options?)`                   | New QR code in the same mObywatel session. Returns `{ state, qr }`.                                         |
| `awaitQrConfirmation(state, options?)`         | Waits on the status channel. Accepts `signal`, `timeoutMs` (default: until the code expires), `connect` and `maxReconnects` (default `5`). |
| `completeLogin(state, input, options?)`        | `input` is `{ confirmation }` after step 2, or `{ choice }` to answer a previous `kind: "choice"` result. Returns `{ kind: "done", session }` or `{ kind: "choice", state, options }`. |

> [!IMPORTANT]
> `LoginState` contains cookies and the PKCE verifier. Store it like a password.

### WebSocket connector

The confirmation arrives over a SockJS/STOMP websocket that only works with the cookies set earlier in the chain. The default connector passes them as `new WebSocket(url, { headers })`, which Node.js and Bun support. Elsewhere, pass a function that opens the socket with the given headers and resolves once it is open:

```ts
type WebSocketConnector = (url: URL, headers: Headers) => Promise<WebSocket>;
```

The returned object needs `send`, `close` and `addEventListener` for `message` (with string `event.data`), `close` and `error`. For example, with the [`ws`](https://www.npmjs.com/package/ws) package:

```ts
import WebSocket from "ws";
import type { WebSocketConnector } from "edoreczenia";

const connect: WebSocketConnector = (url, headers) =>
    new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers: Object.fromEntries(headers) });
        socket.once("open", () => resolve(socket as unknown as globalThis.WebSocket));
        socket.once("error", reject);
    });

await loginWithQr({ onQr, connect });
```

### Tracing and FlowHalt

The login chain crosses four domains and several auto-submitted forms. When a response does not match what the flow expects, it stops with a `FlowHalt`, without trying to work around it:

```ts
try {
    await loginWithQr({ onQr });
} catch (error) {
    if (error instanceof FlowHalt) {
        console.error(error.step, error.reason);
        console.table(error.trace);
    }
}
```

Trace entries contain only hosts, paths, statuses, content types and cookie or field *names*, never values, so they are safe to log. Pass `onTrace` to receive them live.

## Session

`EdoSession` holds the tokens of all three clients, the Keycloak SSO cookies and the selected mailbox.

```ts
const token = await session.accessToken("app"); // refreshed when needed
```

Tokens are renewed in this order:

1. Use the access token while it is valid (minus a 30-second margin).
2. Use the refresh token. Access tokens live 5 minutes, refresh tokens 30 minutes of inactivity.
3. Use the SSO cookies to get new tokens without the user.
4. Throw `SessionExpiredError`; the user has to scan a QR code again.

Concurrent renewals of the same client share one request.

### Persistence

The state is plain JSON. To save it after every change, recreate the session with `onChange`:

```ts
let session = await loginWithQr({ onQr });
session = EdoSession.fromJSON(session.toJSON(), {
    onChange: (data) => db.save("session", data),
});

// later, in another process
const restored = EdoSession.fromJSON(await db.load("session"), {
    onChange: (data) => db.save("session", data),
});
```

> [!IMPORTANT]
> Session data gives full access to the user's official mail. Encrypt it at rest.

To keep the session alive without the user, call `keepAlive()` periodically, for example at `nextRefreshAt()`:

```ts
const { refreshed, expired } = await session.keepAlive();
const next = session.nextRefreshAt(); // epoch ms, or null when nothing can be refreshed
```

### Reference

| Member                               | Description                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `new EdoSession(data, options?)`     | Creates a session from `SessionData`.                                                            |
| `EdoSession.fromJSON(data, options?)`| Same, on a deep copy of `data`.                                                                   |
| `toJSON()`                           | `SessionData`: `{ userAgent, jar, tokens, mailbox }`.                                            |
| `mailbox`                            | Selected `MailboxRef`, or `null`.                                                                 |
| `userAgent`                          | User agent used for token and SSO requests.                                                       |
| `accessToken(client, { forceRefresh })` | Valid access token of a client.                                                                |
| `renew(client)`                      | Forces a renewal and returns the new `TokenSet`.                                                  |
| `authorize(client, { ade })`         | Gets tokens through SSO, e.g. `app` for another mailbox. Throws `SessionExpiredError` without SSO. |
| `tokens(client)`                     | Current `TokenSet`, or `null`.                                                                     |
| `claims(client)`                     | Decoded access token claims (not verified). Typed for `app` and `dashboard`.                     |
| `listMailboxes()`                    | Mailboxes the user can access.                                                                     |
| `selectMailbox(ade?)`                | Selects a mailbox and gets an `app` token. Without `ade`, selects the only mailbox, or throws `ApiError` with code `ambiguous (n mailboxes)`. |
| `isAlive(now?)`                      | Whether any token is still usable or refreshable.                                                 |
| `nextRefreshAt()`                    | When the next token needs refreshing.                                                              |
| `keepAlive()`                        | Renews tokens close to expiry. Returns `{ refreshed, expired }`.                                  |
| `logout()`                           | Logs out of Keycloak for every client and clears the state.                                       |

| Option            | Description                                     |
| ----------------- | ----------------------------------------------- |
| `onChange`        | Called with `SessionData` after every change.   |
| `refreshMarginMs` | Refresh this long before expiry. Default 30 s.  |
| `fetch`           | Custom `fetch`.                                 |
| `onTrace`         | Trace sink for SSO requests.                    |

## Client

```ts
const edo = new EdoClient({ session });
```

| Option             | Description                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `session`          | An `EdoSession`.                                                                                |
| `tokens`           | Any `{ accessToken(client, { forceRefresh }) }` provider, instead of a session.                 |
| `mailbox`          | Mailbox to operate on. Defaults to `session.mailbox`.                                           |
| `service`          | Default `service` filter of lists and counters: `"All"` (default), `"eDelivery"` or `"ePUAP"`.  |
| `userAgent`        | Sent with API requests. Defaults to the session's.                                              |
| `fetch`            | Custom `fetch`.                                                                                 |
| `maxDownloadBytes` | Download size limit. Default 100 MB.                                                            |

`edo.mailbox` returns the mailbox in use and throws `EdoError` when none is selected.

The modules are `edo.messages`, `edo.drafts`, `edo.epuap`, `edo.settings`, `edo.search`, `edo.permissions` and `edo.dashboard`. All of them authenticate with bearer tokens only, and retry once with a refreshed token after a `401`.

When you pass `tokens` instead of a session, everything works except the parts that read token claims: `epuap.downloadServletFile` and the `dashboard` defaults that use the user's PESEL.

Downloads resolve to a `FileResult`:

```ts
type FileResult = { bytes: Uint8Array; contentType: string; filename: string | null };
```

## Messages

### Lists

```ts
const page = await edo.messages.list({ label: "INBOX", limit: 50, opened: false });

for await (const message of edo.messages.iterate({ label: "SENT", maxItems: 200 })) {
    // …
}
```

`list` follows the official mailbox's defaults: 20 items, newest first, `INBOX` sorted by `receiptDate` and `SENT` by `submissionDate`, with mass messages grouped outside `INBOX` and `TRASH`.

| Method                       | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `list(query?)`               | One page of messages (metadata only).                                       |
| `iterate(query?)`            | Async iterator over all pages; stops after `maxItems` if given.             |
| `folders(service?)`          | Predefined and custom folders with counters.                                |
| `threads(query?)`            | Threads, newest first.                                                       |
| `thread(threadId, query?)`   | Messages of a thread (metadata).                                             |

`MessageListQuery` supports `label`, `offset`, `limit`, `sortColumn`, `sortDirection`, `massMessagesGrouped`, `massMessageId`, `sender`, `recipient`, `subject`, date ranges (`submissionDateFrom/To`, `receiptDateFrom/To`, `eventDateFrom/To`), `attachments`, `opened`, `shippingService` and `service`.

### Content

All of these go through the [receipt guard](#receipt-guard) and accept `{ acknowledgeReceipt: true }`.

| Method                                                | Description                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `get(ref, { format })`                                | One message. `format`: `"full"` (default), `"fullExtended"` (with attachment contents), `"metadata"`, `"minimal"`. Only the `full` formats are guarded. |
| `downloadAttachment(ref, attachmentId)`               | Attachment file, downloaded the way the official UI does.                        |
| `getAttachment(ref, attachmentId)`                    | Attachment file through the mailbox API.                                         |
| `attachmentVisualization(ref, attachmentId)`          | HTML rendering of an attachment.                                                 |
| `downloadArchive(ref)`                                | The whole message as a ZIP: text, attachments and evidences.                    |

`getMany(messageIds, format?)` fetches up to 50 messages at once and is **not guarded**: `full` formats open all of them.

A message whose content is still being prepared (HTTP 202) throws `ApiError` with code `pending:<status>`; try again later.

Helpers for message references:

| Function                    | Description                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `assertReadable(ref, opts)` | Returns the id if reading is safe, otherwise throws `ReceiptGuardError`. |
| `messageIdOf(ref)`          | Message id of a list item or id.                                 |
| `labelsOf(message)`         | Uppercased labels and locations of a message.                   |
| `isEpuapMessage(ref)`       | Whether a message comes from ePUAP (numeric id).                |

### Evidences

| Method                                    | Description                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `evidences(query?)`                       | Evidences of all messages in the mailbox. `{ downloaded: false }` makes syncing easy. |
| `messageEvidences(messageId, query?)`     | Evidences of one message, without reading its content.                              |
| `evidence(evidenceId)`                    | Metadata of one evidence.                                                            |
| `downloadEvidence(evidence, kind?)`       | Evidence file. `kind`: `"purde"` (electronic, default) or `"puh"` (hybrid).          |
| `downloadHybridReceipt(messageId)`        | Proof of receipt of a hybrid shipment (`H.EPO`).                                     |
| `downloadTechnicalEvidences(messageId)`   | All technical evidences as a ZIP.                                                    |

Evidence types: `BP.WP` / `BP.WX` are proofs of sending (PDF / XML), `BP.OP` / `BP.OX` proofs of receipt, `H.PN`, `H.EPO` and `H.DW` the hybrid posting, receipt and non-delivery, and `A.1`, `A.2`, `D.1`, `E.1`, `E.2` technical evidences.

### Organizing

| Method                                 | Description                                                   |
| -------------------------------------- | ------------------------------------------------------------- |
| `moveToTrash(ids)`                     | Adds the `TRASH` label.                                       |
| `restoreFromTrash(ids)`                | Removes the `TRASH` label.                                    |
| `move(ids, folderLabel)`               | Moves to a folder.                                            |
| `patchLabels(ids, patch)`              | Raw label patch: `[{ op: "add" \| "remove", path: "labels", value }]`. |
| `deletePermanently(ids)`               | Deletes for good. The official mailbox allows it only from the trash. |
| `directories()`                        | Folders.                                                      |
| `createDirectory(name, label?)`        | New folder, name up to 30 characters.                         |
| `renameDirectory(directoryId, name)`   | Renames a folder.                                             |
| `deleteDirectory(directoryId)`         | Deletes a folder.                                             |

`ids` is a single id or an array.

The official UI creates folders through the permissions API instead, which also sets role access; see [`permissions.createDirectory`](#permissions).

### Archives

For messages too large to download one by one (error `UAAPI0174`, over 15 MB), order a ZIP archive:

```ts
const { taskId } = await edo.messages.createArchiveTask(["PPSA-1", "PPSA-2"], "2026 correspondence");
const { tasks } = await edo.messages.archiveTasks({ taskId });
if (tasks?.[0]?.taskStatus === "READY_TO_DOWNLOAD") {
    const zip = await edo.messages.downloadArchiveTask(taskId);
}
```

| Method                                       | Description                                                       |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `archiveTasks(query?)`                       | Archive tasks, newest first.                                      |
| `createArchiveTask(messageIds, description?)`| Orders an archive. Description up to 255 characters.              |
| `changeArchiveTask(taskId, change)`          | `"CANCEL"`, `"FINISH_WITHOUT_DELETING_MESSAGES"` or `"FINISH_WITH_DELETING_MESSAGES"`, which **deletes the messages**. |
| `downloadArchiveTask(taskId)`                | Downloads a ready archive.                                        |

### Direct sending

`send(message)` posts a complete `Message` to the mailbox as defined by the specification, with attachments as base64 in `attachments[].file`. The official web mailbox never does this, so it is untested against the web mailbox API. Prefer [drafts](#drafts-and-sending).

## Drafts and sending

Sending works like in the official client: create a draft, upload the attachments, save the full content, send.

```ts
const { draftId, result } = await edo.drafts.composeAndSend({
    to: ["AE:PL-00000-00000-AAAAA-00"],
    subject: "Wniosek",
    text: "Treść wniosku",
    attachments: [{ filename: "wniosek.pdf", data: pdfBytes }],
});

// Per-recipient outcome: a messageId or an error.
const outcome = await edo.messages.waitForTask(result.messageTaskId!);
```

Sending has legal effect, like posting a registered letter.

### Compose input

| Field         | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `to`          | Recipient addresses, or `Party` objects.                       |
| `subject`     | Up to 255 characters.                                          |
| `text`        | Up to 5000 characters.                                         |
| `attachments` | `UploadFile[]`: `{ data: Blob \| Uint8Array \| ArrayBuffer, filename, contentType? }`. |
| `threadId`    | Thread of the message being replied to.                        |
| `caseId`      | Case of the message being replied to.                          |
| `from`        | Sender `Party`. Defaults to the mailbox address.              |
| `massMessage` | Mass message.                                                  |

Attachments are validated like in the official form before anything is sent. Invalid ones throw `EdoError` with the list of problems.

### Replying

```ts
const reply = edo.drafts.replyTo(original, { text: "Dziękuję za informację." });
await edo.drafts.composeAndSend(reply);
```

`replyTo` addresses the original sender, keeps the thread and case, and prefixes the subject with `RE: `.

### Signed sending

To sign the content with Podpis Zaufany:

```ts
const { draftId } = await edo.drafts.compose(input);
const { uuid, url } = await edo.drafts.sign(draftId, "https://example.com/signed");
// The user signs at `url`. pz.gov.pl then redirects to
// https://example.com/signed?ACTION=signMessage&status=SUCCESS
await edo.drafts.sendSigned(uuid);
```

Single attachments can be signed too: `signAttachment({ attachmentId, messageId, callbackUrl })` returns `{ uuidDocument, signUrl }`, and after signing `attachmentSigned(uuidDocument)` puts the signed file into the draft.

### Reference

| Method                                         | Description                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `compose(input)`                               | Creates a complete draft. Returns `{ draftId, attachments }`.          |
| `composeAndSend(input)`                        | `compose` and `send`. Returns `{ draftId, result }`.                   |
| `send(draftId)`                                | Sends a draft. Returns `{ messageTaskId, warning? }`.                 |
| `sign(draftId, callbackUrl)`                   | Starts signing. Returns `{ uuid, url }`.                              |
| `sendSigned(uuid)`                             | Sends after signing; one message per recipient.                       |
| `replyTo(original, input)`                     | Builds a reply `ComposeInput`.                                        |
| `buildBody(input, attachments?)`               | Builds a raw `DraftBody`.                                             |
| `list(query?)`, `get(draftId, format?)`        | Drafts.                                                               |
| `create(body)`, `update(draftId, body)`        | Raw draft creation and full update.                                   |
| `delete(draftIds)`                             | Deletes drafts.                                                       |
| `attachments(draftId)`                         | Attachments of a draft.                                               |
| `addAttachment(draftId, file, description?)`   | Uploads an attachment.                                                |
| `addAttachmentViaUaApi(draftId, file, description?)` | Uploads through UA API v3, as the official client does when forwarding. |
| `getAttachment(draftId, attachmentId)`         | Downloads a draft attachment.                                         |
| `deleteAttachment(draftId, attachmentId)`, `deleteAllAttachments(draftId)` | Removes attachments.                          |
| `signAttachment(request)`, `attachmentSigned(uuidDocument)` | Signs a single attachment.                               |
| `verifyAttachment({ attachmentId, messageId })`| Verifies signatures of a .pdf or .xml attachment up to 15 MB. An empty array means unsigned. |

## ePUAP letters

The e-Delivery mailbox also holds letters from ePUAP. They have numeric message ids (`isEpuapMessage`), and their content is a base64-encoded `wnio:Dokument` XML.

```ts
import { EpuapXml, base64ToBytes, base64ToUtf8 } from "edoreczenia";

const document = await edo.epuap.document(item);
const xml = base64ToUtf8(document.messageMetadata!.content!);

for (const file of EpuapXml.extractAttachments(xml)) {
    const contentType = EpuapXml.guessContentType(file.format, file.filename);
    const bytes = file.base64 ? base64ToBytes(file.base64) : (await edo.epuap.downloadServletFile(file.url!)).bytes;
}
```

Receiving an ePUAP letter (a list entry with `messageType: "Evidence"`) requires signing an UPD, the official acknowledgement of delivery, with Podpis Zaufany:

```ts
const { uuid, url } = await edo.epuap.sendUpdBack(messageId, "https://example.com/signed");
// the user signs at `url`
await edo.epuap.sendSignedDocument(uuid);
```

| Method                                          | Description                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `document(ref)`                                 | Metadata, base64 XML and attachment list. Guarded.                                 |
| `visualization(ref)`                            | HTML rendering of the document. Guarded.                                           |
| `withUpoAndAttachments(ref)`                    | The official acknowledgement packaged with the original. Guarded.                  |
| `attachment(fileId, buildInAttachment)`         | Attachment bytes, embedded or from the ePUAP file store.                           |
| `downloadServletFile(fileUri, maxBytes?)`       | Non-embedded file from the ePUAP servlet. Needs a session (uses the `TGSID` claim). |
| `sendUpdBack(messageId, callbackUrl, epuapId?)` | Starts receiving a letter by signing its UPD. Legal effect once completed.         |
| `sendSignedDocument(uuid, epuapId?)`            | Finishes a signed send or UPD.                                                      |
| `send(request)`                                 | Sends a general letter (`EpuapSendRequest`). With `signature: true`, returns `{ uuid, url }` for signing first. |
| `uploadFile(file, options?)`                    | Uploads to the ePUAP file store. Returns `{ fileId }`.                             |
| `uploadAttachments(files)`                      | Uploads files and returns ready `zalaczniki` entries for `send`.                   |
| `fileUrl(fileId)`                               | URL of a stored file.                                                               |
| `deleteDocument(ids)`, `deleteFile(fileId)`     | Deletes documents or stored files.                                                  |

A send result with `code: 0` means failure and throws `ApiError` with code `code-0`.

## Settings and webhooks

| Method                                | Description                                                      |
| ------------------------------------- | ---------------------------------------------------------------- |
| `get()`                               | Notification e-mail and mailbox capacity.                        |
| `setNotificationEmail(email)`         | Changes the notification e-mail.                                 |
| `update(patch)`                       | Raw settings patch.                                              |
| `pushNotifications()`, `setPushNotifications(enabled)` | Push notification switch.                       |
| `subscriptions()`                     | Webhook subscriptions.                                           |
| `setSubscription(name, url)`          | Sets the callback URL of one event. Returns `{ subscriptionId }`. |
| `setSubscriptions(urls)`              | Several callback URLs at once.                                   |
| `toggleSubscription(id, enabled)`     | Enables or disables a subscription.                             |
| `deleteSubscriptions()`               | Removes all subscriptions.                                      |
| `rules(query?)`                       | Rules that move incoming messages to folders.                   |
| `createRule(rule)`                    | New rule.                                                        |
| `updateRule(ruleId, patch)`           | Full rule, `{ enableRule }`, or `{ moveOrder: -1 \| 1 }` to reorder. |
| `deleteRule(ruleIds)`                 | Deletes rules.                                                   |
| `countries()`                         | Country names, for hybrid shipments abroad.                     |

### Webhooks

Instead of polling, the mailbox can POST events to your server:

| Event                    | Sent when                                  |
| ------------------------ | ------------------------------------------ |
| `messageCallback`        | A new message arrives.                     |
| `evidenceCallback`       | A new evidence is created.                 |
| `inboxCallback`          | A message is moved from a service to the mailbox. |
| `messageCreatedCallback` | A send task finishes.                      |
| `archiveCreatedCallback` | An archive is ready.                       |

```ts
await edo.settings.setSubscription("messageCallback", "https://example.com/edo/webhook");
```

Callback URLs must use `https` and have no query parameters. In the handler, `parseWebhook(body)` checks the shape and returns a typed `WebhookPayload`:

```ts
import { parseWebhook } from "edoreczenia";

const payload = parseWebhook(await request.json());
console.log(payload.notificationType, payload.notification);
```

## Address search

All search methods are read-only.

```ts
// Is the address active, and can I send to it?
const { baeSearchResponses } = await edo.search.byAddress("AE:PL-00000-00000-AAAAA-00");

// Find an office by name, NIP, REGON, KRS or address.
const { organizations } = await edo.search.publicEntities("Urząd Miasta Gdańska");

// Search the registry.
await edo.search.bae({
    recipientEdasOnly: false,
    entityName: "Kancelaria",
    searchCategory: SEARCH_CATEGORIES.publicTrustProfession,
});
```

| Method                                   | Description                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `bae(request)`                           | Search in the electronic address registry. Sends the own address as `senderEda`, like the official client. |
| `byAddress(ade)`                         | Registry data of one or more addresses.                                            |
| `edas(addresses)`                        | Checks up to 1000 addresses. Do not send to inactive ones or ones with a `BLOCK_WARNING`. |
| `edaConfirmation(ade?)`                  | Confirms address data. Defaults to the own address.                               |
| `publicEntities(phrase, options?)`       | Public entity directory, phrase of 3+ characters.                                  |
| `publicEntitiesCentral(phrase, options?)`| The central directory used by the dashboard; also matches delivery addresses.     |
| `voivodeships()`, `districts(id, search?)`, `communities(id, search?)`, `cities(id, search?)`, `streets(id, search?)` | TERYT dictionaries, from voivodeship down to street. |
| `community(id)`, `city(communityId, id)`, `street(cityId, id)` | Single TERYT entries.                                       |
| `countries()`                            | Countries.                                                                          |

`SEARCH_CATEGORIES` holds the category groups of the official filters: `publicInstitution`, `publicTrustProfession` and `individual`.

## Permissions

Permission management uses `mu` tokens bound to one mailbox; the session obtains them through SSO when first needed. Invitations use the `app` token, like the official mailbox. Methods that act on a mailbox take an optional `ade` as their last argument and default to the selected mailbox.

| Method                                             | Description                                                    |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `details()`                                        | Mailbox owner, status and administrators.                      |
| `myPermissions()`                                  | Permissions of the signed-in user.                             |
| `users({ roleName? })`, `user(userId)`, `userRoles(userId)` | Users with access.                                    |
| `setUserRoles(userId, { roles })`                  | Assigns roles. `{ roles: [] }` revokes access.                 |
| `removeUser(userId)`                               | Removes a user.                                                |
| `invite(input)`, `cancelInvitation(userId)`        | Invites a user by PESEL or EU id.                              |
| `invitations()`, `answerInvitation({ accepted })`  | Invitation waiting for the signed-in user.                    |
| `roles()`, `role(name)`, `initialRolePermissions()`| Roles and their permissions.                                   |
| `createRole(input)`, `updateRole(name, input)`, `deleteRole(name)` | Custom roles.                                  |
| `systems()`, `system(id)`, `systemRoles(id)`       | API integrations with certificates.                            |
| `createSystem(input)`, `updateSystem(id, input)`, `deleteSystem(id)` | Registers an integration with exactly one of `csr` or `qualifiedCertificate`. Not available for `CitizenEntity` mailboxes. |
| `directories()`                                    | Folders.                                                       |
| `createDirectory({ directoryName, directoryLabel, permissions })` | New folder with role access. Name and label are uppercased; the label cannot change later. |
| `updateDirectory(id, input)`                       | Updates a folder.                                              |
| `deleteDirectory(id)`, `deleteDirectoryByLabel(label)` | Deletes an empty folder.                                  |
| `createAddress`, `updateAddresses`, `deleteAddress`, `changeAdmin`, `addAdmin`, `removeAdmin`, `updateMe` | Raw address and administrator operations. |

## Dashboard

Dashboard methods use the `dashboard` token. Methods with a person's identifier default to the PESEL from the token, which requires a session.

| Method                                    | Description                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `authorizedAddressesExtended(body?)`, `authorizedAddresses(body?)` | Addresses the person has access to.                |
| `address(ade?)`, `addressStatus(ade?)`, `addressesStatus(body)` | Address registry entries and statuses.              |
| `subjects()`, `subject(kppId)`            | Registry entities of the signed-in user.                                 |
| `searchByRegistryNumber(body, ade?, detailed?)` | A person's addresses, or details of one address.                  |
| `serviceProviders()`, `serviceProviderAddresses(body)` | Qualified service providers.                               |
| `processAddressOperation(request)`        | Submits a registry application (open, change, close an address…). Returns `{ requestId, signingUrl }` to sign. |
| `addSignedApplication(requestId, body)`, `activateAddress(requestId)`, `activateAddressByAde(ade, body)` | Completes an application. |
| `createAttachments(body)`, `deleteAttachments(ids)` | Application attachments.                                     |
| `submittedRequests(body?)`, `submittedRequest(id)`, `submittedRequestAttachment(id)` | Submitted applications.          |
| `processOrderUrl()`                       | Target of the form that hands an address to an external provider.       |
| `personalData()`                          | PESEL registry data of the signed-in user.                               |
| `menuCentral(body?)`, `menuOw(body?)`     | Header and menu configuration.                                           |

## Errors

All errors extend `EdoError`. Their messages never include tokens, cookies, message content, PESEL numbers or full addresses.

| Error                 | Thrown when                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `ApiError`            | An API call fails. Has `operation`, `status`, `code` (e.g. `UAAPI0174`) and the parsed body in `details`. `status` is `0` for checks made before any request. |
| `ReceiptGuardError`   | A call could open an unopened message without `acknowledgeReceipt: true`.                       |
| `SessionExpiredError` | Neither the refresh token nor SSO works; the user has to sign in again.                          |
| `QrExpiredError`      | The QR code expired before the user confirmed it.                                                |
| `FlowHalt`            | The login chain returned something unexpected. Has `step`, `reason` and `trace`.                 |
| `OidcError`           | The Keycloak token endpoint refused a request. Has `status` and `code`.                          |

`ApiError` codes produced by the library itself:

| Code                       | Meaning                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `pending:<status>`         | The message is still being prepared (HTTP 202).             |
| `empty`                    | The message request returned nothing.                       |
| `timeout`                  | `waitForTask` gave up.                                      |
| `too-large`                | A download exceeded `maxDownloadBytes`.                     |
| `json-instead-of-file`     | A download returned JSON without an error code.             |
| `html-instead-of-file`     | The ePUAP servlet returned a page instead of a file.        |
| `code-0`                   | An ePUAP send reported failure.                             |
| `mailbox-not-found`, `ambiguous (n mailboxes)`, `no-organizationEpuapId` | `selectMailbox` could not pick a mailbox. |
| `unexpected-uri`, `no-session-index` | `downloadServletFile` got a foreign URL, or has no session. |

`describeError(error)` returns a one-line description that is safe to log, with URLs and addresses masked.

## Utilities

| Export                                   | Description                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `LIMITS`                                 | Limits of the official send form: file sizes, attachment count, subject and text length, recipients. |
| `ALLOWED_EXTENSIONS`, `isAllowedExtension(filename)` | Attachment extensions the official form accepts.                  |
| `mimeTypeFor(filename)`                  | MIME type the official client assigns; `""` when unknown.                    |
| `validateUpload(files, { service, mass })` | Checks files like the official form. Returns a list of problems.          |
| `EpuapXml`                               | `extractAttachments`, `stripForDisplay` (drops attachment data and signatures), `guessContentType`, `xmlUnescape`. |
| `base64ToBytes`, `base64ToUtf8`, `bytesToBase64` | Base64 helpers (`base64ToBytes` also accepts base64url).            |
| `decodeJwt(jwt)`                         | JWT payload without signature verification.                                  |
| `maskAde(ade)`                           | `AE:PL-12345-67890-ABCDE-12` → `AE:PL-xxxxx-xxxxx-ABCDE-xx`.                 |
| `randomToken(length?)`                   | Random base64url string.                                                     |
| `epuapLogoutUrl(tgsid?)`                 | URL that ends the ePUAP session.                                             |

## Low-level API

The building blocks are exported too, for custom flows:

| Export                                   | Description                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `Transport`                              | Authenticated API calls: `json(request)` and `file(request)`.          |
| `BrowserHttp`                            | HTTP client with a cookie jar and manual redirects, used for the login chain. |
| `CookieJar`                              | Serializable cookie jar.                                               |
| `buildAuthRequest`, `exchangeCode`, `refreshTokens`, `logout`, `authorizeViaSso`, `createPkce`, `isCallbackFor`, `toTokenSet` | Keycloak OIDC with PKCE. |
| `getQrCode`, `waitForConfirmation`, `submitArtifact`, `defaultWebSocketConnector` | The mObywatel steps.          |
| `LoginGov`                               | The login.gov.pl SPA API: login methods, provider selection.           |
| `Stomp`                                  | STOMP over SockJS frames.                                              |
| `HOSTS`, `API`, `CLIENTS`, `REALM_PATH`, `IDP_HINT`, `DEFAULT_USER_AGENT`, `oidcEndpoint` | Endpoints and client configuration. |

## Security notes

- `LoginState` and `SessionData` are credentials. Anyone who has them can read and send the user's official mail. Encrypt them at rest and never log them.
- `QrCode.token` binds the confirmation channel; do not log it.
- Trace entries and error messages are designed to be safe to log.
- The library never works around a refusal: unexpected responses stop the flow instead of being retried in other ways.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE)
