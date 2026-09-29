# E2EE client integration handoff

## Current boundary

This is an integration guide, not a report that the existing clients are connected. The existing `mobile/`, `web-client/`, and `web-portal/` source remains unchanged. The E2EE API contract is [`backend/openapi.json`](../../openapi.json), and the reusable browser package is `e2ee-client/`. The local reference UI is `e2ee-demo/`.

The backend holds public keys and ciphertext only. It cannot recover client plaintext. E2EE messages are local PhoneMail deliveries; they do not enter the SMTP outbox or send public email. Recipient IDs, key fingerprints, conversation membership, timestamps, and delivery metadata remain visible to the server.

## Browser setup and API flow

From the repository root in PowerShell:

```powershell
Push-Location .\e2ee-client
npm ci
Pop-Location
Push-Location .\e2ee-demo
npm ci
npm test
npm run build
npm run dev
Pop-Location
```

The local demo is served at `http://127.0.0.1:5173` and defaults to the isolated API at `http://127.0.0.1:3351`. Its CORS origin is included only in `backend/docker-compose.acceptance.yml`; configure the deployed API's allowlist explicitly for the real client origin. Use two disposable password-backed test accounts. The standalone demo places both authenticated identities in one page and is not a secure production multi-user boundary.

Client flow:

1. Authenticate each account. Reauthenticate with its password before key lifecycle changes.
2. Generate or import a passphrase-protected private key whose OpenPGP user ID is bound to the immutable PhoneMail UUID. Keep private keys on the client; export/backup must be an explicit user action.
3. Request `POST /api/e2ee/key-challenges`, sign the returned challenge locally, and call `POST /api/e2ee/keys`. Rotation requires signatures from both the old and new keys. Revocation requires proof from the current key.
4. Publish/share a strict version-1 QR containing only the UUID public identity reference, fingerprint, and optional canonical PhoneMail address. It carries no public key, URL, token, OTP, private key, or recovery material. A QR fingerprint is not identity proof: compare the complete fingerprint through an independent trusted channel before trusting first use or a key change. Optional addresses reveal the corresponding phone identity.
5. Fetch current recipient keys and verify they still match the independently checked fingerprint. Encrypt and sign locally, including the sender's own key when sent-mail decryption is required. Submit only armored ciphertext, current recipient fingerprints, recipient UUIDs, and an `Idempotency-Key` to `POST /api/e2ee/messages`.
6. Fetch ciphertext through `GET /api/e2ee/messages/{id}` and decrypt/verify locally. Incremental sync records identify the entity with `contentFormat: "openpgp-v1"`; fetch the ciphertext from the E2EE endpoint rather than treating the ordinary `body` as plaintext.
7. Save encrypted drafts through `/api/e2ee/drafts`; update with the current revision. Send using `/api/e2ee/drafts/{id}/send` and an idempotency key. The server commits the message and marks the draft sent in one transaction.

If a recipient key rotates between lookup and send, the API rejects the stale key set; fetch and independently verify the new key before re-encrypting. Only one active key per account is supported. Revoked historical public keys remain available for verification, but clients must retain corresponding private-key backups to decrypt old content.

Request limits: the API accepts at most 14 MiB of armored ciphertext, while the browser helper limits combined attachments to 9 MiB and message text to 100,000 characters. Encrypt attachments inside the MIME content before OpenPGP encryption. PGP/MIME is presently constructed/parsed in the client helper for local use; it is not a server SMTP format or external-mail feature.

## Mobile integration requirements

Do not upgrade the existing Expo 52 / React Native 0.76.9 / React 18.3.1 scaffold to integrate this work. The current `e2ee-client` package is browser-oriented and is not a drop-in React Native module. Before mobile adoption:

- Provide a platform adapter for binary attachments and the browser-only `File`, `Blob`, `btoa`, and Web Crypto interfaces used by the package.
- Verify the selected OpenPGP.js algorithms, randomness, Web Crypto, stream support, and MIME handling on the actual Expo 52 iOS and Android runtimes. A passing Node/browser test does not establish native compatibility.
- Persist passphrase-protected private-key material with platform-protected secure storage, not ordinary AsyncStorage or logs. Keep decrypted keys in memory only for the shortest necessary operation. Provide explicit, recoverable encrypted-key backup and loss/revocation UX.
- Add first-use/key-change fingerprint verification, rotation, revocation, attachment encryption, encrypted draft revisions, and offline/sync conflict behavior to the mobile UI. Never silently downgrade an E2EE compose to plaintext.
- Treat OTP-only accounts as unsupported until a separately designed reauthentication flow is implemented.

## Desktop web integration

The current [web-client/src/App.tsx](../../../web-client/src/App.tsx) and [web-portal/src/App.tsx](../../../web-portal/src/App.tsx) are display-only scaffolds; neither provides an authenticated session, mail API, or compose/thread flow to extend safely. The safe patch order is:

1. Add the local `@phonemail/e2ee-client` package to `web-client/package.json`, then wire its configured API origin and existing authenticated UUID/bearer-token lifecycle into `PhoneMailE2eeClient`.
2. Add a persistent `FingerprintTrustStore` and key-management view using browser protected-key storage, password reauthentication, signed challenge enrollment/rotation/revocation, secure-context enforcement, and explicit out-of-band fingerprint comparison.
3. Add encrypted compose alongside ordinary compose. Require current trusted keys for all recipients and block instead of falling back to plaintext. Keep the exact prepared ciphertext object for network-ambiguous idempotent retries.
4. Render `contentFormat: "openpgp-v1"` using local decrypt/signature verification; implement encrypted draft and attachment flows; test sender Sent-copy decryption and assert requests contain no plaintext.
5. Keep `web-portal` limited to its existing registration/auth responsibility unless its product scope is explicitly extended; do not add key lifecycle to an OTP-only flow without a designed password reauthentication alternative.

Do not infer that server-side SMTP or normal email recipients support OpenPGP based only on local client PGP/MIME tests.

The current local demo, API integration test, and reusable module are scaffolding for that work. No mobile, desktop web, public-provider, or production integration acceptance is claimed. Mobile-specific patch steps are also in [`e2ee-client/README.md`](../../../e2ee-client/README.md); the existing Expo app has no SecureStore dependency, and native crypto/MIME support has not been demonstrated.

## Latest live acceptance — 2026-09-27

The live acceptance has now passed for two independent browser sessions, without integrating or changing the real application scaffolds. Alice used browser page/session `82d40981-1e0f-41f0-945a-3d34eb940088`; Bob used `f89c5500-ebc1-4453-8f1a-564965728268`. Each registered a separate disposable account, generated and enrolled an independent passphrase-protected key, and kept its own bearer token in page memory. Bob scanned Alice’s generated QR image with the browser QR decoder and compared the full fingerprint against Alice’s actual current API key.

Against the ownership-checked API at `http://127.0.0.1:3351`, Alice sent signed ciphertext with an encrypted attachment; Bob decrypted and verified the signature and recovered attachment bytes; Alice decrypted her Sent copy. PostgreSQL showed only generic subject/empty body plus ciphertext for E2EE records and no tested plaintext in message or draft ciphertext. An interior ciphertext mutation failed integrity/decryption. Encrypted draft save/update/send/retry passed with revision 2 and one idempotent message. Changed, missing, stale and revoked keys were blocked by the expected QR/API checks and `E2EE_KEY_CHANGED`/`E2EE_KEY_REQUIRED` responses. Explicit ordinary mail still returned 201 through its separate endpoint. QR malformed/version/size and fingerprint mismatch cases were rejected.

The guarded `.\backend\scripts\acceptance.ps1 -Action Start` exited 0. Source fingerprint matched the prior checkpoint exactly: `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8`. The rebuilt image used by `backend`, `backend2`, and `backendpool` is `sha256:4a90d268a7197936e2815f1c08097a092641eb189f9e505c989db3b6b5f91326`; each reported Node `v24.21.0`. Database identity was `phonemail_test|5432`; readiness passed on ports 3351, 3352 and 3354. The newly rebuilt image digest replaces the historical candidate digest for current local acceptance; no backend source changed.

The browser workflow passed **8/8 scenario groups**, 0 failed/blocked. It ran interactively, not by npm/test runner, so its process exit code is **not applicable**. Formal evidence remains browser-client/crypto **5/5, exit 0** and prior guarded backend E2EE/OpenAPI **3/3, exit 0**. See [`E2EE_QR_CHECKPOINT.md`](./E2EE_QR_CHECKPOINT.md) for the full result table and database checks.

Current deliverable statuses: backend E2EE **PASS**; reusable browser client **PASS**; two-user browser walkthrough **PASS**; desktop application integration **INCOMPLETE**; mobile/native integration **BLOCKED** pending SecureStore and real iOS/Android verification; external SMTP/public deployment **INCOMPLETE / external**. The actual web app entry points remain scaffold code and were not connected. The browser UI server and pages were closed after testing; the owned disposable API/database stack remains running at `http://127.0.0.1:3351`. Live provider configuration and public Internet email remain external deployment work.
