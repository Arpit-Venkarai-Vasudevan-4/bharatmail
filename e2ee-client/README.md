# PhoneMail E2EE client contract

`@phonemail/e2ee-client` is the typed browser-side integration package for the existing `/api/e2ee` endpoints. The stable entry points are:

- `@phonemail/e2ee-client`: key generation/import/export, challenge signing, encrypted MIME construction/parsing, encryption/decryption/signature verification, strict QR parsing, fingerprint comparison, and protected-key storage adapters.
- `@phonemail/e2ee-client/client`: `PhoneMailE2eeClient`, its typed endpoint operations, trust-store interface, bounded `E2eeClientError`, and progress states.

OpenPGP.js is pinned to 6.3.2. The E2EE flow is separate from ordinary mail; this package never calls `/api/mail/compose` or `/api/mail/reply`.

## Browser application setup

The browser app must run in a secure context (`https` or a browser-trusted localhost origin). API origin and bearer token come from the app's existing authenticated session. Do not put the account password, private-key passphrase, plaintext, decrypted MIME, subject, attachment name, or private key into an API request. The one intentional account-password request is `POST /api/e2ee/reauth` for key lifecycle authorization.

```ts
import {
  createBrowserProtectedKeyStore,
  makeQrPayload,
  readQrPayload,
} from "@phonemail/e2ee-client";
import { PhoneMailE2eeClient, type FingerprintTrustStore } from "@phonemail/e2ee-client/client";

const keyStore = createBrowserProtectedKeyStore();
const trustStore: FingerprintTrustStore = appFingerprintPinStore;
const client = new PhoneMailE2eeClient({
  apiBaseUrl: "https://api.example.invalid",
  accessToken: () => authSession.accessToken,
  trustStore,
  onProgress: ({ state }) => setEncryptionProgress(state),
});

const identity = await client.createIdentity(authSession.user.id, privateKeyPassphrase);
await keyStore.save(identity.userId, identity.encryptedPrivateKey);
await client.enroll(identity, privateKeyPassphrase, accountPassword);

const qr = await makeQrPayload(identity, undefined);
const decoded = await readQrPayload(qr);
const status = await client.inspectQr(qr); // checks the active API key and prior local fingerprint pin
// Only after the person compares every fingerprint character through an independent trusted channel:
await client.trustQr(status, userConfirmedOutOfBandFingerprint);

const prepared = await client.prepareEncryptedMessage({
  sender: identity,
  passphrase: privateKeyPassphrase,
  to: [trustedRecipient.userId],
  cc: [],
  subject: compose.subject,
  text: compose.body,
  attachments: compose.files,
  idempotencyKey: crypto.randomUUID(),
});
const result = await client.sendPreparedMessage(prepared);
// If the network response is ambiguous, reuse this exact ciphertext and key in memory:
const retried = await client.sendPreparedMessage(prepared);
```

The prepared object is frozen and is accepted for sending only by the client instance that created it. Keep that same in-memory object for an ambiguous retry; do not reconstruct it or re-encrypt under the same idempotency key.

`appFingerprintPinStore` in this example is an application-owned implementation of `FingerprintTrustStore`; it must only be updated after explicit out-of-band verification. An initial fingerprint is **not** trusted merely because a QR decodes or matches the API. A different active fingerprint returns `KEY_CHANGED`, a QR for a user with no active key returns `KEY_REVOKED`, and an unpinned recipient returns `TRUST_REQUIRED`. `sendEncrypted` never falls back to plaintext or an SMTP endpoint. A missing active recipient key blocks with `RECIPIENT_KEY_MISSING`.

## QR wire format

`makeQrPayload` emits `PHONEMAIL:E2EE:1:` followed by URL-safe Base64 JSON containing exactly `version: 1`, `userId` (the UUID public identity reference), `fingerprint`, and optional canonical PhoneMail `address`. `readQrPayload` rejects other versions, unknown properties, oversized payloads, malformed UUIDs/fingerprints, and non-canonical addresses. The QR deliberately carries neither the public key nor any URL, credential/token, OTP, private key, or recovery material. Fetch the active public key from the API and compare its fingerprint; an independently verified QR fingerprint must match before a local trust pin is saved.

To decrypt a received or Sent copy, load the account's passphrase-encrypted private key, import it with the user UUID and passphrase, and call `client.decryptMessage(identity, passphrase, messageId)`. For another sender, the client requires a matching local trust pin and a public key in that sender's server history, then verifies the OpenPGP signature before returning decrypted MIME. The sending identity is always included in the encryption recipient set, so a Sent copy is decryptable by the sender's private key even if the active registration is later revoked.

## Encrypted drafts and attachment behavior

`saveEncryptedDraft` and `updateEncryptedDraft` encrypt subject, body, attachment bytes, and attachment names locally to the owner's own active public key. Only ciphertext is submitted to `/api/e2ee/drafts`; revision conflicts are returned as `REVISION_CONFLICT`.

`prepareEncryptedDraftSend` fetches and decrypts the local draft, resolves the sender plus all recipients, requires current recipient fingerprints already trusted, and encrypts the original MIME to the sender and recipients. `sendPreparedDraft` posts ciphertext plus routing IDs/fingerprints to `/api/e2ee/drafts/{id}/send`. The caller supplies a stable `idempotencyKey` and current draft revision. Retain the prepared ciphertext-only object until the server acknowledges it, and reuse that exact object for retries; do not re-encrypt under the same idempotency key. A failed/untrusted recipient never causes plaintext fallback.

Attachment limits are enforced client-side: no more than 10 attachments, no individual attachment above 9 MiB, and 9 MiB combined. Message body is limited to 100,000 characters; the encrypted MIME helper rejects unsafe subject headers and bounds final inner MIME. Filenames, MIME type, and contents are inside the encrypted MIME. The server sees routing IDs, key fingerprints, ciphertext size/timing, message/draft IDs and ordinary delivery metadata; E2EE messages have a generic stored subject and empty plaintext body. No plaintext preview or decrypted search index is uploaded.

The helper supports encrypted raw OpenPGP messages returned by the API and constructs/parses PGP/MIME wrappers for interoperable local exports. PGP/MIME here does **not** enable external SMTP encryption.

## `FingerprintTrustStore` requirements

The application implements this small persistence boundary:

```ts
import type { StoredTrust } from "@phonemail/e2ee-client/client";

interface FingerprintTrustStore {
  get(userId: string): Promise<StoredTrust | undefined>;
  set(trust: StoredTrust): Promise<void>;
  remove(userId: string): Promise<void>;
}
```

Trust pins are public integrity metadata, but a changed fingerprint must be displayed as a blocking warning and confirmed out of band before `set` replaces a prior pin. Do not infer identity from a server response or QR alone.

## Browser private-key storage

`createBrowserProtectedKeyStore()` requires `window.isSecureContext` and Web Crypto. It stores only the OpenPGP armored **passphrase-encrypted** private key under the owning user UUID in browser local storage; it never stores the passphrase or an unlocked private key. It is not a hardware-backed vault, and same-origin script compromise/XSS can copy the encrypted key. Existing web applications should apply their normal CSP/XSS defenses and require the passphrase again to import/use a stored key. Export downloads a passphrase-protected backup; rotation must not discard the only historical decryption key.

## Mobile secure-storage boundary

`createNativeProtectedKeyStore()` accepts a platform adapter marked `ios` + `apple-keychain` or `android` + `android-keystore`. The integration must map these methods to Expo SecureStore or an equivalent native keychain/keystore API:

```ts
import { createNativeProtectedKeyStore } from "@phonemail/e2ee-client";

const nativeKeys = createNativeProtectedKeyStore({
  platform: Platform.OS === "ios" ? "ios" : "android",
  storage: Platform.OS === "ios" ? "apple-keychain" : "android-keystore",
  getItem: key => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: key => SecureStore.deleteItemAsync(key),
});
```

Do not implement that adapter with AsyncStorage. This boundary only defines protected persistence; it does not establish that OpenPGP.js, binary MIME handling, Web Crypto, `File`, `Blob`, `btoa`, or `AbortSignal.timeout` work in Expo 52 / React Native 0.76.9. Native crypto/network adapters and device verification remain blocked until tested on actual iOS and Android runtimes. Do not claim mobile support based on browser tests.

## Errors and progress

The client emits bounded operation states (`preparing`, `reauthenticating`, `generating-key`, `signing`, `resolving-keys`, `encrypting`, `saving`, `sending`, `decrypting`, `complete`, `error`). Errors are `E2eeClientError` values with a stable code, optional HTTP status, and at most 240 characters of message. UI must keep `TRUST_REQUIRED`, `KEY_CHANGED`, `KEY_REVOKED`, `RECIPIENT_KEY_MISSING`, authentication, idempotency, and revision conflicts visible and actionable; do not silently retry with ordinary mail.

## Backend contract and boundaries

See [`../backend/openapi.json`](../backend/openapi.json). The client calls real endpoints: `/api/e2ee/reauth`, `/api/e2ee/key-challenges`, `/api/e2ee/keys`, `/api/e2ee/keys/{userId}`, `/api/e2ee/keys/{userId}/history`, `/api/e2ee/keys/current`, `/api/e2ee/messages`, `/api/e2ee/messages/{id}`, `/api/e2ee/drafts`, `/api/e2ee/drafts/{id}`, and `/api/e2ee/drafts/{id}/send`.

The current API supports password-backed key lifecycle only. It accepts PhoneMail UUID recipients, not arbitrary SMTP addresses. E2EE is local PhoneMail delivery only. Public Internet delivery requires compatible recipient software, independently verified public-key exchange, and an explicitly designed encrypted external-mail transport. Ordinary mail remains on its existing API and is not implicitly encrypted.

No server-side search over decrypted content, malware scanning of encrypted attachments, hidden routing metadata, subject privacy for ordinary mail, or notification privacy beyond the generic encrypted-message subject is claimed.

## Existing application integration patch plan

The existing desktop apps are scaffolds, not authenticated mail clients: [`web-client/src/App.tsx`](../web-client/src/App.tsx) and [`web-portal/src/App.tsx`](../web-portal/src/App.tsx) expose no authenticated session or mail operations. Do not mount E2EE compose into either placeholder yet. The exact minimum desktop integration sequence is:

1. Add the local `@phonemail/e2ee-client` dependency to `web-client/package.json` and update that app's npm lockfile. Keep the web-portal registration/OTP flow separate.
2. In the web-client's real auth implementation, expose the signed-in account UUID, bearer-token getter, and session-expiry/logout state. Construct `PhoneMailE2eeClient` with the configured API origin and a persistent `FingerprintTrustStore`.
3. Add a key-management view using `createBrowserProtectedKeyStore`, password reauthentication, challenge signing, enrollment/rotation/revocation, and explicit complete-fingerprint verification. Require HTTPS or trusted localhost before enabling key storage.
4. Add E2EE compose alongside ordinary compose. Resolve every recipient; block on missing, changed, or untrusted active keys. Submit only ciphertext and routing metadata; never fall back to `/api/mail/compose` after an E2EE error.
5. Route `contentFormat: "openpgp-v1"` thread entries to local decrypt/verify, support ciphertext-only encrypted drafts and attachments, and test retry identity, sender Sent-copy decryption, and absence of plaintext in API requests.

The current mobile app [`mobile/App.tsx`](../mobile/App.tsx) has authentication and ordinary messaging but no E2EE lifecycle. Before a mobile patch: add a supported Expo SecureStore dependency compatible with the existing Expo version, implement its iOS Keychain/Android Keystore adapter for `createNativeProtectedKeyStore`, then verify OpenPGP, randomness, binary/MIME and bounded API behavior on both native runtimes. Add encrypted compose/thread states only after those checks; never put a private key or passphrase in AsyncStorage. The existing AsyncStorage session-token use is not a private-key store and must not be repurposed for one.

These are integration steps, not evidence that either app is connected. Keep ordinary-mail behavior available and visibly separate throughout integration.
