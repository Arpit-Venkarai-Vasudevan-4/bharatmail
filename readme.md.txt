# PhoneMail MVP

PhoneMail is a phone-addressed mail and conversation service. The backend is a Node.js/TypeScript modular monolith using Express and PostgreSQL 16. Existing Expo 52 mobile and Vite web projects remain separate clients; Stage 2 changes are backend-only.

## Local development

Prerequisites: Node.js 20+, npm, and Docker Desktop. Copy `.env.example` to `.env` and replace development secrets before any non-local use. Start PostgreSQL and the API with `docker compose up -d --build`; the API is at `http://localhost:3000`. The backend migration runner applies SQL migrations before it listens. The named `backend_storage` and `backend_mail` volumes persist upload and local-mail data. Mobile startup remains `cd mobile; npm install; npm start`.

Run backend checks from `backend`: `npm ci`, `npm run build`, and `npm test`. Integration tests are guarded and must use only the explicit isolated target recorded in `backend/docs/finalization/HANDOFF.md`; do not point them at development data.

## Current backend

Authentication supports password sessions and provider-backed OTP interfaces. Phone changes preserve the account UUID and mailbox while permanently reserving the retired number. Messaging has direct/group conversations, mailbox state, drafts, bounded pagination, contacts, blocks, alias lifecycle, privacy preferences, and account-scoped sync. Attachments use opaque storage keys, bounded uploads, resumable offsets/status, authorization checks, and byte ranges.

Stage 2 is **in progress, not complete**. Local implementation and regression coverage still have gaps listed in `backend/docs/finalization/REQUIREMENTS.md` and `backend/docs/finalization/HANDOFF.md`. In particular, inbound SMS/press-1 IVR signup, provider-backed mail SMS notifications, Twilio-signed Messaging webhooks, complete outbox shutdown/recovery, full attachment crash reconciliation/scanning, and complete client contracts are not finished.

`/live` reports process liveness; `/health` is a legacy dependency check; `/ready` requires PostgreSQL and writable storage. `/api/capabilities` distinguishes provider support, configuration, simulation, and live testing. Local OTP/SMS fixtures are simulations only; no external SMS, call, SMTP delivery, or provider callback was used. Twilio Verify tests use deterministic mocks.

## Security and operations

Use HTTPS with a trusted certificate in deployment; TLS is transport security, not end-to-end encryption. Keep credentials in environment/deployment secret storage, not source or logs. Back up PostgreSQL and the configured attachment storage as one coordinated recovery point; restore testing and encryption/key-management procedures remain deployment gates. External delivery is not exactly-once and queued jobs must be reviewed after recovery.

Compose binds database/backend services for local use. Remove public database port publishing and configure strict CORS and secret values before deployment. This project does not claim active malware scanning or external Internet SMTP interoperability.
