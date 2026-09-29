# Local backend acceptance runbook

This runbook uses only the disposable acceptance project. It must not be pointed
at development, staging, or production data. The project uses synthetic local
provider fixtures; it does not send SMS, place calls, send external email, buy
services, or deploy publicly.

The source-only checksum snapshot is [`SOURCE_SHA256SUMS.txt`](./SOURCE_SHA256SUMS.txt).
It omits secrets, dependencies, build products, and runtime/test state; it does
not back up the database or attachment volume.

## Reproduce the acceptance run from a fresh PowerShell session

No inherited environment variables, pre-started API2 container, or manually
installed Linux dependencies are needed:

```powershell
$workspace = 'C:\Users\Aditya Pratap Singh\OneDrive\Documents\biuldathon\repository files'
Set-Location $workspace
docker compose -p phonemail-stage3-disposable -f .\backend\docker-compose.acceptance.yml config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Disposable acceptance Compose configuration is invalid' }
.\backend\scripts\acceptance.ps1 -Action Test
```

The repository-owned script builds one candidate image and starts an isolated
PostgreSQL 16 database, primary API, second API, and two-connection API used to
test cross-instance sync and draft-send pool contention. The script installs
the driver dependencies in an invocation-owned Linux Docker volume and runs
both API and driver on Node `24.21.0`. It runs the unit/contract/provider suite,
integration suite, fresh and upgrade migration checks, snapshot restart and
affinity/recovery drill, database outage/recovery, worker test, and constrained
network test. Readiness checks and waits have deadlines. The worker is
opt-in, stopped after its test, and disabled for ordinary API instances.

Ports are loopback-only: PostgreSQL 3350, primary API 3351, second API 3352,
worker test API 3353, and small-pool API 3354. Resource samples include API
container memory, API process RSS, and PostgreSQL client-connection counts
during integration. The script prints runtime versions, image identity, test
results, and exit codes. It refuses conflicting unowned resources and
removes only resources recorded as created by its invocation. If it creates
the stack for `Test`, it cleans it up afterward; an already-owned stack is
left available for inspection.

For a local interactive backend session, start and stop the same isolated
stack explicitly:

```powershell
.\backend\scripts\acceptance.ps1 -Action Start
Invoke-RestMethod 'http://127.0.0.1:3351/health'
Invoke-RestMethod 'http://127.0.0.1:3351/ready'
.\backend\scripts\acceptance.ps1 -Action Stop
```

Use only fictional/synthetic identities and local fixture adapters. Do not
reuse a fixed phone number: integration tests allocate valid unique fixture
numbers and account for retained test data. The runbook's health/readiness
checks do not register a user or send a message.

The acceptance project and resources are separate from the root development
project, frontend directories, and separate user backup. Never use broad
Docker prune commands or `down -v` against another Compose project. `Stop`
removes only this script's manifest-owned acceptance resources.

## Network regression details

The network test uses the same request workload and concurrency for baseline
and constrained conditions. Its simulated rural connection applies a shared
directional throughput limit of 32,000 bytes/s and 180 ms one-way latency. It
checks a lost send response and idempotent retry, multi-chunk upload with an
interrupted request and reconciliation, an 8 KiB download reconstructed from
four 2 KiB byte-range responses and compared byte-for-byte, and paginated sync
including interrupted/lost-page reconciliation. It records transferred bytes
and persisted state in addition to HTTP outcomes. Intentional
quota/expiry responses are not injected in this network scenario; the
deliberate response loss and interrupted chunk are asserted as test stimuli,
not counted as unexpected failures. These are small local regression workloads,
not whole-application load or national-scale capacity evidence.

## Client integration sequences

* **Password login:** register with explicit terms consent or use
  `POST /api/auth/login`; use the returned bearer token, or choose cookie
  transport and use cookies/CSRF on writes.
* **Renewal/logout:** bearer `POST /api/auth/refresh` with
  `{refreshToken}`; cookie transport sends the HttpOnly cookie plus
  `X-CSRF-Token`. Retry a lost refresh response immediately with the prior
  refresh credential (bounded to 90 seconds). Logout with
  `POST /api/auth/logout`.
* **OTP fallback:** request `/api/otp/request`, accept manual phone/code entry,
  then call the operation-specific signup/login route. Local fixture status
  is not proof of real-world phone ownership.
* **Phone change:** authenticated `/api/auth/phone-change`; password accounts
  reauthenticate and prove the new number, OTP-only accounts prove both old
  and new numbers. Reuse the same `Idempotency-Key` and identical body only
  to recover a lost response.
* **Mailbox/message send:** page `GET /api/conversations` or
  `/api/conversations/mailbox/{folder}`; fetch bodies separately with the
  message detail endpoint. For send retry, reuse the same `Idempotency-Key`
  and identical payload. BCC is rejected.
* **Draft conflict:** read the revision and send `If-Match: "revision-N"` on
  edits/send. On `REVISION_CONFLICT`, reload the draft and resolve user edits;
  do not blindly overwrite.
* **Initial/incremental sync:** page `/api/sync/snapshot` until the final page
  supplies `incrementalCursor`, then request `/api/sync?cursor=...`. Keep
  decimal cursors as strings. On `SNAPSHOT_EXPIRED` or `CURSOR_EXPIRED`, start
  a fresh snapshot. Streaming snapshots above 10,000 records require
  continuation/close requests on the owning API; route with instance affinity.
* **Resumable upload:** create with `X-Upload-Mode: resumable`, `X-Filename`,
  and `X-Expected-Bytes`; PATCH chunks with the last confirmed
  `X-Upload-Offset`. After interrupted/lost responses, GET
  `/api/uploads/{id}/status` before retrying. Authorized downloads support
  byte `Range`.

Allowed browser origins in the acceptance configuration are exactly
`http://127.0.0.1:8080` and `http://127.0.0.1:8081`. No browser UI was built or
exercised by this backend run.

## Inspection and recovery

When the stack is running, inspect only the disposable project:

```powershell
docker compose -p phonemail-stage3-disposable -f .\backend\docker-compose.acceptance.yml ps --all
docker compose -p phonemail-stage3-disposable -f .\backend\docker-compose.acceptance.yml logs --tail 100 backend
Invoke-RestMethod 'http://127.0.0.1:3351/ready'
```

For normal cleanup use `.\backend\scripts\acceptance.ps1 -Action Stop`.
Never use `docker compose down -v`, prune commands, broad name filters, or
commands against the development project. If restore is required, restore a
matched PostgreSQL dump and attachment-volume archive together into a
separately named disposable target first; verify migrations, login, and
authorized attachment download before any approved replacement. The local
paired dump/volume-archive restore and API container recreation passed on
2026-09-26; no production/off-host restore was performed. A source-code hash
manifest is not a database or attachment backup.

## Frontend-team handoff

Point local clients at `http://127.0.0.1:3351` and send credentialed requests
only from the two configured origins or an explicitly changed local allowlist.
Keep response bodies/attachments out of list pages; use message detail and
resumable/range APIs. Support manual phone and OTP entry, password fallback,
token renewal, CSRF, idempotent retry, draft conflict recovery, snapshot reset,
and upload status reconciliation. Update authenticated app-presence state
rather than inferring it from signup channel. The backend does not provide
automatic OTP reading, device permissions, frontend rendering, or evidence of
low-RAM browser performance.
