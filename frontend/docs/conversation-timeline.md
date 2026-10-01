# Continuous conversation reader — local acceptance

Implemented in the existing `frontend/` only. Desktop and mobile share the bubble timeline; mailbox navigation, compose/send logic, backend, database, authentication and Compose configuration were not edited. Only the web-client container was rebuilt/recreated; the existing backend, database and portal stayed running.

## Changes

- Chronological incoming-left / outgoing-right bubbles with full ordinary bodies, centered subject-section headings, sender addresses and locale-aware date/time.
- Consecutive subject sections show the subject once outside the bubbles and separate subject changes with a subtle divider. Replies inherit their loaded parent subject; conventional Re: prefixes are normalized. Returning to an earlier subject later starts another section to preserve chronology. Locked encrypted roots are not merged merely because their public placeholders match; known replies share the root section. Decrypted headings clear again when keys lock.
- Safe attachment preview/download and existing encrypted-message decryption/download handlers on each message. Ordinary forwarding remains unavailable for encrypted messages.
- Per-message reply/full-details controls and keyboard-operated expandable actions: recipients, favorite, read/unread, archive/spam/trash, restore, delivery, ordinary forwarding and block-contact control.
- Older-page scroll anchoring, at most 60 rendered messages, explicit return to latest history. Latest-window arrivals reuse the existing mailbox refresh cadence; readers at the bottom follow arrivals and readers above retain their visible anchor. A bounded older-history window is retained until explicit latest-history navigation.
- Narrow-screen wrapping and scoped contrast corrections for sender, header and attachment metadata. Footer reply targets the latest loaded message.

## Executed checks

`npm run check` passed: TypeScript, catalog extraction audit (zero unextracted strings), 26 unit tests (including three subject-group regressions), production build and service-worker generation. `git diff --check` passed.

`node scripts/test-conversation-timeline-ui.mjs` passed all 9 grouped browser checks against the packaged frontend at `http://localhost:8080` and real local API at port 3000. Disposable password accounts and local-only recipients were used; no SMS or provider traffic was requested. Detailed results: `conversation-timeline-results.json`.

Browser checks covered both message directions, text beyond 500 characters, attachment preview, an actual UI reply with API verification of conversation and parent identity, delivery/full-details dialogs and focus return, state mutations and restore, ordinary forward opening, incoming API fixtures displayed through browser refresh, scroll anchoring on arrivals and three older pages, 60-message bound, latest-history navigation, group content, and long unbroken text. Desktop and mobile reader axe scans had zero violations after contrast fixes.

Two isolated browser contexts enrolled and independently compared their own fixture identity payloads. A real encrypted message with attachment was sent, decrypted, downloaded and locked through UI. A deliberately altered signer field in a fetched response was rejected with the signature warning and no plaintext; the genuine response decrypted successfully. This is fault injection in the browser response, not an invalid signature created on the backend.

Conditions: headless installed Chrome on the local Mac; desktop 1440×1000, tablet 768×844, narrow 390×844 and 320×844 viewports; CSS 200% zoom emulation. Desktop/mobile screenshots were inspected. Backend readiness remained healthy.

## Failures repaired and boundaries

The initial full-body assertion incorrectly compared a full message with the mailbox's truncated preview; it now compares the exact fixture body. Pagination and encrypted-row selectors were corrected to select the actual rendered controls and wait for the intended refreshed row. Reader accessibility scans discovered low-contrast inherited header/attachment/mobile sender text; scoped styles corrected these and both scans passed on the final run.

No physical-device, human screen-reader, Firefox or WebKit acceptance is claimed. CSS zoom is not a physical browser zoom test. Live-arrival tests used the existing refresh control, not a timed 60-second wait. Block-contact's control and existing handler were retained, but the new suite did not submit a block. Send retries/idempotency were not modified; this focused suite verified one reply and its identity, not interrupted retries. The existing single-message decrypted state is retained: decrypting another message replaces the previous plaintext view. The new Tamil label is draft translation content, not a reviewed approval.

## Exact changed files

- `src/features/mail/Workspace.tsx`
- `src/styles.css`
- `src/features/mail/subjectGroups.ts`
- `tests/subject-groups.test.ts`
- `src/i18n/en.json`
- `src/i18n/ta.draft.json`
- `scripts/test-conversation-timeline-ui.mjs`
- `docs/precache-manifest.json` (generated production-build evidence)
- `docs/conversation-timeline-results.json`
- `docs/conversation-timeline.md`
- `docs/screenshots/conversation-timeline-desktop.png`
- `docs/screenshots/conversation-timeline-mobile.png`
