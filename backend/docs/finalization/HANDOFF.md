# PhoneMail Backend Finalization Handoff

# PhoneMail Backend Finalization Handoff

## E2EE live walkthrough — latest status 2026-09-27

The previously recorded Docker/API-unavailable status below is superseded for the live walkthrough. Docker Desktop is available; the guarded `.\backend\scripts\acceptance.ps1 -Action Start` exited **0** and brought up only the ownership-manifest-verified `phonemail-stage3-disposable` stack. Backend source fingerprint remains `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8`. The rebuilt `backend`, `backend2`, and `backendpool` share image `sha256:4a90d268a7197936e2815f1c08097a092641eb189f9e505c989db3b6b5f91326`; all report Node `v24.21.0`. PostgreSQL identity is `phonemail_test|5432`; readiness is good at `http://127.0.0.1:3351/ready`, `:3352/ready`, and `:3354/ready`. The prior image digest was historical; the current digest is from the latest guarded rebuild with unchanged source inputs.

The E2EE walkthrough passed with two separate browser pages and independent password-backed sessions (Alice page/session `82d40981-1e0f-41f0-945a-3d34eb940088`, Bob `f89c5500-ebc1-4453-8f1a-564965728268`). Each created/enrolled a client-side key. Alice-to-Bob ciphertext and an encrypted attachment were sent through the real API; Bob decrypted and verified, Alice decrypted her Sent copy, and PostgreSQL contained only an opaque E2EE row/draft (generic subject, empty body, ciphertext; zero tested plaintext leaks). QR image generation and scanning, complete fingerprint check, changed/malformed/version/size rejection, tamper integrity failure, draft revision/update/send/idempotent retry, missing/stale/revoked key rejection, and the separate ordinary-mail 201 path all passed. No E2EE error caused a plaintext fallback. No external email was sent.

Formal verification counts: previously passing Node 24 client/crypto tests **5/5, exit 0**, and guarded backend E2EE/OpenAPI integration **3/3, exit 0** remain associated with the same source fingerprint. The live walkthrough passed **8/8 scenario groups**, 0 failed/blocked. It was interactive browser-tool execution rather than a runner; its process exit code is not applicable, and individual results are recorded in [`E2EE_QR_CHECKPOINT.md`](./E2EE_QR_CHECKPOINT.md). The browser UI server/pages were closed afterward. The owned disposable API/database stack remains running at `http://127.0.0.1:3351`.

Separate status: backend E2EE **PASS**; reusable browser client **PASS**; two-user walkthrough **PASS**; desktop application integration **INCOMPLETE** because `web-client` and `web-portal` remain scaffolds; mobile/native **BLOCKED** pending secure native storage and real device crypto/MIME verification; external SMTP/public deployment **INCOMPLETE / external**. The precise desktop/mobile integration plan is in [`E2EE_CLIENT_HANDOFF.md`](./E2EE_CLIENT_HANDOFF.md). Provider credentials and public Internet delivery remain deployment prerequisites.

## E2EE and QR implementation — 2026-09-27

The additive E2EE API, migration, reusable browser OpenPGP client, and isolated browser demo are recorded in [`E2EE_QR_CHECKPOINT.md`](./E2EE_QR_CHECKPOINT.md); client integration steps and platform boundaries are in [`E2EE_CLIENT_HANDOFF.md`](./E2EE_CLIENT_HANDOFF.md). The existing mobile, web-client, and web-portal source was not modified or integrated.

Latest guarded verification: `.\backend\scripts\acceptance.ps1 -Action Test -E2eeOnly` passed, including the OpenAPI contract and E2EE integration (**3/3**) and fresh/upgrade migrations (32 fresh; 31 then migration 032). Backend build-input fingerprint: `381FF6F4ACAF822F9F6A371E4E8571AB24341387B26D0E1F6F6D41DEEB3395B8`; candidate image: `sha256:b54cf78020351fe0d260ecf9c067c99513b1a7a6966da6794e879e8dea487ab2`; all acceptance services and test runner used Node `v24.21.0`. Standalone browser crypto/QR/MIME tests passed **1/1** and the Node 24 production build passed. The current `http://127.0.0.1:3351/ready` API is healthy and its CORS preflight for the demo origin on port 5173 returns 204. This scoped check does not rerun the historical whole-backend or SMTP suites and does not establish native mobile, production, or public Internet delivery readiness.

### E2EE client continuation — current status

The immediately preceding healthy API/CORS result above is historical. A fresh status check for this continuation found the Docker Desktop Linux engine unavailable (`npipe:////./pipe/dockerDesktopLinuxEngine` missing) and `http://127.0.0.1:3351/ready` unreachable. No task-owned browser/test runner was active. Do not report the local API as currently running. Backend source and migrations were not changed; its E2EE/OpenAPI integration 3/3 and fresh/upgrade migration results above remain prior verified evidence, while the running candidate image could not be rechecked.

The latest Node `v24.21.0` browser-client test selection passed **5/5**, 0 failed/cancelled/skipped, exit 0; the TypeScript/Vite production build passed, exit 0 (informational >500 KiB chunk warning). The reusable client now rejects cloned/unrecognized prepared sends and freezes ciphertext-only retry payloads; retries must reuse the same in-memory prepared object. The E2EE/QR checkpoint records the exact commands, counts, historical source/image identity, external prerequisite, and A–F status table. The real separate-context Alice/Bob API walkthrough remains **BLOCKED** by the unavailable Docker/API, not passed by crypto unit tests.

`web-client` and `web-portal` source remains unchanged and disconnected: both app entry points are display-only scaffolds without an authenticated session or message flow. Mobile source remains unchanged; Expo SecureStore and native crypto/MIME compatibility have not been installed or device-verified. The exact desktop and mobile integration patch plans are in [`E2EE_CLIENT_HANDOFF.md`](./E2EE_CLIENT_HANDOFF.md) and [`e2ee-client/README.md`](../../../e2ee-client/README.md). The integration contract is [`backend/openapi.json`](../../openapi.json). The configured local target is `http://127.0.0.1:3351`, but it is not currently responding. Live provider setup and public Internet delivery remain external deployment tasks.

## Current Stage 3 status

The current source in the original workspace is backend-only. It retains the existing Node.js/TypeScript API and unchanged frontend projects. The working copy has no Git metadata. The final source-only SHA-256 manifest is [`SOURCE_SHA256SUMS.txt`](./SOURCE_SHA256SUMS.txt); it excludes dependency/build output, `.env`, database contents, attachment storage, and itself. The separate user backup and development project were left untouched.

Current evidence, limitations, and exact final commands are maintained in `VERIFICATION.md` and `SUBMISSION_RUNBOOK.md`; those documents supersede older “complete” claims below. Current Stage 3 behavior includes a bounded libphonenumber-validated fixture allocator, additive migrations through 029, bearer/cookie refresh rotation, transactional security audit/notification events for implemented operations, and large snapshots that stream above the 10,000-record materialized threshold. Streaming snapshots retain a bounded read transaction and require instance affinity.

The repeatable acceptance command is `.\backend\scripts\acceptance.ps1 -Action Test` from a fresh PowerShell shell. It uses the separate `phonemail-stage3-disposable` Compose project, two same-image Node 24 APIs, isolated PostgreSQL, and opt-in worker/pool services. The script checks readiness and resource ownership and cleans up only resources recorded in its manifest. The running development project and data, frontends, and separate user backup were left untouched. No real provider traffic, external email, or frontend/device acceptance is claimed. The earlier unexplained registration HTTP 400 remains undiagnosed; later green runs do not establish its original cause.

## Whole-backend regression after SMTP changes — 2026-09-27

This verification is separate from the local SMTP acceptance recorded in `SMTP_CHECKPOINT.md`. It does not establish that the whole backend is production-ready.

The current source was rebuilt through the ownership-checked `acceptance.ps1` harness. Its source fingerprint over the backend Docker build inputs (`.dockerignore`, `Dockerfile`, package manifests, TypeScript config, `src`, and `migrations`) was `D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF`. Candidate image: `sha256:18d38a75a86d2b02f4f5ac2cdbacbae7b92c2de134b501609e8c186b6c05885a`. The primary, secondary, and two-connection APIs used this exact image and Node `v24.21.0`; the test driver also reported Node `v24.21.0`. PostgreSQL identity was `phonemail_test` on port 5432 inside `phonemail-stage3-disposable`. The integration target guard remains unchanged.

Results:

| Run | Result |
|---|---|
| `npm run test -- --test-timeout=60000` via the disposable Node 24 runner | **PASS 27/27**, 0 failed/cancelled/skipped, exit 0. Full `scripts.test` selection. It preceded the isolated conversation service fix; the affected integration selection was rerun afterward. |
| `npm run test:migrations` | **PASS**, fresh migration and pre-029 upgrade path (31 migrations), exit 0. |
| First `acceptance.ps1 -Action Test` integration phase | **FAIL 17/18**, exit 1; actual group-reply recipient omission found. |
| Fix | `conversationService.sendMessage` unions stored To recipients with the other current group members. Assertions and `integrationTarget.ts` protections are unchanged. |
| `acceptance.ps1 -Action Test -IntegrationOnly` after fix | **PASS 18/18**, 0 failed/cancelled/skipped, exit 0; full serialized integration selection. |
| `acceptance.ps1 -Action Test -RemainingPhases` | **PASS**, exit 0, details below: snapshot restart, restricted-pool draft contention 1/1, database outage/recovery, worker 1/1, constrained network 1/1. Skipped tests remained supported by their source-matched prior evidence. |

The disposable runner applies a 900-second process deadline and 60-second per-test timeout, gives each test driver a unique name, stops only that container on deadline, and removes its dependency volume in `finally`. The integrations took 543,403.8 ms by Node’s test report. The final source fingerprint matched the built image inputs. No driver containers or dependency volumes remain. The Stage 3 disposable APIs/DB remain healthy; unrelated development data/services and the separate user backup were not operated on.

One preliminary harness setup attempt exited 1 before tests because an existing ownership-manifest JSON object lacked newly recorded source/image fields. Missing fields are now added with `Add-Member`; the attempt did not remove or modify data volumes.

### Five remaining phases, newly run

The normal acceptance path had stopped after the initial failing integration selection. The revised runner adds the mutually exclusive `-RemainingPhases` mode; it retains resource ownership, source/image/runtime/readiness/database checks and dependency installation, and skips only the three prior passing selections when the recorded source fingerprint matches. It runs the original phase bodies (not duplicated harnesses). Image IDs changed across repeated Compose rebuilds while source inputs remained identical, so prior-evidence applicability is checked using the exact source fingerprint; for each invocation all candidate services are independently required to match the current image ID and Node `v24.21.0`.

The successful command, from repository root:

```powershell
$env:BUILDKIT_PROGRESS='plain'; $env:COMPOSE_PROGRESS='plain'; $env:COMPOSE_ANSI='never'; $env:COMPOSE_MENU='false'
.\backend\scripts\acceptance.ps1 -Action Test -RemainingPhases
```

| Phase | Actual outcome |
|---|---|
| Snapshot restart | **PASS**, exit 0. Created the >10,000-row streaming snapshot, restarted only the owned primary API, verified instance-affinity rejection and incremental recovery from the original watermark, created a replacement snapshot, and cleaned the fixture. |
| Restricted pool draft | **PASS 1/1**, no failures/skips, exit 0. Eight idempotent concurrent draft sends against the dedicated two-connection API committed once without deadlock or partial state. |
| Database outage/recovery | **PASS**, prepare/outage/recovered/cleanup commands each exit 0. The expected injected outage responses were liveness 200 plus readiness/login/authenticated reads/registration retryable 503 with redacted diagnostics. After DB recovery, both an existing and new account authenticated. |
| Worker-enabled local delivery | **PASS 1/1**, no failures/skips, exit 0. Outbox reached sent and local notification delivery `simulated`; no external provider traffic. Worker stopped in `finally`. |
| Constrained network | **PASS 1/1**, no failures/skips, exit 0. 30 concurrent baseline/constrained requests; response retry, interrupted upload reconciliation, 8 KiB multi-chunk upload, byte-verified range reconstruction, and incremental sync retry. Baseline 128 ms elapsed (p50 82.4/p95 102.6); constrained 859.9 ms (p50 621.5/p95 834.1); 32,000 B/s each direction, 180 ms one-way latency; proxy saw 106 requests, 9,756 upstream / 55,267 downstream bytes, two dropped responses and one interrupted upload. |

The first remaining-phase attempt stopped before tests because it required the previous image ID to remain identical across a rebuild; source fingerprint was unchanged and no runner/fixture was started. The runner was corrected to require matching prior source evidence while verifying current candidate image IDs per service.

The first full remaining-phase test run then passed snapshot restart and the pool contention case but also ran the unrelated first-draft SMTP-delivery case against `backendpool`, where the outbox worker is deliberately disabled. That case failed waiting for `relay_accepted`; this was an invalid selection for the restricted-pool phase, not a pool/draft defect. The runner now routes both the default and `-RemainingPhases` modes through one `Invoke-RestrictedPoolDraftTest` helper, which selects only the existing two-connection concurrency test by its exact name. Default mode no longer invokes the whole `test:draft-pool` script on `backendpool`. The first-draft SMTP scenario was not removed or altered; its execution remains in the separate SMTP-capable acceptance harness. The five-phase result above predates this runner-only selection correction; the dedicated pool-only confirmation follows.

The focused command uses the normal ownership-checked startup, current-source fingerprint, Node 24.21.0 image/runtime, isolated database identity, readiness checks and temporary dependency-volume cleanup, while skipping only the already-passed broader suites:

```powershell
$env:BUILDKIT_PROGRESS='plain'; $env:COMPOSE_PROGRESS='plain'; $env:COMPOSE_ANSI='never'; $env:COMPOSE_MENU='false'
.\backend\scripts\acceptance.ps1 -Action Test -PoolOnly
```

Result: **PASS 1/1**, 0 failed/cancelled/skipped, runner exit 0. Candidate image `sha256:1ef4e3230407a45f8c07c59714f80389234694fb74421b3ab3d1d7367228363a`; source fingerprint remains `D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF`. The only selected test is “concurrent idempotent draft sends exceed a two-connection API pool without deadlock or partial commits.” Existing assertions passed unchanged.

Identity after the five-phase run: source fingerprint `D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF`; candidate image `sha256:906a419bcb975666e646ddf0889f956a6ce1e2d2ad2f323032af02ccbc0aab7c`. The subsequent pool-only confirmation rebuilt the same source as `sha256:1ef4e3230407a45f8c07c59714f80389234694fb74421b3ab3d1d7367228363a`; the ownership-checked startup verified the current APIs against that image and Node `v24.21.0`. Worker remains stopped. Disposable database remained `phonemail_test|5432`; API readiness was rechecked at `http://127.0.0.1:3351/ready`. No task-owned runner container/process or dependency volume remained. The existing disposable API/database volumes and running API stack were retained; development data and unrelated stacks were untouched.

No SMTP-only suite was repeated in these five phases. The full npm unit/contract selection’s SMTP tests remain included in the earlier 27/27 result, and the separate local SMTP acceptance evidence is retained unchanged.

External deployment prerequisites remain separate: real OTP/SMS/IVR requires an authorized provider account, approved sender/service/template, public HTTPS callback origin, and explicit permission for real traffic. Production requires trusted TLS termination, secure proxy/cookie configuration, managed secret storage/rotation, and off-host encrypted paired PostgreSQL/storage backups with restore drills. Frontend/device/browser acceptance is unverified. Public Internet SMTP is explicitly deferred and was not tested.

The focused integration-only retry command (PowerShell, from the repository root) is:

```powershell
.\backend\scripts\acceptance.ps1 -Action Test -IntegrationOnly
```

The following Stage 1/2 notes are retained as historical evidence only. Their historical test counts, backup paths, and claims are not current Stage 3 verification.

## Historical Stage 1 repairs and evidence

* Private legacy message drafts are limited to their owner in snapshot materialization, incremental events, search/message/conversation projections, and attachment downloads. The A/B integration regression inspects private fields and downloaded bytes.
* Message writers lock the full account set in UUID order before dependent events. The controlled opposite-direction barrier test proves both requests complete, rollback is lossless, and both account event streams persist consistently.
* Active and retired phone/address reservations are serialized on canonical identity locks and enforced by database constraints/triggers across registration, phone change, aliases, lookup, and routing. Tests cover normalized variants, competing claims, and retirement races.
* Sync retention validation and page selection serialize with pruning under the account stream lock. A controlled pruning barrier returns a complete page or reset-required error, never a cursor that skips removed unread events.
* External OTP authorization is bound to provider request/SID, purpose, phone, account, and operation. Approved retries are code-bound, bounded and single-use; arbitrary-code retries, replay, concurrent use, timeout/ambiguous states, and persistence failures are tested with mocks.
* Password-created accounts cannot be taken over by OTP login. Password and OTP-only phone changes require existing account control plus separately verified target number; OTP-only changes verify both current and target numbers.
* A phone-change `Idempotency-Key` enables 15-minute lost-response recovery: the exact response token is AES-GCM encrypted in the same transaction; recovery requires the still-valid original credential, same key and identical body. Password and OTP-only HTTP tests verify exact response recovery and conflicting-body rejection.
* Durable auth throttles use canonical phone/IP HMAC keys in PostgreSQL, serialize concurrent requests, return `Retry-After`, and clean expired records. Malformed phone inputs share a bounded bucket rather than creating attacker-selected rows. A shared-database integration test exceeds limits through concurrent requests, mixed phone formats and varied malformed inputs.
* Snapshot continuation, mailbox/contact/block/privacy behavior, attachment persistence/bytes, and account continuity are covered by real HTTP/PostgreSQL regressions. Terms acceptance/version and provenance distinctions are documented.
* Stage 2 adds migration `019_stage2_profile_alias_delivery.sql`, alias activation/deletion, active-account checks, profile-picture association/access, message lifecycle/delivery records, full-message and historical-search endpoints, and conversation keyset pagination. Concurrent reply submissions, alias lifecycle/routing, snapshot changes/deletions, resumable status reconciliation, and large string-valued snapshot metadata have integration coverage.
* Local notification capability responses distinguish `supported`, `configured`, `simulated`, and `liveTested`; local mock SMS is not reported as live availability. `/live` is dependency-independent; `/ready` checks PostgreSQL and storage. Unknown outbox job kinds throw and are retried/recorded rather than being acknowledged as successful.
* Container installation now uses the committed lockfile via `npm ci`. Failed resumable-chunk database commits attempt to truncate the uncommitted file tail while still holding the upload lock.

## Historical Stage 2 local verification — Gates 2–8 (superseded)

Stage 2 local acceptance is complete. Final evidence:

* `npm run build`: passed.
* `npm test`: 24 passed, 0 failed.
* `npm run test:integration`: 15 top-level tests passed, 0 failed/cancelled/skipped, including the nested OTP-consumption subtest. It ran serially against the verified loopback API on port 3311 and isolated `phonemail_test` database on port 3310.
* The full integration run covers account-locking, alias retirement/grouping/races, auth rate limits, contacts/privacy, historical search/pagination, external OTP mock behavior, phone continuity, legacy draft privacy, sync snapshots/retention, resumable attachments, telecom callbacks, and outbox lease fencing/recovery.
* Migrations 017–024 were applied only to the isolated database. `/live`, `/ready`, and `/metrics` were checked; the service remained ready after a matched PostgreSQL and attachment-volume backup/restore drill using only the isolated project.
* Signed Twilio forms and the response-loss retry boundary were exercised with local fixtures. No live provider, paid SMS/call, Internet SMTP, external-recipient traffic, device/browser, or portal acceptance was attempted.
* Root `api.md.txt`, `security.md.txt`, `backend/openapi.json`, this handoff, and `REQUIREMENTS.md` describe actual local behavior and separate external/deployment acceptance. Migration 024 permanently reserves deleted aliases against reassignment.

## Integration verification commands

```powershell
npm run build
npm test
```

Integration tests intentionally have no implicit development target. Set `PHONEMAIL_TEST_URL` to `http://localhost:3311` and set `DATABASE_URL` from the isolated Compose project only; the required database target is loopback port 3310, database/user `phonemail_test`. Do not echo the connection string or use `.env`.

```powershell
npx tsx --test --test-concurrency=1 test/phone-change.integration.test.ts test/otp-phone-change.integration.test.ts
npm run test:integration
```

The required environment variables must be set in the same PowerShell process as each test command. `backend/test/integrationTarget.ts` rejects missing or non-isolated targets before making a request. Compose access must always include both `-p phonemail-stage2` and the isolated Compose file path above. Never stop development services to free ports.

Use this explicit Compose target for later health/resource checks; never substitute the development Compose file:

```powershell
$compose = Join-Path $env:USERPROFILE 'Documents\Codex\phonemail-repair-20260925\isolated\compose.yml'
docker compose -p phonemail-stage2 -f $compose ps --all
```

An intermediate unit run failed because the newly edited OpenAPI document had malformed braces in `OtpRegistration`; the JSON object was reformatted and the full unit suite then passed. This was introduced during Stage 1 work and repaired, not an unresolved baseline failure.

## Stage 2 checkpoint and remaining gates

Continue in the original workspace and preserve the isolated-only integration guard. Do not edit frontend source or use live/paid provider traffic.

### Gate 1 checkpoint — messaging and mailboxes

**Complete for local messaging behavior.** `listMailbox` now returns both legacy message drafts and dedicated revisioned drafts through one stable, bounded cursor page, with owner/folder-bound cursor validation and exact PostgreSQL timestamp text. Message and draft routes reject unknown fields (including BCC) rather than silently dropping them; To/CC arrays are validated before service calls. Focused integration coverage verifies historical search across 55 messages, private draft projection, To/CC locks across normal/legacy/dedicated sends, a separate forward composition without access to the original thread, all/unread/attachment/favorite filters, folders/read/favorite state, per-recipient local-commit status and read-receipt hiding, idempotent send retries, per-user deletion, and one success among concurrent replies.

Verification: `npm run build` and `npm test` passed; `test/integration.test.ts` and `test/stage2.integration.test.ts` passed against the isolated Stage 2 API/DB. BCC is deliberately unsupported and rejected. External delivery transitions are handled by the telecom/outbox gates; message delivery currently means local mailbox commitment only.

1. ~~Messaging acceptance~~ **Complete locally; external delivery status remains separately scoped to Gate 5.** The one-reply-per-parent database rule remains authoritative.
2. ~~Profiles, aliases, contacts, and privacy~~ **Gate 2 locally complete.** Migration 024 permanently reserves deleted alias addresses; the address-identity advisory lock serializes competing claims/deletion, and direct conversation lookup uses stable account IDs so aliases and phone addressing retain counterpart grouping. Three-account integration verifies that deletion does not erase historical access or authorize a third account, old aliases cannot be claimed by another user, disabled aliases cannot receive new mail, disabled/suspended accounts cannot authenticate or receive new mail, ordinary users cannot set account status, and a communication-preference update is ordered ahead of a simultaneous send. Profile/privacy snapshot and incremental enforcement, contact continuity, and notification preference enforcement remain covered by existing privacy/contacts and telecom regressions.
3. ~~Snapshot limits and pagination~~ **Complete locally.** Migration 020 adds per-account atomic snapshot-page/create quotas and an owner/creation index. Materialization is transactionally capped at 10,000 records, with at most five unexpired snapshots per account and a five-create/minute bound; page requests are bounded to 600/minute. Regression reconstructs the >250-record, >100-draft snapshot at page sizes 1, 10, and 50, verifies unique total coverage and final-page-only handoff, enforces creation throttling, and retains concurrent-mutation/deletion, account-isolation, retention-reset, BIGINT cursor, and pruning-lock coverage. `npm run build`, `npm test` (17 passed), isolated migration/rebuild, `/health`, `/ready`, and focused `test/stage2.integration.test.ts` passed.
4. ~~Attachment reliability~~ **Complete locally.** Upload streams enforce bytes without trusting Content-Length; chunk abort/failure cleanup, same-offset contention, committed-offset reconciliation, database-update failure/retry, 416 ranges, and missing/mismatched Content-Length are exercised. Per-account quota reservations serialize and are tested concurrently. MIME is inferred from recognized signatures (otherwise octet-stream); client declarations are not trusted. Uploads and message attachments persist the honest `unscanned` state, with a constrained `unscanned/pending/clean/rejected` field for a future scanner; no malware scanner/protection is claimed. Cleanup retains shared attachment storage references. Build, unit suite, and focused isolated sync/upload regression passed.
5. ~~Telecom workflows~~ **Complete locally; live acceptance remains separate.** Migration 022 persists signed provider events, IVR call state, and SMS delivery state. SMS signup requires explicit `JOIN YES` terms consent; inbound SMS/voice sender identities are used only after Twilio signature/account checks. IVR Gather supports repeat, invalid, timeout, consent, duplicate, and existing-account paths. Notification outbox processing targets active recipients only when SMS is enabled and the app is not present; it emits the requested sender/subject-only text, marks unconfigured delivery as `simulated`, supports a configured approved-template fallback for selected provider trial errors, and reconciles signed delivery callbacks monotonically. App presence can transition in both directions. Unit/provider mock tests and signed isolated integration fixtures passed; no provider call was made.
6. ~~Operations and reliability~~ **Complete for locally implementable behavior.** Migration 023 adds retention indexes. Cleanup deletes bounded batches for expired sessions, OTP authorizations/challenges and local OTP code files, recovery grants, idempotency/rate-limit records, snapshots, old provider/IVR events, terminal notification/outbox records, and old sync events under existing account locks; attachment cleanup retains active chunks and shared references. Outbox claims are capped at 25, one worker tick claims one job by default, fencing tokens prevent stale completion, exponential retry/backoff is bounded, terminal failures remain queryable and visible in `/metrics`, and unsupported job kinds fail rather than being acknowledged. Structured request logs carry request IDs and omit request bodies/secrets; database/worker/startup diagnostics retain only safe error type/code. Liveness/readiness, bounded HTTP/maintenance/outbox drain, provider configuration validation, and the isolated matched PostgreSQL/storage backup/restore drill passed. Tests simulate an expired worker lease (crash-before-send), ambiguous provider acceptance with response loss/retry, and duplicate/stale callbacks. External delivery remains at-least-once: a provider acceptance followed by lost response can cause a duplicate send; no exactly-once guarantee is claimed.
7. ~~Client contracts and integration documentation~~ **Gate 7 locally complete at Stage 2.** `backend/openapi.json` covers the implemented routes and schemas. `api.md.txt` documents request sequences, pagination, revisions/idempotency, CORS, and provider setup. Refresh rotation was added after this historical Gate 7 checkpoint; current contracts and evidence are in `VERIFICATION.md`.
8. ~~Integrated Stage 2 acceptance~~ **Complete locally.** The serialized full suite and build/unit tests pass on the isolated project. Do not use the local result to imply real-provider, frontend/device, or production-deployment acceptance.

Provider activation checklist (no live calls were made):

* Set exact environment names in secret-managed deployment configuration: `OTP_PROVIDER=twilio` for Twilio Verify; `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and optionally `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET`; `TWILIO_VERIFY_SERVICE_SID` for OTP; `TWILIO_PHONE_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` for outbound SMS; `TWILIO_APPROVED_TEMPLATE_SID` for the optional approved template fallback; `TWILIO_PUBLIC_URL` as the HTTPS origin; and `TWILIO_TIMEOUT_MS`.
* Provision an approved Twilio account, permitted SMS/voice-capable sender or Messaging Service, Verify service if OTP is enabled, and an approved Content template with variables `{{1}}` (sender) and `{{2}}` (subject) if fallback is used. Keep provider credentials outside source.
* Configure inbound SMS as POST `${TWILIO_PUBLIC_URL}/api/telecom/sms/inbound`; configure inbound Voice as POST `${TWILIO_PUBLIC_URL}/api/telecom/ivr/inbound`. The TwiML response supplies the signed POST Gather action `${TWILIO_PUBLIC_URL}/api/telecom/ivr/decision`. Outbound message status callbacks use `${TWILIO_PUBLIC_URL}/api/telecom/messaging/status?deliveryId=<delivery UUID>` generated per notification.
* Terminate public HTTPS with a publicly trusted certificate; `TWILIO_PUBLIC_URL` must exactly match the externally configured origin/path used for Twilio signature validation. Require the Twilio signature on every provider form callback.
* A future authorized one-number test must use a provider-approved account/recipient, obtain explicit approval before one call/SMS, verify signup/notification and callback state, and then disable/remove test configuration. Do not purchase a number or assume free access.
