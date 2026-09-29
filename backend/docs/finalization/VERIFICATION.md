# PhoneMail Backend Final Verification

**Verification date:** 2026-09-26  
**Workspace:** original `repository files` workspace on Windows / Docker Desktop; no Git metadata  
**Scope:** backend only. The mobile, web-client, and web-portal source trees were not edited.  
**Database target:** isolated Compose project `phonemail-stage3-disposable`, primary API `127.0.0.1:3351`, second API `127.0.0.1:3352`, PostgreSQL `127.0.0.1:3350`, database/user `phonemail_test`. Development services, frontends, separate user backup, and development data were left untouched.

## Status key and limits

* **Locally implemented and verified:** current HTTP/database or unit evidence is cited below.
* **Implemented; externally unverified:** local code and fixture behavior exist, but provider, public TLS, device, or production behavior has not been established.
* **Unverified local acceptance:** the behavior is locally testable, but this run did not exercise it; this is not described as a pass.
* **Blocked:** a concrete external dependency or permission is required, listed in “External and blocked work.”
* **Deferred:** the revised requirements or product decisions explicitly put the item outside this phase.

“Test passed” means an actual current invocation exited zero. Historical Stage 1/2 counts in older checkpoints are retained only as history and are not current Stage 3 evidence.

## Final Node 24 acceptance run

The repository-owned command `.\backend\scripts\acceptance.ps1 -Action Test` was run from a fresh PowerShell process after clearing test-target environment variables and removing the previous invocation-owned stack. No manual API2 was present. Candidate image: `sha256:d0b7b0da33b8d782cb018e0638808ad7f07aa2435b39a9fc7886e9ad15f7aa4e`; API image uses Node `24.21.0-alpine`, and both APIs and the test driver ran on Node `v24.21.0`. Overall command exit code: **0**. The invocation removed its containers, network, volumes, and driver dependency volume after success.

| Check | Result |
|---|---|
| Clean Linux driver dependency install | `npm ci`: 122 packages, exit 0; isolated Docker volume, removed by the invocation. |
| Unit/contract/provider suite | 27 passed, 0 failed/skipped; exit 0. Includes deterministic invalid-phone rejection/uniqueness and retained-identity collision tests. |
| Fresh/additive migrations | Fresh PostgreSQL applied all 29 migrations. Upgrade fixture applied 001–028, then additive 029. Both passed. |
| Complete serialized HTTP integration | 18 passed, 0 failed/cancelled/skipped; exit 0. Node 24 driver; same-image primary and secondary APIs; explicit disposable DB/network. |
| Streaming snapshot restart/affinity | Restarted owner API returns `SNAPSHOT_INSTANCE_AFFINITY_REQUIRED`; original incremental watermark and a fresh snapshot recover; exit 0. Production TTL remains 15 minutes. |
| Concurrent draft send / small pool | Eight-way idempotent draft sends against a two-connection API pool; one message/delivery/outbox/idempotency commitment, no deadlock, follow-up ordinary request succeeds; exit 0. |
| Database outage/recovery | During loss: liveness 200; readiness, login, authenticated reads, and registration returned retryable 503, with redacted diagnostics and no outage-time registration commit. After restoration, existing and new accounts authenticated; exit 0. |
| Worker-enabled local fixture | 1 passed, no external delivery; opt-in worker stopped afterward. |
| Constrained network | 1 passed. Same workload of 30 requests at concurrency 30: baseline 179.9 ms elapsed, p50 141/p95 154.3 ms; constrained 872.6 ms, p50 632.2/p95 844.8 ms. Median API response payload was 497 bytes. Shared simulated connection cap 32,000 bytes/s each direction, 180 ms one-way latency. Four 2 KiB upload chunks (8 KiB), four 2 KiB range-download responses reconstructed and byte-compared, 64-byte interruption/reconciliation, 23 sync records/page size 5 with retried page, two dropped responses; persisted upload/message/sync state verified. Proxy observed 9,756 upstream and 55,135 downstream bytes over 106 requests (71 constrained). These are small regression timings, not whole-app or scale evidence. |
| Backend/DB resources during integration | Primary Node process peak RSS 106,656 KiB; secondary Node process 83,984 KiB. Docker container memory peaks: primary 68.2 MiB; secondary 41.3 MiB. PostgreSQL peak 14 client-backend connections. Sampled actual API process rows with `docker top`, container memory with `docker stats`, and PostgreSQL via `pg_stat_activity`. The separate network regression peaked at 9 DB connections. Test-driver RSS was 122,507,264 bytes and is not backend RSS. The earlier zero-RSS sampler output was defective and discarded. |
| Historical registration HTTP 400 | Unresolved. The test diagnostic and later successful reruns do not establish its original cause. |

## Current verification evidence

| Check | Actual result | Evidence / boundary |
|---|---|---|
| Clean dependency install | Isolated Linux Node `24.21.0` `npm ci`: 122 packages; exit 0. | Docker-owned volume, no Windows `node_modules` used. Node `24.21.0` used for API and test driver. |
| Final image build | Repository-owned acceptance script built the image; exit 0. | `sha256:d0b7b0da33b8d782cb018e0638808ad7f07aa2435b39a9fc7886e9ad15f7aa4e`, Node `24.21.0-alpine`, same image verified for primary, secondary, two-connection API, and worker fixture. |
| TypeScript build | `npm run build`: exit 0 as part of candidate image build. | Existing framework versions retained. |
| Unit/contract/provider tests | 27 passed, 0 failed/skipped. | Includes normalization, test fixture allocator, password, transport, OpenAPI, OTP, telecom, outbox and maintenance. |
| Full serialized HTTP/PostgreSQL regression | 18 passed, 0 failed/cancelled/skipped. | Node 24 driver; disposable target guard; integration topics include messaging, identity, aliases, auth throttles, contacts/privacy, OTP, phone change, drafts, retention, telecom, session renewal and large sync. |
| Worker-enabled operation | 1 passed; worker test API stopped afterward. | Local signed fixture outcome is simulated; no provider delivery. |
| Controlled network behavior | 1 passed with same workload/concurrency. | Baseline 179.9 ms elapsed / p50 141 / p95 154.3; constrained 872.6 ms / p50 632.2 / p95 844.8. Shared simulated connection cap 32,000 bytes/s each direction, 180 ms one-way latency; transferred 9,756 upstream and 55,135 downstream bytes over 106 requests (71 constrained), with two dropped responses and one interrupted upload. |
| Database loss/recovery | Isolated fault probe passed outage and recovery phases. | Liveness stayed 200; readiness/authenticated/storage-dependent operations returned retryable 503; diagnostics redacted; no partial registration; existing and new accounts worked after recovery. |
| Draft transaction pool contention | Eight concurrent idempotent sends passed against pool size two. | Exactly one send commitment and event/outbox state; client release and later request availability verified. |
| Security audit/notifications | 18-test integration suite includes owner-scoped audit and durable notification tests. | 029 fresh/upgrade migration, operation rollback, owner isolation, metadata redaction, bounded/coalesced failed-auth and credential replay coverage. Local in-app only. |
| API/container/DB resources | Primary: 106,656 KiB Node RSS / 68.2 MiB container peak. Secondary: 83,984 KiB / 41.3 MiB. PostgreSQL max 14 client connections. | Sampled during integration; local observations are not production resource limits. |
| Live CORS preflight | Real `OPTIONS` request returned 204 for configured origin `http://127.0.0.1:8080`, credentials enabled, and Authorization/cookie-CSRF/idempotency/draft/upload/range headers allowed. | Exposed `Retry-After`, `X-Request-ID`, `ETag`, `Content-Range`, `Content-Length`, `Content-Disposition`, `Accept-Ranges`. Unconfigured `http://evil.invalid` received 403 without `Access-Control-Allow-Origin`. |
| Fresh and additive migrations | Fresh PostgreSQL applied migrations 001–029; upgrade fixture applied 001–028 followed by additive 029. | Legacy identity ambiguity tests and migration compatibility are covered in disposable resources only. |
| Large mailbox | Reconstructed database state at 9,999, 10,000, 10,001 and 12,001 records; all IDs compared with PostgreSQL. Concurrent streams, paused continuation, abandoned/close/expiry paths and unrelated request availability covered. | Expiry releases held client; restart returns affinity error; original watermark plus a new snapshot recovers. Four active snapshots/API, 15-minute default, pinned repeatable-read DB client. Resource/capacity claims are limited to sampled local conditions. |
| Matched backup/restore and container recreation | Local disposable drill passed. PostgreSQL custom archive 364,700 bytes and attachment archive 1,502 bytes were restored into separately named database/storage volumes. | Restored API login and authorized attachment download succeeded; SHA-256 `F47FC39756503B5667EC0F697ED2B11EEE056A8E5D652B473AE9F28930F04C7D` matched before and after API container recreation. Artifacts remain outside the repository in the session `files/stage3-backup-restore-drill-20260926` folder. This is not an off-host/production backup. |
| Compose validity | Root `docker-compose.yml` and Stage 3 acceptance Compose both passed `docker compose ... config --quiet`. | This does not mean either frontend application was built or tested. |

### Verification run notes

* The latest complete invocation is the fresh-stack Node 24 run described above and in the runbook; previous Stage 3 run counts, images, and port assignments are superseded. The worker service is force-recreated from the checked candidate on every run.
* Earlier phone fixtures generated `+4479` plus eight random digits without normalization validation. The shared bounded allocator now verifies candidates through the real application normalizer, retries collisions/retained identities, and has deterministic invalid-candidate and uniqueness coverage. Production validation is unchanged.
* A historical registration assertion returned HTTP 400 once. Diagnostic status/error output was added, but available evidence does not prove the cause. Subsequent focused/full runs passing is not evidence that this original cause was identified or fixed.
* An earlier full execution failed due to separate defects subsequently diagnosed: nested pool acquisition after transaction completion caused a 500 under contention; fixture telecom signing URL mismatch caused a 401. The transaction release ordering and isolated webhook fixture alignment were repaired and their regressions passed. These known failures are distinct from the unexplained HTTP 400.
* Acceptance rehearsals exposed harness issues that are fixed: stale worker-image reuse, checking for the optional pool API before starting it, and allocating the database-outage fixture after stopping PostgreSQL. The final clean-stack run passed after force-recreating the worker, correcting startup order, and allocating both outage identities while PostgreSQL was healthy.

### Stable evidence paths

* Unit suite: `backend/test/{phone,password,middleware,openapi,otp,transport,telecom,outboxWorker,maintenance}.test.ts`.
* Stage 3 integration: `backend/test/session-renewal.integration.test.ts`, `backend/test/large-sync.integration.test.ts`, and `backend/test/network.integration.test.ts`.
* Other HTTP regressions: `backend/test/integration.test.ts`, `backend/test/stage2.integration.test.ts`, `backend/test/private-draft.integration.test.ts`, `backend/test/identity-reservation.integration.test.ts`, `backend/test/sync-retention-race.integration.test.ts`, `backend/test/telecom.integration.test.ts`, and the focused account/contact/alias/OTP suites.
* Migration evidence: `backend/migrations/025_e164_phone_identity.sql` through `backend/migrations/029_security_event_notifications.sql`.
* Contracts: `backend/openapi.json`, `api.md.txt`, and `security.md.txt`.

## Organizer backend traceability

| Organizer requirement | Implementation / evidence | Status |
|---|---|---|
| Phone-derived PhoneMail identity; password fallback if OTP is unavailable | Immutable account UUID and canonical public address; password login/registration; OTP provenance explicitly distinguishes local mock from provider verification. | Locally implemented and verified; password fallback is the local demonstration path. |
| Toll-free IVR press-1 signup and SMS signup | Signed callback routes, explicit SMS `JOIN YES` consent, bounded IVR Gather handling, deduplication/existing-account protection; `telecom.integration.test.ts`. | Local fixture verified; real toll-free number/provider acceptance blocked on an authorized provider account and explicitly approved test. |
| Web portal account registration and web/mobile inbox access | Backend auth, conversations and mailbox APIs support clients. | Backend contracts locally verified; frontend/UI behavior is owned by the other team and was not changed or tested here. |
| SMS notification text, app-presence suppression and approved-template fallback | Transactional outbox; sender/subject-only text; notification preferences/app presence; provider callback reconciliation; worker-enabled test marks unconfigured local delivery `simulated`. | Locally implemented and fixture verified; real SMS acceptance blocked on provider credentials, sender/template approval and explicit authorization. |
| Subject, one reply per parent, direct/group conversations and To/CC immutability | Conversation/message integration tests; database uniqueness and role constraints; multi-recipient composition creates a separate group. | Locally implemented and verified. |
| Inbox/Sent/Drafts/Spam/Trash/archive, filters and alias/profile settings | Bounded mailbox and conversation projections; private revisioned drafts, aliases, contacts, privacy and profile endpoints. | Locally implemented and verified at API level; client UI acceptance remains with frontend team. |
| Dockerized API and PostgreSQL | Root Compose configuration validates; isolated Stage 3 API/PostgreSQL stack is healthy and migrations apply. | Backend locally verified. Root Compose frontend services were not built or tested. |

## Revised requirements traceability (sections 1–58)

| # | Requirement | Evidence and current disposition |
|---:|---|---|
| 1 | Immutable internal user identity | UUID account identity preserved across phone change; `phone-change.integration.test.ts`. **Locally verified.** |
| 2 | Phone-number identity/normalization | Explicit international/national-region parsing, formatting equivalence, malformed/unsupported rejection and safe ambiguous-legacy handling; `phone.test.ts`, identity and migration checks. **Locally verified; real users need an explicit region or international number.** |
| 3 | Canonical PhoneMail address | Registration, uniqueness and phone-change tests. **Locally verified.** |
| 4 | Address resolution | Primary numbers/aliases and active/suspended/blocked routing tested; public identity stays stable. **Locally verified for implemented states; no extra public status taxonomy is claimed.** |
| 5 | Authoritative recipient resolution | Server-side recipient selection, account-stable direct grouping and generic unavailable behavior; `integration.test.ts`, `aliases.integration.test.ts`. **Locally verified.** |
| 6 | Safe recipient confirmation | Discoverability-aware minimal response and rate limit; `contacts.integration.test.ts`. **Locally verified.** |
| 7 | Phone verification | Purpose-bound durable local OTP and Twilio adapters; timeout/signature/SID tests. **Local fixtures verified; real phone ownership/provider behavior externally unverified.** |
| 8 | Authentication and sessions | Password and OTP sessions; 15-minute access token, 30-day refresh family, bearer/cookie rotation and 90-second encrypted lost-response recovery; `session-renewal.integration.test.ts`. **Locally verified.** |
| 9 | Account-level phone change | Atomic change retains UUID/mailbox/relationships; `phone-change.integration.test.ts`. **Locally verified.** |
| 10 | Phone-change security | Existing-account proof plus proposed-number proof; OTP-only proves both numbers; idempotent lost-response boundary. **Locally verified.** |
| 11 | Old-phone handling | Permanent retired identity reservation; no silent reassignment/forwarding; `identity-reservation.integration.test.ts`. **Locally verified.** |
| 12 | Independent recovery | Recovery without a trusted existing factor. **Explicitly deferred** by revised requirement 12; no KYC/government shortcut. |
| 13 | Mailbox folders | Inbox, sent, drafts, spam, trash and supported archive state; mailbox integration. **Locally verified.** |
| 14 | Message architecture | UUID messages, subject/body, To/CC, attachments, replies and per-user state; unsupported BCC rejected. **Locally verified.** |
| 15 | Conversation/threading | Direct/group identities, linked replies, pagination and one-reply-per-parent rule. **Locally verified.** |
| 16 | Message state machine | Local commitment/outbox and distinct provider states. **Local processing verified; live delivery transitions externally unverified.** |
| 17 | Delivery tracking | Local outbox/notification state and signed callback reconciliation. **Local fixture verified; no live delivery receipt.** |
| 18 | Read receipts | Per-user receipt and privacy filtering. **Locally verified.** |
| 19 | Owner-private drafts | Revision conflicts, private legacy/revisioned drafts, owner-only body access and idempotent send. **Locally verified.** |
| 20 | Attachments | Limits/quotas, resumable reconciliation, concurrent offset protection, range authorization, matched restore and container recreation. **Locally verified; scanner remains absent.** |
| 21 | Contacts | Private bounded CRUD and recipient confirmation; `contacts.integration.test.ts`. **Locally verified.** |
| 22 | Blocking | Backend-enforced account blocks and generic recipient error. **Locally verified.** |
| 23 | Privacy settings | Discoverability, profile visibility, read receipts, communication and SMS preferences applied to API/worker. **Locally verified with local fixtures.** |
| 24 | QR identity sharing | **Explicitly deferred** by revised requirement 24; no QR capability claimed. |
| 25 | Aliases | Lifecycle, collision/retirement rules, historical access and stable grouping. **Locally verified.** |
| 26 | Organization accounts | **Explicitly deferred** by revised requirement 26. |
| 27 | Verified organizations | **Explicitly deferred** by revised requirement 27. |
| 28 | Government/public-service communication | **Explicitly deferred** by revised requirement 28; no government integrations. |
| 29 | Structured requests | **Explicitly deferred** by revised requirement 29; ordinary messages remain ordinary messages. |
| 30 | Notifications | Durable sender/subject SMS workflow, app-presence suppression, callbacks and template fallback. **Worker/local fixtures verified; live sending externally unverified.** |
| 31 | Idempotency | Send/draft and bounded phone-change recovery; network response-loss regression proves one message. **Locally verified.** |
| 32 | Rate limiting | Durable auth/OTP and endpoint limits with `Retry-After`; canonical formatting protection and cleanup. **Locally verified.** |
| 33 | Anti-abuse | Enumeration-safe recipient responses, blocks, quotas and limits. **Implemented and locally verified for these controls; no reputation/suspension system is claimed.** |
| 34 | Spam system | Basic folder/state supported; classifier/reputation automation **explicitly deferred** as advanced spam work. |
| 35 | Authorization | Owner/member checks across mailbox, drafts, contacts, sync, and attachment byte access. **Locally verified.** |
| 36 | API security | Validation, bounded inputs, cookies/CSRF, signed callbacks, CORS allowlist, rate limiting, request IDs and redacted logs. **Locally verified for covered contracts.** |
| 37 | Database design | PostgreSQL relational migrations through 029, indexes, constraints and bounded pool; fresh and pre-029 upgrade checks. **Locally verified.** |
| 38 | Atomic phone-number transaction | Proof/history/address/account/session changes and rollback/retry behavior. **Locally verified.** |
| 39 | Data consistency | Transactional message, draft, identity and sync mutations; deterministic barriers. **Locally verified for tested workflows.** |
| 40 | Concurrency | Sorted account locks, serialized identity/OTP/upload/sync operations. **Locally verified for regression cases.** |
| 41 | Soft delete/data lifecycle | Per-user deletion/tombstones and bounded retention maintenance. **Locally verified for tested cases; comprehensive legal erasure/retention policy remains undefined.** |
| 42 | Search | Authorized bounded message search and historical results. **Locally verified for MVP; advanced search explicitly deferred.** |
| 43 | Pagination | Stable keyset pages and complete 12,001-record snapshot reconstruction; larger snapshot stream requires instance affinity. **Locally verified at tested sizes; maximum production resource capacity unverified.** |
| 44 | Background processing | Bounded leased/fenced outbox worker, retry and terminal visibility; `worker-enabled.integration.test.ts`. **Local worker verified; external effects are at-least-once, not exactly-once.** |
| 45 | Caching | No cache is necessary for current private-data behavior. **Deferred; no caching requirement is claimed as implemented.** |
| 46 | Audit logging | Transactional structured events for supported account/authentication/phone/alias/privacy/message operations; known-account failures are coalesced and unknown accounts create no linked event. Bounded batch cleanup purges after 365 days (operational retention, not legal compliance). **Locally verified.** |
| 47 | Observability | `/live`, `/ready`, request IDs, bounded request/outbox metrics and safe structured logs. **Locally verified at API level; distributed tracing is not implemented.** |
| 48 | Encryption/transport | Password hashing, hashed refresh secrets and encrypted bounded recovery responses. **Local mechanisms verified; public TLS termination is blocked on deployment infrastructure.** |
| 49 | Secret management | Environment-driven configuration and fixture-only local adapters. **Local pattern verified; production secret manager/rotation is blocked on deployment setup.** |
| 50 | Account security events | Owner-authorized durable in-app notifications for applicable implemented high-risk operations; transactional rollback, owner isolation, metadata filtering and retries covered. No external notifications; recovery/admin/account-deletion/device-recognition triggers are not implemented. **Locally verified for existing triggers.** |
| 51 | API versioning | Existing `/api` routes preserved. `/api/v1` migration **deferred** to avoid breaking clients. |
| 52 | Error architecture | Structured HTTP errors, request IDs and retry metadata; unit/HTTP tests. **Locally verified.** |
| 53 | Modular organization | Existing Express/TypeScript modular monolith retained. **Locally verified by build.** |
| 54 | Testing | Current counts and test commands are in “Current verification evidence.” **Locally verified**, with host Node engine caveat stated there. |
| 55 | API documentation | OpenAPI reference/path checks plus API integration sequences; live CORS preflight. **Locally verified for documented operations.** |
| 56 | MVP priority | Core identity, mailbox, messaging, aliases, privacy and upload endpoints retained. **Backend implementation verified; frontend acceptance outstanding.** |
| 57 | Future extensions | Recovery, QR, organizations/government, advanced spam and external Internet mail are **explicitly deferred** by requirements/decisions. |
| 58 | Inspect, migrate, implement, test, document | Current Stage 3 source, migration, regressions and finalization records are captured here and in the runbook. **Locally verified; external/deployment boundaries below remain.** |

## Original backend audit traceability

The audit identifiers below refer to `BACKEND_AUDIT_REPORT.md` (2026-09-24). “Fixed” means the specific regression is present in current source/tests; it does not imply production-scale capacity or live-provider success.

| Audit ID | Original finding/gap | Current implementation and evidence | Status |
|---|---|---|---|
| F01 | Another participant could expose a sender's unsent legacy draft | Owner-private projections and state access; `private-draft.integration.test.ts` checks snapshot, sync, search, read and download. | Fixed; locally verified. |
| F02 | Upload byte limit applied after disk writes | Streaming byte limiter, declared-size check, quotas and interrupted-stream cleanup; `stage2.integration.test.ts`, network regression. | Fixed; locally verified. |
| F03 | Concurrent chunks at the same offset could overwrite bytes | Per-upload lock and offset recheck; `stage2.integration.test.ts` exercises upload state; network interruption confirms offset reconciliation. | Fixed; locally verified. |
| F04 | Sync cursor could skip a later-committed transaction | Account stream locking, snapshot watermark/handoff and pruning race regression; `sync-retention-race.integration.test.ts`. | Fixed; locally verified. |
| F05 | Container recreation lost ready attachments | Named attachment volume, matched backup/restore, authorized download before/after API recreation. | Fixed; locally verified in disposable restore drill. |
| F06 | CORS preflight blocked browser workflows | Required authorization/cookie-CSRF/idempotency/revision/upload/range headers; live allowed-origin 204 and rejected-origin 403 probe. | Fixed; locally verified. |
| F07 | Legitimate message recipients could not download attachments | Sender/addressed-recipient authorization; upload integration and range tests. | Fixed; locally verified. |
| F08 | Older conversations unreadable and filters incomplete | Stable keyset conversation pagination and filters; `conversation-list-pagination.integration.test.ts`, `integration.test.ts`. | Fixed; locally verified. |
| F09 | Historical message-body matches missing from search | Authorized historical search and pagination; `integration.test.ts` covers 55-message search reconstruction. | Fixed; locally verified. |
| F10 | Message state change could persist without sync event | Transactional state+event update; integration mailbox/sync regressions. | Fixed; locally verified. |
| F11 | Oversized resumable chunk poisoned later retries | Stream limit and committed-offset reconciliation; `stage2.integration.test.ts`. | Fixed; locally verified. |
| F12 | Range response returned wrong bytes/metadata | Single-range parsing, 206/416 and `Content-Range`; `stage2.integration.test.ts`, restored byte-range probe. | Fixed; locally verified. |
| F13 | Phone formatting bypassed auth throttling | Canonical-number keyed durable throttle; `auth-rate-limit.integration.test.ts`. | Fixed; locally verified. |
| F14 | OTP resend cooldown failed after first allowed resend | Canonical phone resend reservation; `otp.test.ts`. | Fixed; locally verified. |
| F15 | Production session cookie was not Secure by default | Secure cookie derives from production configuration; `transport.test.ts` and config review. | Fixed in code; production proxy/cookie deployment remains externally unverified. |
| F16 | Database outage appeared as invalid credentials | Isolated DB-stop fault probe tests login and authenticated storage reads during outage. | Fixed and locally verified: retryable 503, not wrong credentials; no secret diagnostics. |
| F17 | Readiness stayed healthy after database failure | Same outage probe verifies liveness and readiness with DB stopped and recovery. | Fixed and locally verified: liveness remains 200, readiness becomes unhealthy, recovers after DB restore. |
| F18 | Malformed/oversized input violated error/limit contract | Request/body limits, validation and safe error envelopes; unit, upload, and integration tests. | Fixed; locally verified for covered paths. |
| F19 | Group replies omitted original sender from delivery recipients | Group membership/delivery recipient construction; `integration.test.ts` group/message regressions. | Fixed; locally verified. |
| F20 | Draft send could change locked To/CC roles | Draft-send validation and immutable existing-thread recipient roles; integration draft/send regressions. | Fixed; locally verified. |
| F21 | Draft sends could exhaust pool while holding connections | Eight synchronized idempotent draft sends against a deliberate two-connection API pool, including completion/event/outbox state and a follow-up ordinary request. | Fixed and locally verified; nested connection acquisition removed and no deadlock/partial commit reproduced. |
| G01 | OTP authentication/provider setup gap and external blocker | Durable local OTP plus provider adapters, exact SID binding, timeouts and fixture tests. | Local portion implemented/verified; real provider credentials and delivery are blocked on provider provisioning/authorization. |
| G02 | Multi-client sync coverage gap | Complete 12,001-record local reconstruction and explicit cross-instance affinity error without source-snapshot invalidation. | Locally verified under documented affinity requirement; routing through a multi-instance load balancer is unverified. |
| G03 | SMS notifications and IVR account creation gap | Signed local SMS/IVR fixtures, app-presence/preference behavior, worker-enabled simulated send. | Local portion implemented/verified; live toll-free/SMS trial is blocked on provider approval and permission. |
| G04 | External email/inbound mailbox delivery gap | Local mailbox API and non-relaying MIME harness only. | Internet SMTP and inbound external mail are **explicitly deferred** by revised requirements; no external delivery claim. |
| G05 | Profile/alias/recovery completeness | Profile, aliases, contacts/privacy and permanent identity retirement have HTTP tests. | Local account/profile/alias portion verified; recovery without a trusted factor is explicitly deferred. |
| G06 | OpenAPI/capability accuracy | OpenAPI schema/reference/path checks, refresh contract, capability fixtures and live CORS preflight. | Locally verified for implemented API; frontend consumption remains unverified. |

## Remaining external, blocked, or unverified acceptance

1. **Live OTP/SMS/IVR:** requires an authorized provider account, permitted sender/service, approved template, public HTTPS callbacks, and explicit permission for any real call/SMS. No credentials or live traffic were used.
2. **Frontend/device acceptance:** the mobile, web-client and portal teams must exercise manual phone/code entry, bearer/cookie/CSRF behavior, refresh, mailbox lists and detail fetches, attachment ranges/resume, and app-presence updates. No frontend build or browser/device test is claimed.
3. **Production deployment:** requires trusted TLS termination, secure proxy/cookie configuration, secret manager and rotation, off-host encrypted paired backups, and ongoing restore drills. Local TLS is not configured.
4. **Malware scanning:** attachments correctly remain `unscanned`; no scanner is integrated or claimed.
5. **External Internet mail:** SMTP interoperability/inbound Internet delivery is explicitly deferred. Local mail persistence and PhoneMail mailbox messages are not Internet mail delivery.
6. **Full capacity:** the measured request workload and 12,001-record fixture are bounded regressions, not national-scale or high-load evidence. Streaming snapshots pin up to four database connections per API instance and require affinity. Production peak limits and latency targets require an agreed deployment target and capacity plan.

The final source-only hash manifest is [`SOURCE_SHA256SUMS.txt`](./SOURCE_SHA256SUMS.txt); it is not a database or attachment backup. The separate user backup, frontend files, development services and development data were preserved.
