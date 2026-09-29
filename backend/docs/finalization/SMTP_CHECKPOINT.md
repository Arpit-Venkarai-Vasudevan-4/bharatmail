# SMTP implementation checkpoint

Date: 2026-09-27
Workspace: C:\Users\Aditya Pratap Singh\OneDrive\Documents\biuldathon\repository files
Scope: backend-only SMTP implementation and verification. Frontends and the separate user backup were left untouched.

## Current implementation state

The saved repository contains the backend SMTP implementation and ownership-checked local validation scaffolding. The basic Mailpit demo was reported successful earlier; that historical result is distinct from failure-path acceptance and is not used as evidence for those gates. The codebase includes:

- outbound transport and delivery metadata in `backend/src/transport.ts`
- recipient classification, retry logic, and attachment cleanup helpers in `backend/src/services/smtpService.ts`
- SMTP outbound/inbound flow wiring from the application entrypoints and mail routes
- isolated SMTP demo and ownership-gated runner support in `backend/scripts/smtp-demo.mjs` and `backend/scripts/smtp-acceptance.ps1`
- schema updates in `backend/migrations/030_smtp_mail.sql` and `backend/migrations/031_inbound_message_id_collisions.sql`
- focused SMTP regression coverage in `backend/test/smtpTransport.test.ts`

## Status boundary

The specified local acceptance gates have passed, including transport, real-socket MIME, TLS, timeout, outbox, mixed-recipient retry, ambiguous acceptance, inbound rollback, migration, lease recovery/concurrency, attachment storage failure, and Mailpit flow. The final full acceptance run after the latest service change also passed below. Local Mailpit success does not establish public Internet delivery.

## Verified evidence

Historical evidence from before this continuation:

- Earlier build and focused test claims remain historical and were not rerun here.
- The earlier combined-file socket test was not reliable evidence: service tests imported `smtpService` and cached config before the socket case changed environment variables, and the setup/constructor were outside its `try/finally`.

Completed in this continuation on 2026-09-27 using the cached `node:24.21.0-alpine` runtime (the host Node is 26.10.0 and does not meet `engines.node`):

- `.\scripts\run-smtp-local-tests.ps1 -Mode Socket -TimeoutSeconds 120` -> PASS; 1 test, 1 pass, 0 failures, 6.7 seconds; process exit 0.
- `.\scripts\run-smtp-local-tests.ps1 -Mode Together -TimeoutSeconds 120` -> PASS; transport/service/socket selection, 4 tests, 4 pass, 0 failures, 6.0 seconds; process exit 0.
- Both commands used Node's 15-second per-test timeout and a 120-second owned-container deadline. The runner stopped only its uniquely named test container on timeout and left no containers behind.
- The socket test used an actual SMTP connection. It asserted MIME Message-ID, Unicode subject/body, To/Cc headers, envelope recipient, accepted recipient, and individual 450 temporary / 550 permanent RCPT failures. It also verified rejection when all recipients are refused and exercises cleanup after an intentional assertion failure.
- The combined run proves the socket file runs correctly beside `test/transport.test.ts` and `test/smtpTransport.test.ts`, without importing the app configuration after it is cached by the helper tests.

Root cause established and corrected:

- `smtpTransport.test.ts` imported `smtpService`, which transitively imported and cached `config`; the same test file later changed `process.env` before dynamically importing the SMTP transport. The socket case now runs in `test/smtpSocket.test.ts` under its own Node test process and sets all SMTP configuration before importing application code.
- The server and transport are now protected by `try/finally` from immediately after server creation. The `finally` awaits the transport interface close and closes the listener even if config import, construction, sending, or assertions throw.
- Installed Nodemailer 10 exposes `close(): void`, not a callback API. The adapter now calls it directly; it does not wait for a nonexistent callback.
- Actual Nodemailer RCPT errors use `recipient`, symbolic `code: "EENVELOPE"`, and numeric `responseCode`. Mapping now reads `recipient` and gives `responseCode` precedence, rather than converting the symbolic code to `NaN`/0.
- An earlier orphan test runner for the prior combined selection ran for over two hours without captured output. Its exact Node process tree was stopped. A process audit then found and stopped only the exact stale SMTP/transport test Node processes (37 PIDs, 45 minutes to 2h25 old); no Docker resources were stopped. A follow-up check found no stale test Node processes or SMTP test containers.

Additional verification on 2026-09-27 after the draft/OpenAPI/test-runner edits:

- `.\scripts\run-smtp-local-tests.ps1 -Mode Both -TimeoutSeconds 180` -> PASS. Socket-only: 1/1. Combined transport/service/socket/OpenAPI selection: 6/6, 0 failures. Node 24 TypeScript `tsc --noEmit` exited 0.
- PowerShell AST parsing passed for `run-smtp-local-tests.ps1` and `smtp-acceptance.ps1`; `openapi.json` parsed as JSON.
- The first rerun exposed a missing comma before the newly added mail paths in `openapi.json` (four tests passed and the OpenAPI test process failed to load the JSON). The comma was corrected; the subsequent complete run above passed. The first failed attempt is not counted as passing evidence.
- The guarded `DraftPool` and `InboundRollback` modes and `smtpInboundRollback.integration.test.ts` are new but have not yet run against the demo database. Their existence is not evidence that the database-backed behaviors pass.
- Before further test work, process inspection found two old host-side SMTP probes, started at 12:48 and 12:50 and still alive more than an hour later. One command was the obsolete Nodemailer callback-close probe; the other was the earlier inline SMTP socket probe with no captured output. Only their confirmed Node PIDs (41244 and 32676) were stopped; their command wrappers exited. No Docker services were changed. A subsequent process check found no remaining SMTP test processes.
- At this inspection, the owned demo had zero containers and zero networks, with its three labeled volumes retained and recorded ports 50078/50079/50080/50081. The separate `phonemail-stage3-disposable` stack remained healthy and untouched.
- Two subsequent `-Action Test` attempts started the owned Compose services and verified backend/Mailpit readiness, then stopped only the owned containers/network because runner setup failed before any acceptance test ran. The first failure was Docker Go-template parsing of a dotted service-label key; service discovery now parses the JSON labels. The next failure was comparing the 12-character network ID in the manifest with Docker's full ID; the ownership check now verifies the full ID begins with the recorded ID. The DB/storage/mail volumes were retained both times. These attempts do not count as test results.
- After those runner fixes, the isolated `DraftPool` test ran and failed in its final database assertion because a reused UUID parameter was also compared to the JSON `text` value `payload->>'messageId'`. The test had already observed draft save, send, and idempotent response assertions, but the overall case is FAIL. The SQL now explicitly casts the message ID parameter to text; rerun is pending. The acceptance script again stopped only its owned containers/network and retained volumes.
- The next `-Action Test` run passed both database-backed regressions: the first external draft test passed 1/1, including no job on save and actual SMTP worker acceptance after an idempotent send; the injected second-recipient inbound transaction test passed 1/1, including mailbox/dedup state, attachment byte survival, and exact storage-file cleanup across retry. The later Mailpit demo step failed before its SMTP scenarios because it allocated a `+447911…` UK number but submitted `country: "US"` (`PHONE_INVALID`). `smtp-demo.mjs` now sends `country: "GB"`; the full flow remains pending. Default Test cleanup stopped its owned containers/network and retained its volumes.
- The following full `-Action Test` run passed its first-draft and inbound rollback tests (1/1 each) and the Mailpit demo: internal delivery; captured external To/CC headers and Message-ID; saved-first-draft send/retry exactly once; inbound duplicate suppression, attachment download authorization, incremental sync and snapshot; and reply `In-Reply-To`/`References`. The script exited 0 and default Test stopped only its owned containers/network while retaining volumes. Fixture allocation now validates UK E.164 values with the installed libphonenumber metadata and retries boundedly on invalid/colliding numbers.
- After finding that `finishOutbox(false)` marked retryable SMTP recipients failed after every handler error (not just terminal exhaustion), `outbox.ts` was changed to apply recipient failure only when the job is actually terminal. The shared claimed-job processing path was exported so a DB-backed test could drive the same worker state transitions while the owned demo worker was prevented from racing the fixture.
- Before the latest TLS/failure integration additions, the focused Node 24 run passed socket-only 1/1 and the combined transport/service/socket/OpenAPI/outbox-worker selection 8/8; `tsc --noEmit` exited 0 and both PowerShell scripts parsed successfully. The expanded acceptance results follow below.
- The subsequent `Together` selection passed 11/11: recipient/transport behavior, isolated socket/MIME, trusted STARTTLS, untrusted certificate rejection, finite SMTP greeting timeout, OpenAPI and outbox shutdown tests.
- The ownership-checked `SmtpIntegration` selection then passed 6/6: both draft/pool cases; actual DB-backed 450/550 mixed-recipient retry with one attempt for accepted/permanent recipients and two for the temporary recipient; real post-DATA socket loss remaining `acceptance_unknown`; second-recipient inbound rollback/attachment preservation/deduplicated retry; and fresh plus pre-029 upgrade migrations (31 total). The first combined integration attempt was 5/6 because the test incorrectly assumed `To` header ordering; the assertion now compares the recipient set order-independently and the rerun passed.
- The mixed-recipient test established and passed the retry bug: outbox failure now requeues the job without prematurely terminalizing temporary recipient state; the retry's SMTP envelope includes only the temporary recipient, while original headers remain present. Permanent rejection remains failed and the accepted recipient is not resent.
- After the outbox fix, `smtp-acceptance.ps1 -Action Test -KeepRunning` rebuilt and passed the DB integration selection and complete Mailpit demo, leaving the owned stack running. Later expanded selections also passed.
- `run-smtp-local-tests.ps1 -Mode OutboxLease` passed 1/1 against the owned PostgreSQL database: a valid unexpired lease was not reclaimed; after simulated process loss/expiry, two concurrent `claimOutbox` callers acquired the job exactly once, and the shared worker completion path marked it sent with the expected attempt count. The runner paused only the manifest-verified SMTP backend during this DB-only test and resumed it in `finally`.

## Acceptance status after prior reported demo success

Preserve the per-run evidence above as history; failed attempts are not passes. Later successful gates supersede the older preliminary “outstanding” and “current known status” lists. The prior run recorded passing mixed-recipient delivery/retry/counters, post-DATA uncertainty, worker lease recovery/concurrency, inbound attachment rollback, fresh/upgrade migrations, MIME/reply headers, incremental sync, TLS success/rejection, timeout, API/OpenAPI, and the Mailpit demo.

Latest additional gate on 2026-09-27:

- Before the service fix, the new real-database storage regression failed: Nodemailer wrapped a missing local attachment (`ENOENT`) as `ESTREAM` with `command: API`; the recipient was incorrectly recorded `acceptance_unknown`.
- `smtpService.ts` now recognizes retryable local attachment stream failures only when Nodemailer reports the pre-acceptance `API` command and the error path exactly matches a generated attachment path. Failures after SMTP command acceptance are not covered by this retry classification.
- `.\scripts\run-smtp-local-tests.ps1 -Mode StorageFailure -SmtpDemoStatePath "$env:LOCALAPPDATA\PhoneMail\phonemail-smtp-demo-resources.json" -TimeoutSeconds 120` -> PASS, 1/1, exit 0. The integration verifies queued retry state, one attempt, zero relay acceptance, and fixture cleanup. The failed pre-fix run was not counted as passing.
- `.\scripts\run-smtp-local-tests.ps1 -Mode Both -TimeoutSeconds 180` -> PASS after the service change: socket-only 1/1; combined SMTP/TLS/timeout/OpenAPI/outbox tests 11/11; Node 24 `tsc --noEmit` exit 0.
- Final `.\scripts\smtp-acceptance.ps1 -Action Test` after the storage classification change -> PASS, exit 0. The guarded DB integration selection passed 8/8 (draft pool/send, legacy draft privacy, mixed-recipient retry, storage failure, post-DATA uncertainty, inbound rollback, and fresh/upgrade migration); the worker lease restart/concurrency selection passed 1/1; the Mailpit demo passed all five scenario assertions (internal delivery, outbound capture, first-draft send/retry, inbound mailbox/sync/attachment behavior, and threaded reply).
- The same final `-Action Test` verified the API, Mailpit, and inbound SMTP endpoints, then stopped only the owned demo containers/network and retained all three labeled DB/mail/storage volumes.
- Lifecycle behavior: `-Action Start` was run from stopped state and left all three demo services healthy/running; the final default `-Action Test` exercised its auto-stop behavior; an earlier completed `-Action Test -KeepRunning` left the stack available, and `-Action Stop` removed only its owned containers/network. These lifecycle results are distinct from SMTP delivery gates.
- Current local acceptance checklist: PASS. Public Internet SMTP delivery is not part of this isolated Mailpit validation and is not claimed.

## Resource ownership and runner behavior

The isolated demo uses project name `phonemail-smtp-demo` and writes ownership state to:

- `%LOCALAPPDATA%\PhoneMail\phonemail-smtp-demo-resources.json`
- `%LOCALAPPDATA%\PhoneMail\phonemail-smtp-demo-compose.env`

The runner remains scoped to owned resources only, preserves local Docker state, and avoids destructive cleanup beyond the project-owned stack.

The focused unit/socket checks use `backend/scripts/run-smtp-local-tests.ps1`. It creates a uniquely named temporary dependency directory and uniquely named Node 24 test containers, applies finite install/test deadlines, and removes only its own temporary directory. The verified runs left no such container running.

## Commands

Start the isolated demo while leaving the stack healthy and running:

```powershell
Set-Location 'C:\Users\Aditya Pratap Singh\OneDrive\Documents\biuldathon\repository files\backend'
$env:BUILDKIT_PROGRESS='plain'; $env:COMPOSE_PROGRESS='plain'; $env:COMPOSE_ANSI='never'; $env:COMPOSE_MENU='false'
.\scripts\smtp-acceptance.ps1 -Action Start
```

Run the SMTP demo/test flow against the current stack:

```powershell
Set-Location 'C:\Users\Aditya Pratap Singh\OneDrive\Documents\biuldathon\repository files\backend'
$env:BUILDKIT_PROGRESS='plain'; $env:COMPOSE_PROGRESS='plain'; $env:COMPOSE_ANSI='never'; $env:COMPOSE_MENU='false'
.\scripts\smtp-acceptance.ps1 -Action Test
```

Stop only the owned demo stack:

```powershell
Set-Location 'C:\Users\Aditya Pratap Singh\OneDrive\Documents\biuldathon\repository files\backend'
$env:BUILDKIT_PROGRESS='plain'; $env:COMPOSE_PROGRESS='plain'; $env:COMPOSE_ANSI='never'; $env:COMPOSE_MENU='false'
.\scripts\smtp-acceptance.ps1 -Action Stop
```

`-Action Test` stops its owned containers and network after a successful run, retaining the three data volumes. Add `-KeepRunning` to retain the stack after testing; `-Action Stop` stops/removes only those owned containers and network, not the retained volumes.

## Current known status

The owned demo is stopped after the final `-Action Test`. No `phonemail-smtp-demo` containers or network remain; its three labeled database, Mailpit, and storage volumes are retained. While running, the verified endpoints were `http://127.0.0.1:50078/ready`, Mailpit `http://127.0.0.1:50079`, and inbound SMTP `127.0.0.1:50081`. The separate `phonemail-stage3-disposable` stack remains healthy and untouched. No temporary SMTP test containers remain.

## Ownership note

The saved state is evidence of the specified locally isolated SMTP acceptance only. It does not establish public Internet delivery readiness.

## Whole-backend regression after SMTP work (2026-09-27)

The SMTP-only acceptance results above are separate from this broader regression. The repository-supported Node 24.21.0 disposable harness rebuilt `phonemail-stage3-disposable-backend:latest` from the current backend context, recreated the APIs, and verified the running `backend`, `backend2`, and `backendpool` containers all used image `sha256:18d38a75a86d2b02f4f5ac2cdbacbae7b92c2de134b501609e8c186b6c05885a` and runtime `v24.21.0`. The harness computes and rechecks the image build-input fingerprint before/after each run: `D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF`. Its isolated DB check returned `phonemail_test|5432`; integrationTarget.ts was not weakened.

- `.\scripts\acceptance.ps1 -Action Test` first ran `npm run test -- --test-timeout=60000`: **27 passed, 0 failed/cancelled/skipped, exit 0**. This is the complete `scripts.test` selection; `npm test` is the same npm script alias and was not redundantly run a second time. The runner also completed `npm run test:migrations`: fresh schema and pre-029 upgrade path passed (31 migrations, exit 0).
- Before that test run, one harness setup attempt exited 1 before tests: the saved ownership manifest predated the new source/image metadata properties. The script now adds absent fields safely with `Add-Member`; no owned data volume was removed or modified by the failed setup.
- That first full harness invocation then failed in `test/integration.test.ts` (17 passed, 1 failed, exit 1) at the existing group-reply recipient assertion. The failing assertion expected both the original group creator and the other member, but the implementation derived recipients only from the first message’s To list and omitted its sender. This was a real conversation service defect, not fixture collision or environmental failure.
- Fixed `conversationService.sendMessage` to union the original To recipients with the other current conversation members. No test assertion or integrationTarget.ts guard was weakened.
- `.\scripts\acceptance.ps1 -Action Test -IntegrationOnly` rebuilt the image from the fixed source and ran the full serialized `npm run test:integration` selection: **18 passed, 0 failed/cancelled/skipped, exit 0**. Node reported 543,403.8 ms; the runner enforces a 900-second process deadline and 60-second per-test deadline. The targeted mode used the existing owned disposable project and removed its uniquely named driver container/dependency volume.
- The 27-test npm selection ran before the separate conversationService fix. Since its test files do not contain this HTTP group-reply regression, the affected full integration selection was rerun against the fixed source; the package selection was not duplicated, avoiding a redundant rerun of its already-passing SMTP transport tests.
- `.\scripts\acceptance.ps1 -Action Test -RemainingPhases` rebuilt and verified the candidate from the unchanged source fingerprint, skipped only npm/migration/general-integration phases covered above, and passed all five remaining phases. Full results follow.
- No standalone SMTP socket/TLS/failure-injection suites were repeated in this broader run. SMTP transport/service tests included in the requested complete npm selection passed as part of the 27-test result; prior full SMTP acceptance remains separately evidenced above.

Five remaining gates, each run under the same ownership-checked Stage 3 harness using Node 24.21.0:

| Phase | Result |
|---|---|
| Streaming snapshot restart | **PASS**, exit 0. Began a >10,000-row snapshot; restarted only the owned primary API; resumed and verified the documented instance-affinity conflict, original watermark incremental handoff, fresh snapshot and cleanup. |
| Restricted database pool | **PASS 1/1**, 0 failed/skipped, exit 0. Eight concurrent idempotent draft sends against `backendpool` (pool max 2) produced one commit without deadlock/partial state. |
| Database outage/recovery | **PASS**, all `prepare`, injected `outage`, `recovered`, and `cleanup` commands exit 0. During the intentional outage: liveness 200; readiness/login/authenticated reads/registration retryable 503 and diagnostics redacted. After DB restart, old and new accounts authenticated. |
| Worker-enabled delivery | **PASS 1/1**, 0 failed/skipped, exit 0. Local notification state reached `simulated`, outbox sent once; no external provider delivery. Worker service was stopped in `finally`. |
| Constrained-network | **PASS 1/1**, 0 failed/skipped, exit 0. 30 concurrent baseline/constrained requests; verified retry of a dropped response, 64-byte interrupted upload reconciliation, 8 KiB multi-chunk upload, reconstructed range download and incremental sync page retry. Measured baseline 128 ms elapsed (p50 82.4/p95 102.6 ms); constrained 859.9 ms (p50 621.5/p95 834.1 ms); 32,000 B/s each direction and 180 ms one-way latency. 106 proxy requests, 9,756 upstream / 55,267 downstream bytes, two dropped responses, one interrupted upload. |

Runner corrections during this work:

- A first `-RemainingPhases` attempt stopped before tests because the rebuilt candidate image ID differed from the previously recorded image ID even though the build-input fingerprint matched. This was image reproducibility metadata, not a source mismatch. The option now requires the recorded source fingerprint to match and independently verifies each running API/worker against the current freshly built image and Node 24.21.0. The historical recorded image was `sha256:18d38a75a86d2b02f4f5ac2cdbacbae7b92c2de134b501609e8c186b6c05885a`; final candidate during the successful run was `sha256:906a419bcb975666e646ddf0889f956a6ce1e2d2ad2f323032af02ccbc0aab7c`.
- First remaining-phase run: snapshot restart passed, and the two-connection contention test passed, but the same test file also selected a first-draft SMTP delivery case that expected a worker/relay on `backendpool`; that API deliberately has its worker disabled and is not configured as the SMTP demo. This was a harness selection mismatch, not a draft transaction regression. The runner now selects the existing restricted-pool concurrency case by test-name pattern; the first-draft SMTP behavior remains covered by its separate passing SMTP acceptance.
- Pool, worker, network and common Node 24 commands now use a uniquely named `phonemail-stage3-driver-*` container and 900-second process deadline; test-runner cases have a 60-second per-test deadline. Timeout handling stops only that owned runner. DB outage recovery, snapshot cleanup, sampler shutdown and worker stop remain in `finally` paths. The successful run removed its dependency volume and left no test driver process/container, snapshot state file, or fault fixture.
- Successful runner command exit code was 0. Final source fingerprint: `D6D5B7F229C3B0AC66C9E798838EDC2404EE01B91F4CEC5A3C8BA1DC93BC34BF`. All current `backend`, `backend2`, `backendpool`, and stopped `worker` containers use image `sha256:906a419bcb975666e646ddf0889f956a6ce1e2d2ad2f323032af02ccbc0aab7c`; each ran Node `v24.21.0`. Database identity remained `phonemail_test|5432`. Current primary API is ready at `http://127.0.0.1:3351`; no unrelated stacks/resources were stopped.

The full npm script selection, migrations and general integration results remain separately distinguished above (27/27 pre group-recipient fix; 18/18 post-fix integration). Together with the five passed phases, the local backend verification scope requested here is complete. The tested image is not a deployment promotion. External OTP/SMS/IVR requires authorized provider provisioning, sender/template approval, public HTTPS callbacks and permission for live traffic. Production additionally requires trusted TLS termination, secure proxy/cookie configuration, managed and rotated secrets, and off-host encrypted paired DB/storage backups with restore drills. Internet SMTP remains explicitly deferred; no public mail delivery was tested.
