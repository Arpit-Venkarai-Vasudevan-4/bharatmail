# Bharatmail submission preparation — 2026-10-01

## Prepared

- Root `README.md`: stack, architecture, approach, evaluator/host setup,
  URLs, health checks, restart/persistence rules, private uploads and limitations.
- Default Compose uses the completed `frontend/` for client and portal, passes
  public build configuration, uses same-origin API proxying and waits for API
  health. Backend receives the provided root environment. No backend application
  source or migrations were changed in this preparation pass.
- Removed operational JWT/database-password fallback credentials from the default
  Compose configuration. Required values come from the privately uploaded `.env`.
- Strengthened ignore/Docker exclusion rules; no real `.env` or private key upload
  is added to Git. Secret-free `.env.example` templates remain tracked.
- Source ZIP includes an empty root `.env` placeholder, excludes all private
  uploads/Git history/generated dependencies/storage, and contains current source.
- Separate environment text and auth-key text exports use the evaluator's
  `.env VARIABLE_NAME = "value"` format, one configured credential per line.
  The private submission environment gets a strong fresh JWT signer if the owner
  copy uses a documented/short development placeholder; owner sessions are intact.
- Preserved and included the existing uncommitted conversation/appearance work
  and integrated the two newer `origin/main` commits without overwriting them.
- Untracked the stale standalone frontend ZIP; the disk copy remains recoverable.

## Executed checks

Host Node: **24.21.0**. Docker Compose: **5.5.1**.

- Frontend `npm run check`: typecheck, zero unextracted catalog strings,
  **29/29 unit tests**, production build/service worker passed.
- Frontend `npm run measure`: **97,518** critical-route gzip bytes against
  **204,800** budget; passed. This is bundle size, not a new LCP measurement.
- Backend `npm run build` and `npm test`: **27/27 database-free tests**, zero
  cancellations; both outbox-shutdown checks passed under the required Node.
- `docker compose config --quiet` and `git diff --check`: passed.
- Built completed mailbox and portal images successfully.

### Fresh source/archive rehearsal

Extracted the source ZIP, replaced its empty `.env` with the privately supplied
environment, and built/started its Compose stack using a **new** project
`bharatmail-submission-rehearsal` and new named volumes. API/database/website/portal
all became healthy. All migrations ran on the fresh database.

To avoid stopping the owner's stack, the rehearsal used a port-only overlay:
database 15432, API 13000, client 18080, portal 18081 and inbound SMTP 12525. Its
backend CORS allowed these rehearsal frontend origins; public legal build values
were intentionally empty to test the production registration gate. Nginx used
the repository template unchanged, with **no Origin-forwarding override**.
Thus this verifies the default service graph/images and fresh-DB startup with
isolated ports, not an additional exact-default-port cold-start claim.

Against that isolated API and packaged frontend:

- `test-packaged-ui.mjs`: six grouped checks passed, including password/cookie/CSRF
  login, profile write, SPA fallback, portal cookie isolation, HTTP/cache/gzip
  headers, service-worker shell and gated registration.
- `test-conversation-timeline-ui.mjs`: nine groups passed, including a UI reply,
  parent/conversation identity, ordinary attachments, mailbox state actions,
  arrival refresh/anchoring, bounded paging, small screens, E2EE text/attachment
  decrypt, invalid-signer response rejection and key-lock plaintext removal.
- `test-appearance-ui.mjs`: four groups passed for White/Warm/Dark, persisted
  preferences, clock-emulated schedules, midnight/overlap boundaries, renamed
  effects control, keyboard/mobile layout and failed storage feedback.
- Ten axe scans (eight appearance and two timeline) reported zero violations.

No real OTP/IVR calls or paid provider delivery were triggered. Disposable fixture
accounts/messages/uploads exist only in the rehearsal database. The original
Bharatmail API remained healthy and its containers/database were not restarted.

## Secret scan scope and stash correction

The scan covers current exported source and all publishable local/remote
branches/tags, including uncompressed historical ZIP contents. Configured private
credentials and recognizable token/private-key patterns were not found in this
published history/current source. This is not proof against every unknown secret
format; keep manual secret review in the release process.

An initial scan of **all local refs** found a `.env` inside an older
`phonemail-review-upload.zip`. Read-only reachability checks identified its only
containing ref as **`refs/stash`**, not `main` or `origin/main`. The stash is local
private recovery data, not a GitHub credential leak. It was preserved, not
deleted or force-pushed. Do not publish local `.git`, push `--mirror`, or upload
that old recovery ZIP. The new source ZIP excludes Git history and private files.

## Remaining distinctions

- Before evaluating new production registration, supply actual approved Terms
  and Privacy pages/version; existing localhost SPA placeholder routes are not
  legal content. This pass does not fabricate legal approval.
- Real OTP/IVR delivery, unsupported backend contracts, scheduled **sending**,
  physical devices, human screen-reader review and public TLS are not newly
  implemented or certified. Native apps are outside web scope.
- Repository visibility and remote commit should be checked live after the final
  push; the private export's manifest records branch/HEAD/source digest.
- The evaluator's deadline was not supplied. Compare the final `main` commit
  timestamp with the form cutoff; no claim of deadline compliance is possible
  without that cutoff.

See the root README for the one-command evaluator workflow. Private files belong
only in the submission form, never in the public repository or source ZIP.
