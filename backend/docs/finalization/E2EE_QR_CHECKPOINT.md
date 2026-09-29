# PhoneMail E2EE and QR checkpoint

## Scope and status

This checkpoint records the additive E2EE/identity-sharing foundation, not a claim that the existing web or mobile applications are integrated. The existing `web-client/`, `web-portal/`, and mobile app were not changed for this work. The reusable TypeScript browser client is `e2ee-client/`; `e2ee-demo/` is an isolated local demonstration.

The backend stores only public keys and armored ciphertext. Client private keys are passphrase protected and never sent to the API. E2EE messages use the existing conversation and sync records with `contentFormat: "openpgp-v1"`; the ordinary message subject is the constant `Encrypted message` and body is empty. E2EE delivery is local to PhoneMail users and is not queued to SMTP.

## Implemented

- Password reauthentication followed by short-lived, single-use, session-bound signed challenges for key enrollment, rotation, and revocation. Challenges are rate limited.
- One active public key per account, immutable UUID-based OpenPGP user IDs, proof-of-possession checks, public key history, and key revocation when a phone number changes.
- Encrypted message and draft APIs validate current recipient fingerprints and encryption subkey IDs, enforce membership/block rules, and persist ciphertext transactionally. Message and draft sends require idempotency keys; draft revisions are checked transactionally.
- Existing conversation responses and incremental sync identify opaque messages using `contentFormat`. Non-E2EE JSON remains subject to the 64 KiB body limit; E2EE JSON may use the 16 MiB parser limit, while ciphertext is capped at 14 MiB.
- `e2ee-client/` provides OpenPGP key generation/import/export, detached challenge proofs, signed encryption/decryption, PGP/MIME construction/parsing, and QR payload validation/trust comparison.
- The standalone demo exercises key lifecycle, QR display/scanning, local signed/encrypted PGP/MIME, API key enrollment, ciphertext send/receive, and encrypted drafts.

## Verification evidence

All backend commands below were run through the ownership-checked disposable acceptance project with Node `v24.21.0`; no development database or unrelated Docker project was targeted.

| Check | Command / source identity | Result |
|---|---|---|
| Browser crypto, QR, real PGP/MIME and attachment round-trip | Node 24.21.0 container; `npm test` in `e2ee-demo/` | **PASS 1/1**, 0 failed, exit 0. Parsed outer MIME headers and encrypted part; decrypted inner MIME subject, body and exact attachment bytes. |
| Browser demo production build | Same container; `npm run build` | **PASS**, TypeScript and Vite production bundle completed, exit 0. One Vite bundle-size advisory (>500 KiB) remains informational. |
| Browser UI smoke | Isolated Node 24 Vite container and integrated browser | **PASS**, `GET /` returned HTTP 200 and the demo controls rendered; the owned UI container was stopped and removed. This was not a two-account interactive send/receive run. |
| Backend build, OpenAPI and E2EE API tests, and migrations | `.\backend\scripts\acceptance.ps1 -Action Test -E2eeOnly` | **PASS**, exit 0. OpenAPI contract plus E2EE integration **3/3**; fresh migration **32/32**; upgrade from 31 migrations plus additive migration 032; E2EE tables and message column verified. |
| Backend build-input fingerprint | Harness calculation over Docker inputs, `src/`, and `migrations/` | `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8` |
| Candidate image used by the final passing backend gate | Harness-verified same candidate for primary, secondary and pool API; Node `v24.21.0` | `sha256:b54cf78020351fe0d260ecf9c067c99513b1a7a6966da6794e879e8dea487ab2` |
| Current local API and demo CORS | API `GET /ready`, followed by `OPTIONS /api/auth/login` from `http://127.0.0.1:5173` | **PASS**, readiness `ready`; CORS preflight 204 and exact allowed origin returned. |

The final E2EE integration assertions include password-only reauthentication, proof failures, key registration/rotation/revocation, encrypted message and draft idempotency, authorization isolation, recipient-key changes, incremental sync, conversation rendering of opaque content, and both JSON body-size boundaries.

During development, the first container build exposed two TypeScript issues: the Express JSON verify callback uses Node's `IncomingMessage` (so the route check now reads `req.url`), and the conversation detail mapper now projects the migrated `content_format` field. The initial E2EE integration attempt also found two test-helper mismatches, not product failures: OpenPGP.js 6 uses `readKey`, and the established sync contract serializes `entity_id` in snake_case. The test helper/assertion now follow those supported interfaces. The final passing run includes the resulting test changes.

The 16 MiB request parser exception is limited to `/api/e2ee/`; the integration test proves an oversized non-E2EE JSON request still gets 413 while an oversized E2EE draft body reaches the E2EE ciphertext validator.

## Not covered / deployment boundary

- The complete backend unit and integration selections, SMTP acceptance suites, and operational failure-phase suite were not rerun for this E2EE change. Their historical results remain in `HANDOFF.md` and `SMTP_CHECKPOINT.md`; this checkpoint does not relabel them as current E2EE verification.
- The browser demo's cryptographic tests and production build pass, but a live two-device/browser-context walkthrough, camera-permission test, accessibility review, and deployed-origin/CORS review remain unverified.
- The demo keeps two identities and bearer tokens in one browser page for local use. It is not an independently isolated multi-user client.
- OTP-only accounts cannot manage E2EE keys yet; key lifecycle currently requires a password credential.
- `e2ee-client/` uses browser Web Crypto, `File`, `Blob`, `TextEncoder`, and `btoa`. Native Expo support and secure native key storage have not been implemented or validated.
- Provider configuration, public Internet email, PGP/MIME SMTP transport, end-to-end external recipient discovery, and production deployment remain out of scope.

## Local endpoint and contract

The disposable acceptance API is exposed at `http://127.0.0.1:3351`; readiness is `http://127.0.0.1:3351/ready`. The current contract is [`backend/openapi.json`](../../openapi.json). The E2EE browser demo defaults to that API origin and `http://127.0.0.1:5173`; the disposable Compose API explicitly allows that loopback demo origin.

The isolated API/database are intentionally retained by the acceptance harness. Use `.\backend\scripts\acceptance.ps1 -Action Stop` only when you intend to stop and clean the script-owned acceptance resources; the script refuses to adopt resources without its ownership manifest.

## Client-contract continuation — 2026-09-27

This continuation preserves the backend implementation and its prior acceptance record. No backend source, migrations, web application, or mobile application was changed here. The reusable browser client was hardened so prepared message/draft payloads are frozen and only the creating `PhoneMailE2eeClient` instance can submit them. A retry must reuse that exact in-memory object and therefore the same ciphertext and idempotency key. Forged/cloned prepared objects are rejected before an API request.

The client README now documents the stable API, strict QR wire format, trust decisions, encrypted drafts/attachments, ciphertext-only API boundary, progress/errors, retry behavior, mobile secure-storage adapter and an exact application integration sequence. The handoff QR description was corrected to match the actual decoder: version 1, UUID public identity reference, fingerprint, optional canonical PhoneMail address; never a public key or credential. The application entry points were inspected: `web-client/src/App.tsx` and `web-portal/src/App.tsx` are display-only scaffolds without authenticated sessions or mail flows; `mobile/App.tsx` has ordinary messaging/auth but no E2EE, and `mobile/package.json` has no SecureStore dependency. All three application sources were intentionally left unchanged because an E2EE UI cannot be safely bound without extending their authentication/session and, for mobile, native crypto/storage boundaries.

### Current verification and status

| Area | Status | Evidence |
|---|---|---|
| A. Backend E2EE implementation | **PASS (prior verified evidence)** | Ownership-checked `acceptance.ps1 -Action Test -E2eeOnly`: OpenAPI/E2EE integration 3/3; fresh migration 32/32 and upgrade through migration 032. Historical build fingerprint `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8`, candidate image `sha256:b54cf78020351fe0d260ecf9c067c99513b1a7a6966da6794e879e8dea487ab2`, Node `v24.21.0`. Backend source was not changed in this continuation. The running image could not be rechecked now because Docker is unavailable. |
| B. Reusable browser client | **PASS** | Node `v24.21.0`, from `e2ee-demo`: `node .\node_modules\tsx\dist\cli.mjs --test --test-timeout=90000 --test-concurrency=1 .\test\client.test.ts .\test\crypto.test.ts`: 5/5 passed, 0 failed/cancelled/skipped, exit 0. `node .\node_modules\typescript\bin\tsc -b` then `node .\node_modules\vite\bin\vite.js build` passed, exit 0; the existing >500 KiB chunk advisory remains. |
| C. Desktop web integration | **INCOMPLETE** | `web-client` and `web-portal` remain disconnected. Their entry points do not provide an authenticated session/mail-client integration surface. Exact minimum patch plan is documented in `e2ee-client/README.md` and `E2EE_CLIENT_HANDOFF.md`. |
| D. Mobile integration | **BLOCKED** | App remains on Expo `~52.0.46`, React Native `0.76.9`, React `18.3.1`. No SecureStore dependency or native crypto/MIME verification exists. No private key was placed in AsyncStorage; native support is not claimed. Exact adapter/device work is documented in the client README. |
| E. Two-identity browser walkthrough | **BLOCKED** | Not run. Latest `docker info` failed because `npipe:////./pipe/dockerDesktopLinuxEngine` does not exist; `http://127.0.0.1:3351/ready` was unreachable. No task-owned test/browser runner was active during the check. The prior crypto/MIME unit test and old UI smoke are not evidence of an Alice/Bob API exchange. |
| F. External SMTP/public deployment | **INCOMPLETE / external** | No external-recipient E2EE or public delivery is supported or claimed. Provider credentials, trusted public origin/CORS, compatible recipient software/key exchange, and deployment are not verified. |

The immediately preceding status is superseded by the live continuation below.

## Separate-session live browser walkthrough — 2026-09-27

### Ownership and candidate verification

Before starting, Docker Desktop reported server `29.8.0`; no E2EE runner or demo server was active, and only unrelated `repositoryfiles-*` development containers were running. The retained `phonemail-stage3-disposable` resource IDs, Compose labels, volume names, project network, and ownership manifest were checked. All required ports 3350–3354 were free. The existing guarded command was run from the repository root:

```powershell
.\backend\scripts\acceptance.ps1 -Action Start
```

It exited **0**, used the existing ownership manifest, and started/rebuilt only its `phonemail-stage3-disposable` API/database candidate. The current backend source fingerprint is `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8`, matching the checkpoint. The current rebuilt image is `sha256:4a90d268a7197936e2815f1c08097a092641eb189f9e505c989db3b6b5f91326`; this differs from the earlier recorded image digest because the guarded Start path rebuilt it. `backend`, `backend2`, and `backendpool` all reported that same image and Node `v24.21.0`. PostgreSQL identity was `phonemail_test|5432`. Readiness returned `ready` on `http://127.0.0.1:3351/ready`, `:3352/ready`, and `:3354/ready`. The final build-input fingerprint was unchanged.

The isolated demo UI was run on Node `v24.21.0` at `http://127.0.0.1:5173`. The browser exercise used two distinct browser pages/sessions: `82d40981-1e0f-41f0-945a-3d34eb940088` (Alice) and `f89c5500-ebc1-4453-8f1a-564965728268` (Bob). They registered different disposable accounts and used distinct bearer tokens held only in their respective page memory. Each independently generated and enrolled a client-side key; passphrase-protected armored private keys were saved/read from that browser’s protected-key store. No account password, bearer token, or private key is recorded here.

### Live results

| Gate | Actual result |
|---|---|
| Separate accounts, sessions, key creation/enrollment | **PASS**. Two distinct account UUIDs and key fingerprints; both registrations and proof-of-possession enrollments succeeded against the real API. Each protected browser key-store round-trip returned the same passphrase-protected key. |
| QR identity exchange and trust | **PASS**. Alice’s QR was generated, rendered as a PNG, decoded by the browser `Html5Qrcode.scanFile` scanner in Bob’s independent page, parsed, and compared against Alice’s live API key record. The full fingerprint matched. A modified fingerprint was rejected; malformed, unsupported-version, and 8,193-character QR inputs were rejected. After Bob rotated keys, the original QR correctly produced a fingerprint mismatch against the new active API key. |
| Alice-to-Bob E2EE message | **PASS**. Alice encrypted/signed MIME including a private attachment, posted only ciphertext and routing metadata to `POST /api/e2ee/messages`, and got a committed message ID. The captured API request contained none of the plaintext subject/body, attachment filename, or attachment bytes. Alice decrypted her Sent copy. Bob fetched via the API, decrypted, verified Alice’s signature, and recovered the subject, body, attachment name, and exact attachment bytes. |
| Tampering | **PASS**. Changing an interior armored ciphertext data character caused authenticated decryption failure for both Alice and Bob. Bob’s observed failure was `Modification detected`; the earlier attempted edit to a recipient session-key packet affected Alice’s packet only and was not treated as the successful body-tamper result. |
| Encrypted draft | **PASS**. Saving draft revision 1 invoked no message-send endpoint. Updating produced revision 2 and locally decrypted to the updated subject/body. Sending then retrying the exact request/idempotency key returned the same message ID and `duplicate: true`. Bob decrypted/verified the draft-sent copy. API request/response payloads contained no draft plaintext. |
| Missing, stale, changed, and revoked keys | **PASS**. An account with no public key returned 404 on key lookup and `409 E2EE_KEY_REQUIRED` on encrypted send. Bob’s key rotation changed the active fingerprint; Alice’s old QR was marked mismatched and an encrypted send with the old fingerprint returned `409 E2EE_KEY_CHANGED`. After revocation, current-key lookup returned 404 and encrypted send returned `409 E2EE_KEY_REQUIRED`. No E2EE failure triggered an ordinary-mail request. |
| Ordinary mail remains separate | **PASS**. An explicit `POST /api/mail/compose` to Bob returned 201 and persisted its ordinary plaintext subject/body; this was an intentional ordinary-mail send, not fallback from E2EE. The acceptance worker remained disabled, so no public SMTP delivery occurred. |
| Direct database privacy and idempotency | **PASS**. PostgreSQL showed the two E2EE messages with subject `Encrypted message`, empty plaintext body, armored ciphertext, and zero occurrences of the tested private subjects/bodies. The draft row was revision 2, linked to the single sent message, with ciphertext and no tested plaintext. The separately composed ordinary message retained its ordinary subject/body. |

The API and database queries above were executed in the owned Compose project. Live result: **8/8 scenario groups passed**, 0 failed and 0 blocked (the eight rows in the results table). These ran as interactive browser evaluations rather than a test-runner process; there is no npm test count or process exit code for that walkthrough, so the process exit is recorded as **not applicable**, not 0. Each final successful evaluation returned only after its explicit assertions passed. The guarded API Start command’s exact exit code was **0**. No mock server/API was used. The latest formal client/crypto runner evidence remains **5/5**, exit **0**; the prior guarded backend E2EE/OpenAPI integration remains **3/3**, exit **0**.

### Final status

| Area | Status | Evidence |
|---|---|---|
| A. Backend E2EE | **PASS** | Prior guarded integration 3/3 and migrations remain applicable to the exact same source fingerprint. Current rebuilt API is Node 24, readiness/database identity passed, and this live browser/API/database exchange passed. |
| B. Reusable browser client | **PASS** | Previously recorded Node 24 client/crypto tests 5/5 and TypeScript/Vite production build passed; this walk additionally exercised the browser crypto/MIME/QR helpers against the live API. |
| C. Two-user browser walkthrough | **PASS** | Two separate browser pages with independently registered/authenticated Alice and Bob accounts exchanged, decrypted, and verified real API ciphertext; Sent copy, QR scan/trust, tampering, drafts/idempotency, key failures, ordinary mail, and database privacy checks passed as above. |
| D. Desktop application integration | **INCOMPLETE** | `web-client` and `web-portal` remain scaffolds and unchanged. The exact integration sequence is in [`E2EE_CLIENT_HANDOFF.md`](./E2EE_CLIENT_HANDOFF.md) and [`e2ee-client/README.md`](../../../e2ee-client/README.md). |
| E. Mobile/native integration | **BLOCKED** | Expo 52 / React Native 0.76.9 app source is unchanged; there is no SecureStore binding or iOS/Android crypto/MIME/device verification. |
| F. External SMTP/public deployment | **INCOMPLETE / external** | No external-recipient E2EE, provider setup, or public Internet delivery was tested or claimed. |

The Vite UI server and the two browser pages were closed after the walkthrough. The ownership-checked disposable API/database stack remains running by design at `http://127.0.0.1:3351` (secondary `:3352`, pool `:3354`); no development containers, development database, backups, or unrelated resources were stopped or modified. Mobile/native and desktop app integration remain open; this is not an overall E2EE application-completion claim.
