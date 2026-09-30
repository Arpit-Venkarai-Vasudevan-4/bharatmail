# Focused composer improvements — 2026-09-30

Implemented in the existing React/Vite frontend. Backend source, database, security contracts, `.env`, message routing and send endpoints were not changed.

## Behavior

- Each national phone entry in To/Cc has its own labeled country selector. Choices follow role/address/occurrence rather than a shared country. Emails and `+`/`00` international numbers need no selector. Confirmation preserves order and roles, enforces the 50-recipient limit, rejects canonical duplicates and ignores stale results after recipient/country edits. Phone recipients are resolved through the existing per-address `/me/recipient-confirmation` contract before server draft persistence; server drafts contain canonical addresses. Opted-in local drafts retain country choices until reconnection. Existing saved-contact and encrypted identity/trust resolution remain in place.
- Encryption keeps the existing draft/conversation/attachment restrictions, with visible reasons and `aria-describedby`. The pressed lock and nearby status distinguish selected encryption from its actual key/fingerprint requirements. Failed encrypted saving keeps encrypted intent and text; no plaintext fallback. Feedback animation respects reduced motion and lite mode.
- Manual Save draft reuses the existing serialized save promise, visibly reports Saving, then Saved/Already saved/local-save status or failure. Repeated clicks cannot create parallel draft writes. Save snapshots prevent edits made during a pending operation from being marked saved prematurely; canonicalization does not drop newer body edits. Existing revision conflict and uncertain-create recovery remain in place.
- Successful saves notify Workspace through `onSaved`. Drafts refreshes its relevant list plus encrypted/local drafts without remounting the composer. A four-second cycle runs only in visible, online Drafts; hidden/offline/outside-Drafts states pause it. Search is an existing global-message view, so background draft polling also pauses while that search is active. The general 60-second refresh is unchanged outside Drafts. Existing cursor/page/scroll and open composer are retained; saved-draft list updates have a status message.

## Verification

- `npm run check`: PASS — TypeScript, 23 unit tests, 845 English catalog entries with zero extraction findings, production build/service-worker generation. Three new unit cases cover mixed roles/countries, canonical results, duplicate/50-recipient checks, changes and repeated national digits with independent country choices. Tamil draft interpolation validation passes; these additions are not fluent translation approval.
- `node scripts/test-composer-focused.mjs`: PASS — 11 grouped actual Chromium UI checks on `http://localhost:8080/`, using the production Docker frontend and live local backend. Covers mixed India To/US Cc; stale country confirmation; canonical persistence; click after autosave; delayed save and repeated clicks; conflict; missing encryption keys/no downgrade; draft/attachment mode explanation; reduced motion/lite mode; targeted polling/visibility/folder pause; real offline local save/country restoration/reconnection; encrypted enrollment/save/list/reopen; older-page/scroll preservation. Two axe scans (390px and 1280px), zero violations. [Exact results](composer-focused-results.json).
- `CLIENT_ORIGIN=http://localhost:8080 PORTAL_ORIGIN=http://localhost:8081 npm run test:ui:packaged`: PASS — six package groups including cookie/CSRF API proxying, portal isolation, legal gating, deep links, headers, caching and optional-feature precache exclusion. Current Compose configuration, no temporary Origin override. [Results](packaged-ui-results.json).
- `CLIENT_ORIGIN=http://localhost:8080 UI_ORIGIN=http://localhost:8080 npm run test:ui:ambiguous-draft`: PASS — three assertions: real server draft committed before response loss, preserved text/reconciliation, one draft after explicit reuse. [Results](ambiguous-draft-ui-results.json).
- `npm run measure`: PASS — critical entry JavaScript 96,089 gzip bytes against 204,800-byte budget. No new startup timing/device performance claim. [Measurement](bundle-measurement.json).

The focused suite asserts zero message-send and zero OTP-request UI calls. Fixtures create disposable password accounts, ordinary/encrypted drafts, an upload and an encryption identity; no SMS or external mail was sent. Success uses real API/storage/cryptography. Delayed response, conflict, offline mode and reduced-motion/visibility conditions are controlled browser tests/emulation. Initial harness failures were corrected for the real offline-setting label and its asynchronous checkbox update, status scoping to the security dialog, and the existing “Previous message page” label; final run has no failure.

Docker was available. Built and started only `web-client` and `web-portal` using:

```sh
docker compose -p frontrepo -f ../frontrepo/docker-compose.yml -f compose.frontend.yml build web-client web-portal
docker compose -p frontrepo -f ../frontrepo/docker-compose.yml -f compose.frontend.yml up -d --no-deps web-client web-portal
```

The identified Vite process on 8080 was stopped to free that port for Compose. Backend/database containers stayed running and `/ready` remained healthy. Website is http://localhost:8080/; separate portal is http://localhost:8081/portal.html (also available at the website's `/portal.html`). Production registration remains legally gated as before.

## Exact files changed in this pass

Implementation:
- `src/features/mail/Composer.tsx`
- `src/features/mail/Workspace.tsx`
- `src/features/mail/types.ts`
- `src/lib/recipients.ts`
- `src/styles.css`
- `src/i18n/en.json`
- `src/i18n/ta.draft.json`

Tests:
- `tests/composer-recipients.test.ts` (new)
- `scripts/test-composer-focused.mjs` (new)
- `scripts/test-packaged-ui.mjs` (reports the actual Compose proxy conditions instead of the earlier alternate-port override)

Evidence:
- `docs/COMPOSER-IMPROVEMENTS.md` (this report)
- `docs/composer-focused-results.json` (new)
- `docs/catalog-locations.json`
- `docs/precache-manifest.json`
- `docs/bundle-measurement.json`
- `docs/packaged-ui-results.json`
- `docs/ambiguous-draft-ui-results.json`

Production `dist/` was regenerated as build output. No package/version or Compose configuration change was needed.

## Bharatmail integration — 2026-09-30

The implementation, tests, and associated evidence above were copied from the `buildfront/frontend` working copy into `bharatmail/frontend`. Bharatmail backend source, database schema, and environment configuration were not changed by this integration. `npm run check` passed (23 unit tests), `npm run measure` passed (96,089 gzip bytes for the critical route), and both Bharatmail web containers rebuilt successfully. Against the running Bharatmail stack, the focused Chromium suite passed all 11 grouped checks and the packaged client/portal smoke test passed. These live checks created disposable local test accounts and drafts in the Bharatmail database; they did not request OTP or send messages. The changes remain uncommitted in the Bharatmail Git checkout.

## Limits

No new message delivery was exercised: ordinary/encrypted send behavior uses the existing paths, with unit coverage retained, but this pass deliberately did not send messages. The existing-conversation encryption explanation follows the preserved guard; the rendered focused test directly checks draft and attachment restrictions. Cross-browser, physical-device, human screen-reader, exhaustive country/form combinations and full E2EE send lifecycle were not rerun for this focused pass. Tamil additions remain draft translations. None of these local results imply production readiness or legal/translation approval.
