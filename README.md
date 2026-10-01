# Bharatmail — PhoneMail web application

Bharatmail provides a phone-number-addressed mailbox, a continuous conversation
reader, and a separate registration portal. This delivery is the web application;
native Android/iOS applications are not required for evaluation.

## Evaluator setup: one command

1. Install and start Docker Desktop (or Docker Engine with Compose). Allow internet
   access for the first image/dependency download. No host Node or PostgreSQL
   installation is needed for the Docker setup.
2. Extract the submitted source archive, or clone the public repository's `main`
   branch. Work in the directory containing this `README.md` and `docker-compose.yml`.
3. Replace the **root `.env`** with the environment file supplied separately in the
submission form. The source archive contains an empty root `.env` placeholder.
   Git deliberately does not track `.env`; when cloning, save the supplied file
   at this same location. Do not put it in `frontend/` or commit it.
4. Ensure ports **5432, 3000, 8080, 8081 and 2525** are available. Stop only conflicting
   application stacks, not unrelated Mac services. Then run:

```sh
docker-compose up
```

On installations using the modern plugin, the equivalent is `docker compose up`.
First startup builds the images, initializes PostgreSQL, runs the backend's
migrations automatically, and waits for API readiness before starting both web
services. Leave this terminal running. Docker Compose does not launch a host
browser automatically. Once the services are ready, open:

- Mailbox: <http://localhost:8080/>
- Registration portal: <http://localhost:8081/portal.html>
- API readiness: <http://localhost:3000/ready>
- API liveness: <http://localhost:3000/live>

The database has no copied owner accounts on a fresh evaluator machine. Use the
registration portal to create a disposable account. Password login works for
password-created accounts. Verification-code login is a separate method for
code-created accounts, not a second-factor step for password accounts. Real
OTP delivery requires the separately configured provider and its permitted
recipient numbers. Do not invent or bypass OTP proofs.

Registration in production-built web assets requires real approved Terms and
Privacy URLs plus the matching `VITE_TERMS_VERSION` (current backend: `mvp-1`).
The owner must supply approved pages; localhost SPA fallback pages are not legal
documents. If those values are absent or unapproved, registration is intentionally
gated, not an authentication failure. Existing valid accounts can still sign in.
Do not label a gated fresh-account demo as complete.

## Configuration and private submission files

The root `.env` is the only environment file required for the default Compose
stack. Compose injects backend settings and constructs the container database
URL using `db:5432`, rather than the host's `localhost`. Public frontend values
are passed as build arguments; provider credentials are never passed to the
frontend build. `.env.example` is a secret-free template, not a runnable credential
file. `JWT_SECRET` and `POSTGRES_PASSWORD` must be provided privately; there are
no operational signing-key fallbacks in the default Compose file.

Submission exports are generated **outside the repository**:

```sh
node scripts/prepare-submission.mjs
```

The command uses the existing private root `.env`, checks current source and Git
publishable branch/tag history for recognizable keys and the configured credentials,
including compressed ZIP contents, and creates:

- a source ZIP with an **empty root `.env`**, no Git history, dependencies, build
  output, database/storage contents, or credential uploads;
- a private `.env` file and an identical `bharatmail-environment-upload.txt`;
- `auth-keys.txt`, one configured credential per line in the evaluator's format:
  `file_name variable_name = "your_auth_key"`;
- a non-secret manifest describing the archive and submission locations.

In that key file, `file_name` is `.env`, and variable names are the unchanged
environment names consumed by Compose/the backend (for example `JWT_SECRET` and
`TWILIO_AUTH_TOKEN`). Blank optional keys are omitted. Upload the private files
only through the evaluator's private form, never to GitHub or a public archive.
The command does not print credentials or modify the running `.env`. If the local
JWT signer is a documented development placeholder or too short, only the private
submission copy gets a fresh cryptographically random signer. The two environment
uploads remain identical to each other.

**Local recovery security warning:** a private local Git stash contains an older
`phonemail-review-upload.zip` with a real `.env`. It is not reachable from `main`
or `origin/main`; normal `git push origin main` does not publish it. Preserve it
privately; never push `--mirror`, upload `.git`, or publish this recovery ZIP.
The newer standalone frontend ZIP was also untracked to avoid shipping a stale
duplicate of the source. The default export command stops if **publishable**
history contains credentials. For a
private form upload of **clean current source only**, use
`node scripts/prepare-submission.mjs --export-private`; its manifest records the
history blocker. This flag never makes the repository public or bypasses a
current-source credential finding.

## Stack and architecture

- Frontend: React 18, TypeScript, Vite, CSS design tokens, Lucide icons, browser
  storage/service worker, and on-demand OpenPGP/QR modules. English is the offered
  language; the catalog/selector supports later reviewed languages.
- Backend: Node **24.21.x**, TypeScript, Express, PostgreSQL 16, parameterized SQL,
  versioned migrations, cookie sessions/CSRF, resumable uploads and durable outbox
  jobs. Optional SMTP and Twilio integrations are explicit configuration.
- Deployment: separate Nginx mailbox/portal containers, same-origin `/api`
  forwarding to the backend, health-gated startup and persistent named volumes.

`frontend/` is the completed web application used by the default Compose file.
`backend/` contains the API and migrations. `e2ee-client/` and `e2ee-demo/` contain
encryption reference/client material. `web-client/`, `web-portal/` and `mobile/`
are legacy/reference projects; the two legacy web scaffolds are **not** the
default web build. The optional `mobile` profile is outside web evaluation.

The browser speaks to `/api` on its own origin. Nginx forwards these calls to
`http://backend:3000`; the backend reads/writes the Compose PostgreSQL database
and persistent storage volumes. The registration portal omits mailbox cookies
and holds its temporary credentials in memory. Internal messages are not SMS;
Twilio phone verification does not copy accounts/messages between separate
database installations.

## Engineering approach

The frontend follows the existing API contracts rather than fabricating success
states. Mailbox/history rendering is bounded. Request identities guard stale
responses; retries preserve operation identity. Draft/offline recovery,
account-scoped local data and multi-tab coordination are implemented separately
from server delivery. Optional crypto/scanner modules load on demand; bundle
budgets and service-worker caching keep initial loading constrained.

Conversation messages use chronological incoming/outgoing bubbles with centered
subject sections instead of repeating the subject in every message. Appearance
offers White, Warm and Dark, optional daily local-time scheduling, and **Reduce
Motion and Effects**. Scheduled **sending** is not implemented: it needs a durable
backend contract and must not be simulated with an open-browser timer.

Encryption, attachment handling, reply identity, delivery state and mailbox
mutations use the backend contracts actually available in this checkout. Known
unsupported contracts remain documented rather than silently claimed complete.

## Rebuild, health and shutdown

```sh
docker compose ps
curl http://localhost:3000/ready
docker compose logs --tail=100 backend
# After source or public VITE_* build settings change:
docker compose up --build
# Stop without deleting accounts, messages, uploads or database volumes:
docker compose down
```

Do **not** use `down -v` for a normal restart: it deletes persistent database and
storage volumes. A changed database password will not rewrite credentials inside
an existing PostgreSQL volume. Different Compose project names create different
volumes/databases; this explains why an account visible in another stack may be
absent here. Use `localhost` consistently for local browser cookies. A phone
needs reachable HTTPS staging for trustworthy crypto/camera/offline acceptance,
plus matching allowed origins; `localhost` on a phone is the phone itself.

## Development and verification

For host development only, use Node `>=24.21.0 <25`. Keep the Docker API running,
then from the repository root:

```sh
cd frontend
npm ci
cp .env.example .env.local
npm run dev -- --host localhost
```

Stop the container serving port 8080 before using the Vite server on that port.
Its server-side proxy is `API_PROXY_TARGET=http://localhost:3000`. Never put
provider tokens into `VITE_*` variables.

Frontend checks (from `frontend/`):

```sh
npm run check
npm run measure
```

Backend checks (from `backend/`):

```sh
npm ci
npm run build
npm test
```

Backend unit tests use disposable fixtures. Backend integration tests require a
separate disposable database and their documented environment; do not point them
at the owner's live database. Frontend live/browser suites create fixture
accounts/messages/uploads and must use local disposable accounts, never paid
provider requests. See `frontend/README.md` for suite-specific origins/prerequisites.

## Evidence and honest boundaries

- [Requirement matrix](frontend/docs/REQUIREMENT-MATRIX.md)
- [Final frontend handoff](frontend/docs/FINAL-HANDOFF.md)
- [Integration evidence](frontend/docs/INTEGRATION-RESULTS.md)
- [Conversation timeline](frontend/docs/conversation-timeline.md)
- [Appearance and scheduled-send audit](frontend/docs/appearance-implementation.md)
- [Remaining backend contracts](frontend/docs/REMAINING-BACKEND-CONTRACTS.md)
- [Owner inputs](frontend/docs/OWNER-INPUTS.md)

Historical reports describe their own dated checkout and test conditions; they
are not proof that every subsequent edit passed every test. Physical low-end
devices, human screen-reader review, real OTP/IVR/provider delivery and public
TLS deployment need their own acceptance. BCC, some attachment/reply contracts,
OTP-only encryption reauthentication and call-created-account sign-in remain
backend-dependent. Password signup's temporary lack of ownership proof is not
being changed in this submission pass. No production-readiness claim is made.

## Git submission rules

Submit the public GitHub repository URL and the final pushed commit on `main`.
Never commit environment uploads/auth keys. Do not make further commits after
the evaluator's deadline. The actual deadline was not provided to this checkout;
the owner must compare the final commit timestamp with the form's cutoff.

The evaluator's instructions request both “do not commit `.env`” and an empty
`.env` placeholder. We meet those together by leaving `.env` ignored in Git and
placing the empty placeholder in the source ZIP. The separately uploaded file
replaces it before the one-command run.
