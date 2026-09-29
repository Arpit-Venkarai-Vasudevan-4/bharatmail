# PhoneMail website requirement matrix

All 68 historical blueprint sections are traced in 126 assessable groups. The current authoritative delivery is the responsive website and separate registration portal, **English only**, with unified Home primary. Native apps and additional launch languages are outside delivery; navigation is resolved. The original [blueprint](BLUEPRINT.md) remains historical context, not a conflicting new instruction.

“Implemented and tested” applies only to the named website behavior/evidence. API/module checks, browser UI, controlled faults, emulation and physical acceptance are distinct. Provider/IVR configuration is not live delivery acceptance. See [integration evidence](INTEGRATION-RESULTS.md), [owner inputs](OWNER-INPUTS.md), [backend proposals](REMAINING-BACKEND-CONTRACTS.md) and [scope](NATIVE-SCOPE.md).

## 1. Frontend Objective

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 1.01 — Phone-number public identity; backend UUID retained internally; no VPA/UPI replacement | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Phone/address/contact entry and ordinary UI UUID checks passed; backend architecture unchanged. |
| 1.02 — Rural comprehension, accessibility, low-bandwidth and smaller-screen usability | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | Rendered/emulated checks support the website; rural user research and physical low-end hardware acceptance remain. |

## 2. Existing Frontend Architecture

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 2.01 — Inspect/reuse existing React, Vite, TypeScript and backend contracts; preserve versions and architecture | `package.json`; `vite.config.ts`; `../frontrepo/mobile/App.tsx` | `NATIVE-SCOPE.md` | implemented and tested | Existing client and portal remain entry points in this project, without duplicated scaffolds. |
| 2.02 — Expo 52 / React Native 0.76.9 native surface and appropriate native persistence | `package.json`; `vite.config.ts`; `../frontrepo/mobile/App.tsx` | `NATIVE-SCOPE.md` | outside current delivery | Authoritative product decision: native Expo, iOS/Android apps, APKs and stores are outside this website/portal delivery; no owner scope decision is pending. Historical source assessment only. |

## 3. Product Surfaces

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 3.01 — Native app: onboarding, verification, authentication, folders, compose/read/reply/forward, contacts/search, profile/privacy/notices/blocking/security and phone change; one-handed UX | `src/App.tsx`; `src/features/auth/AuthScreen.tsx`; `src/portal.tsx`; `../frontrepo/mobile/App.tsx` | `packaged-ui-results.json`; `responsive-ui-results.json`; `NATIVE-SCOPE.md`; `otp-continuity-ui-results.json` | outside current delivery | Authoritative product decision: native Expo, iOS/Android apps, APKs and stores are outside this website/portal delivery; no owner scope decision is pending. Historical source assessment only. |
| 3.02 — Responsive web: same backend/account model; single column/touch navigation on small screens; persistent split-pane sidebar on desktop | `src/App.tsx`; `src/features/auth/AuthScreen.tsx`; `src/portal.tsx`; `../frontrepo/mobile/App.tsx` | `packaged-ui-results.json`; `responsive-ui-results.json`; `NATIVE-SCOPE.md`; `otp-continuity-ui-results.json` | implemented and tested | Chromium web acceptance covers both widths. No separate incompatible domain model introduced. |
| 3.03 — Public portal: phone formatting, OTP registration, success/failure and transition, without a second mailbox or internal IDs | `src/App.tsx`; `src/features/auth/AuthScreen.tsx`; `src/portal.tsx`; `../frontrepo/mobile/App.tsx` | `packaged-ui-results.json`; `responsive-ui-results.json`; `NATIVE-SCOPE.md`; `otp-continuity-ui-results.json`; `local-acceptance-ui-results.json`; `packaged-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | implemented and tested | Valid portal OTP signup, wrong-code UI, revocation failure/retry, revoked bearer token, next-registrant reset and mailbox-cookie isolation pass in Chromium/Firefox/WebKit against isolated local sink. Real provider and approved production legal inputs remain separate release gates. |

## 4. Design Philosophy

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 4.01 — Familiar Compose, unread state, navigation/back, cards, search, reply and ordinary forward; established branding | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Actual rendered workflows passed; no unrelated redesign. |
| 4.02 — Plain language, no unnecessary animation, visual clutter, jargon or hidden critical controls | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | partial | New guidance and labels added. Advanced encryption still needs rural comprehension review; desktop secondary icons have accessible labels but not all visible text. |

## 5. Accessibility Requirements

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 5.01 — Semantic web controls, labeled dialogs, visible focus, keyboard return, validation/live regions and representative text contrast | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Seven axe scans have zero violations; Escape focus restoration and mobile controls exercised. Automated coverage is limited to named views. |
| 5.02 — Scalable text, comfortable targets everywhere, logical tab order, icon-plus-text comprehension and screen-reader use | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `layout-resume-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | partial | Keyboard login, dialog Tab wrap/Escape/focus return, tablet widths, emulated content zoom 200% and text scaling 150% tested. Human assistive technology, browser-chrome zoom and physical touch/keyboard acceptance remain. |

## 6. Language Accessibility

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 6.01 — Central catalogs, real runtime selector, English interface, persisted preference/backend sync; invariant addresses and fingerprints | `src/i18n/index.ts`; `src/i18n/en.json`; `src/i18n/ta.draft.json`; `src/i18n/LanguageSelector.tsx` | `auth-final-ui-results.json`; `tests/i18n.test.ts`; `TRANSLATION-REVIEW.md` | implemented and tested | Ordinary development and production offer English only. Stored Tamil falls back to English; profile save preserves backend language. Optional review overlay requires explicit flag. |
| 6.02 — Tamil as an approved launch interface | `src/i18n/index.ts`; `src/i18n/en.json`; `src/i18n/ta.draft.json`; `src/i18n/LanguageSelector.tsx` | `blueprint-ui-results.json`; `tests/blueprint.test.ts`; `TRANSLATION-REVIEW.md`; `locale-ui-results.json` | outside current delivery | English is the only launch language. Tamil remains an unapproved optional review overlay behind VITE_TRANSLATION_PREVIEW=true; review/approval is future work, not a launch requirement. |
| 6.03 — Additional languages through lazy catalog loaders | `src/i18n/index.ts`; `src/i18n/en.json`; `src/i18n/ta.draft.json`; `src/i18n/LanguageSelector.tsx` | `blueprint-ui-results.json`; `tests/blueprint.test.ts`; `TRANSLATION-REVIEW.md`; `locale-ui-results.json` | implemented but unverified | Lazy loader and token validation retained; additional available languages require reviewed catalogs and focused acceptance when added. No dummy choices. |

## 7. Onboarding

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 7.01 — Local OTP signup journey: enter phone, request/verify, create account, display real address, enter mailbox; short skippable explanation | `src/features/auth/AuthScreen.tsx`; `src/lib/api.ts` | `otp-continuity-ui-results.json`; `multitab-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | implemented and tested | Legitimate isolated sink proofs used through rendered controls. Home is the mailbox entry point. |
| 7.02 — Public registration/onboarding launch | `src/features/auth/AuthScreen.tsx`; `src/lib/api.ts` | `otp-continuity-ui-results.json`; `multitab-ui-results.json` | external-input-dependent | Approved Terms/Privacy URLs, content and matching version required. Production gate remains active; actual provider delivery separate. |
| 7.03 — Configurable inbound call-registration website entry, safe unavailable default, normalized tel/copy and normal sign-in continuation | `src/features/auth/IvrRegistration.tsx`; `src/features/auth/registration.ts`; `.env.example`; `Dockerfile` | `auth-final-ui-results.json`; `auth-edge-ui-results.json`; `tests/registration.test.ts` | partial | Unavailable and configured UI states verified locally without a call. Official number/provider/consent and backend call-created account sign-in need owner activation; website scaffold is not live IVR acceptance. |

## 8. Phone Number Input

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 8.01 — Country/international prefix, formatting tolerance, obvious invalid-input checks, human errors and backend canonical normalization | `src/features/auth/contracts.ts`; `src/features/auth/PhoneField.tsx`; `src/lib/recipients.ts` | `tests/blueprint.test.ts`; `blueprint-ui-results.json`; `otp-continuity-ui-results.json` | implemented and tested | US/India-compatible parser and actual canonical phone resolution exercised; frontend validation is not authorization. |
| 8.02 — Comprehensive region/autofill input behavior | `src/features/auth/contracts.ts`; `src/features/auth/PhoneField.tsx`; `src/lib/recipients.ts` | `tests/blueprint.test.ts`; `blueprint-ui-results.json`; `otp-continuity-ui-results.json` | implemented but unverified | Physical keyboards, SMS autofill and broader country-number examples remain unverified. |

## 9. OTP Experience

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 9.01 — OTP input/focus, wrong-code correction, resend control/countdown, loading and interrupted-request/reload recovery | `src/features/auth/AuthScreen.tsx`; `src/lib/api.ts` | `otp-continuity-ui-results.json`; `multitab-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | implemented and tested | Real sink-backed signup/login, wrong-code, resend and interrupted-request acceptance retained. New challenge ownership, timestamp expiry/resend, Retry-After, late response and channel reset tests distinguish live from controlled fixtures. |
| 9.02 — Expiry/attempt-limit feedback and platform paste/autofill | `src/features/auth/AuthScreen.tsx`; `src/lib/api.ts` | `otp-continuity-ui-results.json`; `multitab-ui-results.json`; `local-acceptance-ui-results.json` | partial | Wrong, expired and exhausted-attempt codes have rendered local UI evidence; Retry-After/timestamp edge cases use controlled responses. Paste uses a single ordinary input; real device SMS autofill remains unverified. |

## 10. Authentication State

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 10.01 — Central logged-out/authenticating/authenticated/refreshing/expired/failure/logout states, cookie cleanup and backend authorization | `src/features/auth/AuthScreen.tsx`; `src/lib/api.ts` | `otp-continuity-ui-results.json`; `multitab-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | implemented and tested | Password default stays stable across delayed/failed capability discovery; exact password bytes, wrong credentials, signup/login/logout/restoration and account switching tested. OTP works for passwordless accounts; valid OTP for password accounts is rejected by current backend. Password setup/reset absent; proposals 6–7. |
| 10.02 — Account-appropriate password/OTP alternatives and secure password recovery | `src/features/auth/AuthScreen.tsx`; `../frontrepo/backend/src/services/userService.ts`; `../frontrepo/backend/src/services/telecomService.ts` | `auth-final-ui-results.json`; `auth-edge-ui-results.json`; `REMAINING-BACKEND-CONTRACTS.md` | backend-dependent | Passwordless OTP succeeds; password-backed OTP fails even with valid proof. IVR uses undisclosed random password. No secure setup/change/reset routes; proposals 6–7 define missing contracts. |

## 11. Main Application Navigation

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 11.01 — Inbox/Sent-first mobile primary navigation | `src/App.tsx`; `src/styles.css` | `NATIVE-SCOPE.md`; `responsive-ui-results.json`; `blueprint-ui-results.json` | resolved product decision | Unified Home is the approved primary mobile mailbox. Inbox, Sent and other supported folders remain accessible. This supersedes historical Inbox/Sent-first wording; no decision is pending. |
| 11.02 — Prominent Compose; access to Inbox/Sent/Drafts/Contacts/settings and Archive/Spam/Trash; back/Escape navigation | `src/App.tsx`; `src/styles.css` | `NATIVE-SCOPE.md`; `responsive-ui-results.json`; `blueprint-ui-results.json` | implemented and tested | Inbox and Sent now accessible in mobile drawer; representative back/focus behavior tested. |

## 12. Inbox

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 12.01 — Sender, subject, preview, date, unread weight/count, large rows, refresh/paging/loading/empty/error/retry/cache | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Live mailbox, 126-message paging and offline suites exercise these behaviors. |
| 12.02 — Reliable attachment indicator on every list row | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | backend-dependent | Backend list response omits selected attachment metadata. Show only authorized actual metadata; additive hasAttachments proposal documented. |
| 12.03 — Pull-to-refresh gesture | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented but unverified | Implemented for top-of-list downward swipe with refresh-button alternative; physical gesture acceptance remains. |

## 13. Message Reading

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 13.01 — Separate sender/recipients/date/subject/body/files; reply, ordinary forward, archive/trash/read/spam actions | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Core read/reply and explicit forward send exercised. State actions also have retained API evidence. |
| 13.02 — Block sender and easily understood secondary actions | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | Known contact sender resolves through authorized contact mapping and confirmation. Unsaved sender requires saving contact or proposed message-derived block endpoint. |

## 14. Compose

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 14.01 — Phone/address/contact To and CC, subject/body/files, private confirmation, multiple-recipient group creation and locked membership | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Real group recipients and unchanged thread roles tested; stale confirmation invalidated. Accessible comma-separated inputs are equivalent controls, not chips. |
| 14.02 — BCC compose | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | backend-dependent | Backend rejects BCC. Minimal privacy-preserving contract proposal; no To/CC disguise. |
| 14.03 — Attachments and encrypted new-message routing in existing conversations | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | Original sender's ordinary atomic follow-up works. Other thread attachments/atomic reply consumption require proposals; separate message requires explicit choice and may reuse direct pair. |

## 15. Recipient Confirmation

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 15.01 — Backend canonical address/name confirmation, own-contact selection, failed resolution blocks send and edits invalidate confirmation | `src/lib/recipients.ts`; `src/features/mail/Composer.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `blueprint-ui-results.json`; `tests/blueprint.test.ts` | implemented and tested | Private endpoint tested; no directory/account-enumeration lookup or UUID entry. Encryption requires contact identity and independent key trust. |

## 16. Drafts

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 16.01 — Create/update/autosave/reopen/delete drafts, navigation close, offline preservation and truthful save states | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented and tested | Browser ordinary/encrypted draft, ambiguous-create and denied-write suites pass. Revision conflicts handled without silent overwrite. |
| 16.02 — All navigation-loss cases and atomic saved reply consumption | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json`; `web-recovery-ui-results.json` | partial | Actual Back/reload guards preserve unsaved ordinary/encrypted text when canceled; saved drafts recover after navigation/reload. Locked composer retains in-memory text and supports explicit unlock. Atomic reply consumption remains backend-dependent; accepting a browser leave warning can still discard unsaved memory. |

## 17. Sending Email

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 17.01 — Validate/resolve/send/busy/confirmed state, durable operation identity, exact ciphertext retry, preserve draft on failure | `src/lib/outbox.ts`; `src/features/security/service.ts`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `multitab-ui-results.json` | implemented and tested | Browser interruption before/after commitment and same-profile two-tab retry yield one message. |

## 18. Offline / Low-Bandwidth Behavior

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 18.01 — Opt-in bounded cache, minimal startup assets, actual offline reload and composition, safe pending operations and honest states | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented and tested | Cached mail/drafts and snapshot reconciliation verified; no automatic large attachment/crypto/scanner/Tamil download. |
| 18.02 — Real intermittent cellular/low-end-device behavior | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | partial | CDP lab throttling is measured separately. Physical radio loss, device eviction and hardware quota exhaustion remain unverified. |

## 19. Loading States

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 19.01 — Shared lightweight loading indicators and operation text for core requests | `src/components/ui.tsx`; `src/features/mail/Workspace.tsx`; `src/features/settings/Settings.tsx` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Named browser suites exercise auth, lists, sends, drafts and settings; no blank core-route startup. |
| 19.02 — Every network-dependent screen under prolonged delay | `src/components/ui.tsx`; `src/features/mail/Workspace.tsx`; `src/features/settings/Settings.tsx` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented but unverified | Exhaustive loading-state visual review not completed. |

## 20. Error States

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 20.01 — Normalized public API errors, understandable retry/sign-in recovery and preserved input; no server stack/SQL prose | `src/lib/api.ts`; `src/components/ui.tsx` | `tests/i18n.test.ts`; `offline-ui-results.json`; `otp-continuity-ui-results.json` | implemented and tested | Error mapping unit checks and browser network/storage/proof failures pass; UUID-bearing crypto errors replaced. |
| 20.02 — Every possible third-party error path | `src/lib/api.ts`; `src/components/ui.tsx` | `tests/i18n.test.ts`; `offline-ui-results.json`; `otp-continuity-ui-results.json` | partial | Unexpected crypto/browser exceptions still require exhaustive localization/security review; no claim all library diagnostics are cataloged. |

## 21. Empty States

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 21.01 — Explicit actionable Home, contacts and search empty states | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Rendered empty/search/no-contact paths exercised. |
| 21.02 — Distinct Inbox/Sent/Drafts/Trash/Spam/Archive empty-state copy | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json`; `web-recovery-ui-results.json` | implemented and tested | All seven folder-specific empty states plus Home, search and Contacts rendered with guidance/actions on disposable empty account. |

## 22. Search

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 22.01 — Server-side supported mailbox search, loading/results/no-results/paging and no whole-mailbox download | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json`; `blueprint-ui-results.json` | implemented and tested | Live query plus delayed page/search ownership regression pass; encrypted content search limitation explained. |
| 22.02 — All searchable field combinations | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json`; `blueprint-ui-results.json` | implemented but unverified | Sender/recipient/subject/body combinations depend on backend search contract; exhaustive field-specific UI matrix remains. |

## 23. Contacts

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 23.01 — Contacts create/edit/delete/search/use recipient with public fields and own-contact privacy | `src/features/contacts/Contacts.tsx`; `src/components/ContactPicker.tsx` | `account-live-results.json`; `blueprint-ui-results.json` | implemented and tested | API CRUD plus rendered bounded picker finds contact beyond first 100. Compose picker has 30-row pages. |
| 23.02 — Contact-list scale and all optional profile fields | `src/features/contacts/Contacts.tsx`; `src/components/ContactPicker.tsx` | `account-live-results.json`; `blueprint-ui-results.json`; `web-recovery-ui-results.json` | partial | Main contact list now replaces 50-row pages, with previous/next and server search. 151 added contacts plus saved encryption peer exercise more than 100 entries; short heap/paging sample. Invalid contact input preserves text with associated error. All optional profile/CRUD permutations and long soak remain unverified. |

## 24. Blocking

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 24.01 — Contact-based block/unblock, plain consequence confirmation, neutral fallback and real server enforcement | `src/components/BlockContact.tsx`; `src/features/settings/Settings.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `blueprint-ui-results.json` | implemented and tested | Browser block/unblock checks live backend state and no visible UUID; Escape returns focus. |
| 24.02 — Blocking an unsaved message sender without a saved authorized identity | `src/components/BlockContact.tsx`; `src/features/settings/Settings.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `blueprint-ui-results.json` | backend-dependent | No identity enumeration. Minimal server-derived message-block endpoint proposed if product requires this shortcut. |

## 25. Privacy Settings

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 25.01 — Supported discoverability, profile visibility, read receipts, communication and notification preferences with plain labels | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `web-recovery-ui-results.json` | partial | Representative profile/alias/preference failures rendered near their section, edits retained and failed preference toggle unchanged. Existing live API preference checks pass. Not every control/permutation independently accepted. |

## 26. Account / Profile

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 26.01 — Public address/current phone/name/language/privacy/notices/security/logout without UUID | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `locale-ui-results.json` | implemented and tested | Rendered settings, local phone changes and no-ID assertions pass; avatar/profile paths retain API evidence. |
| 26.02 — Approved legal settings links; future reviewed languages | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `locale-ui-results.json` | external-input-dependent | Approved Terms/Privacy URLs/content and matching version remain owner inputs. Tamil approval is outside the English-only launch. |

## 27. Phone Number Change

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 27.01 — Password-backed and OTP-only phone change with correct proofs, same UUID/new public address/account refresh, retained mailbox/contacts and session replacement | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `otp-continuity-ui-results.json` | implemented and tested | Isolated rendered continuity suite passes; old cookies rejected; active key revoked/absent afterward. |
| 27.02 — Encrypted history after phone change and every ambiguous account-change case | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `otp-continuity-ui-results.json`; `web-recovery-ui-results.json` | partial | Committed phone-change response loss retries identical payload/idempotency key with pre-change cookies and stable account ID; subsequent settings requests pass after pending-flag repair. Password-backed historical E2EE acceptance retained. OTP-only encrypted history still requires unsupported key-management contract. |

## 28. Security UX

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 28.01 — No passwords/tokens/raw IDs in ordinary UI or URLs; authenticated cookies/CSRF, protected key backups, lock/expiry/logout handling | `src/features/security/SecurityPanel.tsx`; `src/features/security/service.ts`; `src/vendor/e2ee/client.ts`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `browser-ui-results.json`; `tests/e2ee.test.ts` | implemented and tested | Rendered UUID checks, delayed-decrypt lock race, encrypted backup/retry and packaged isolation pass. |
| 28.02 — Independent security certification/platform-protected native storage | `src/features/security/SecurityPanel.tsx`; `src/features/security/service.ts`; `src/vendor/e2ee/client.ts`; `src/lib/recipients.ts`; `src/components/BlockContact.tsx` | `browser-ui-results.json`; `tests/e2ee.test.ts` | partial | Independent website security audit remains external; native secure storage/device lifecycle is outside this delivery. |
| 28.03 — OTP-only key enrollment, rotation and revocation | `src/features/security/SecurityPanel.tsx`; `../frontrepo/backend/src/routes/e2ee.ts` | `REMAINING-BACKEND-CONTRACTS.md`; `otp-continuity-ui-results.json` | backend-dependent | Current /api/e2ee/reauth accepts only password. Proposal 5 adds separately reviewed purpose/account/session-bound OTP reauthentication; disabled controls are not implementation. |

## 29. Attachments

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 29.01 — Owned file selection/progress/size limits/multiple files, resume/cancel, failure handling, explicit download and bounded inert preview | `src/features/mail/Attachment.tsx`; `src/lib/uploads.ts`; `src/features/mail/Composer.tsx` | `thread-contract-ui-results.json`; `frontend-live-results.json`; `tests/blueprint.test.ts` | implemented and tested | Live upload module and rendered direct/group attachment+preview byte checks pass. No HTML/SVG/PDF execution or automatic large download. |
| 29.02 — File attachment to arbitrary server-routed existing-thread send/reply | `src/features/mail/Attachment.tsx`; `src/lib/uploads.ts`; `src/features/mail/Composer.tsx` | `thread-contract-ui-results.json`; `frontend-live-results.json`; `tests/blueprint.test.ts` | backend-dependent | Only original-sender atomic draft route presently preserves attachment ownership and roles. Minimal optional attachmentIds contract proposed. |
| 29.03 — Real malware scanning and all many-file memory cases | `src/features/mail/Attachment.tsx`; `src/lib/uploads.ts`; `src/features/mail/Composer.tsx` | `thread-contract-ui-results.json`; `frontend-live-results.json`; `tests/blueprint.test.ts` | implemented but unverified | Server scanner/provider outcomes and physical slow network behavior unverified. |

## 30. Notifications

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 30.01 — Opted-in browser new-mail announcement from actual mailbox changes; delivery/read/security/account information from backend | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `blueprint-ui-results.json` | implemented and tested | Rendered announcement preference and actual new-message refresh tested; notice uses status region. Security/delivery APIs and readable UI tested. |
| 30.02 — Push/provider SMS/IVR notification delivery | `src/features/settings/Settings.tsx`; `src/features/settings/PhoneChange.tsx` | `account-live-results.json`; `otp-continuity-ui-results.json`; `blueprint-ui-results.json`; `blueprint-ui-results.json` | backend-dependent | No supported browser push transport; provider configuration and controlled delivery acceptance required. No push claim. |

## 31. Message Status

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 31.01 — Draft/sending/committed/delivered/read/failed and pending states use actual backend values | `src/features/mail/DeliveryStatus.tsx`; `src/features/mail/Outbox.tsx` | `responsive-ui-results.json`; `account-live-results.json` | implemented and tested | Delivery component, pending UI and backend tests distinguish commitment from delivery and simulated channels. |

## 32. Responsive Design

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 32.01 — 390px phone and 1280px desktop layouts, reading history/settings/compose fit, Tamil wrapping/system fonts | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Named screenshots, overflow checks and axe pass; desktop split view is retained. |
| 32.02 — Tablet/large-phone/desktop-monitor matrix and physical one-handed comfort | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `layout-resume-ui-results.json` | partial | 768/1024 tablet layouts and emulated 200% content zoom/150% settings text tested, dialog clipping repaired. Physical one-handed comfort, keyboards and browser-chrome zoom remain external/unverified. |

## 33. Performance

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 33.01 — Production entry budget, lazy crypto/scanner/Tamil, compact pagination, on-demand files and bounded rendering | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented and tested | Final production bundle and repeated browser measurements attached. No new UI framework/font download. |
| 33.02 — Every render/storage bottleneck under long soak | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented but unverified | Only specified heap/navigation samples taken, not a device fleet or long-term memory certification. |

## 34. Low-End Device Support

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 34.01 — Equivalent bounded mailbox/history windows avoid excessive simultaneous rendering | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented and tested | At most 30 mailbox rows/60 history messages; 126-message real fixture, stable paging/dedup and heap samples. |
| 34.02 — Older Android, limited RAM/slow CPUs and actual low-end-device acceptance | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented but unverified | Fast M5 CDP slowdown is not low-end-device proof. |

## 35. Data Synchronization

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 35.01 — Separate local/server/cache/pending state, revision checks, transactional snapshots and safe mutation reconciliation | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json`; `blueprint-ui-results.json` | implemented and tested | Interrupted paging, expired cursor resnapshot, unsent work preservation and concurrent sends pass. |
| 35.02 — Async result ownership across message/history/search/view/key-lock transitions | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json`; `blueprint-ui-results.json` | implemented and tested | Delayed first read/history/page cannot replace current view; stale decrypt after lock cannot disclose plaintext. |

## 36. API Integration

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 36.01 — Configurable API base, central serialization/headers/cookies/error mapping/timeouts/safe retry and exact existing contracts | `src/lib/api.ts`; `vite.config.ts` | `account-live-results.json`; `tests/i18n.test.ts`; `multitab-ui-results.json` | implemented and tested | Live API and module suites plus packaged proxy/CSRF checks. Local API target remains localhost:3000. |

## 37. State Management

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 37.01 — Separate auth/server/UI/form/persistence responsibilities using existing architecture | `src/App.tsx`; `src/lib/api.ts`; `src/lib/storage.ts`; `src/features/mail/Workspace.tsx` | `Source inspection`; `Source inspection` | implemented and tested | Source inspection of App, API, storage and feature modules; this is structural evidence, not a behavioral certification. |

## 38. Component Architecture

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 38.01 — Reusable controls/phone input/dialogs/status/avatars/contacts/files and bounded mail responsibilities | `src/components/ui.tsx`; `src/components/ContactPicker.tsx`; `src/features/mail/Attachment.tsx` | `Source inspection` | partial | Affected controls extracted; Workspace and Composer remain large components. Further unrelated refactor intentionally not undertaken. |

## 39. Form Handling

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 39.01 — Labeled native forms, busy/disabled/error/success states, preserve failed input | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Auth/compose/settings/blocking and injected failures exercised; primary operations keyboard accessible. |
| 39.02 — Every form keyboard/validation permutation | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `web-recovery-ui-results.json`; `layout-resume-ui-results.json`; `auth-final-ui-results.json`; `auth-edge-ui-results.json` | partial | Representative backend contact validation and profile/alias/preference transport failures, keyboard login and dialog focus tested. Exhaustive field permutations, photo failures and physical autofill remain unverified. |

## 40. Accessibility-Friendly Errors

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 40.01 — OTP/recipient field-associated errors and shared accessible alert/status regions | `src/features/auth/AuthScreen.tsx`; `src/features/mail/Composer.tsx`; `src/components/ui.tsx` | `blueprint-ui-results.json`; `otp-continuity-ui-results.json` | implemented and tested | Axe and rendered invalid recipient/OTP feedback checked. |
| 40.02 — Every settings field error and native accessibility announcements | `src/features/auth/AuthScreen.tsx`; `src/features/mail/Composer.tsx`; `src/components/ui.tsx` | `blueprint-ui-results.json`; `otp-continuity-ui-results.json`; `web-recovery-ui-results.json` | partial | Settings failures render within the initiating section; profile/alias/contact descriptions retained. Generic server errors are not falsely assigned to one field. Exhaustive permutations and human web screen-reader announcements remain unverified; native UI is outside scope. |

## 41. Confirmation Dialogs

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 41.01 — Consequential block/contact/alias delete, phone-change acknowledgment and security backup confirmation | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Rendered block/phone/security flows and source inspection; no blanket confirmation on minor actions. |
| 41.02 — Destructive-action consistency | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `web-recovery-ui-results.json`; `layout-resume-ui-results.json` | implemented and tested | Draft discard now explicitly confirms irreversible removal; cancel retains text. Message Trash asks confirmation, cancel avoids mutation, and Restore works. Existing contact/alias confirmations retained; permanent message deletion is not offered. |

## 42. Visual Hierarchy

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 42.01 — Distinct primary, quiet and danger styles; Compose/Send/Reply/Verify/Save hierarchy | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `Source inspection` | implemented and tested | Shared CSS/source and screenshots; no claim of human rural preference approval. |

## 43. Rural Accessibility

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 43.01 — Plain wording, obvious navigation, large controls, guidance and secondary advanced functions | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | CC/draft/address/encryption explanations provided. Rural first-time comprehension still requires human review; BCC unavailable honestly. |

## 44. First-Use Guidance

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 44.01 — Actual address first-use explanation, skippable guidance and contextual compose/contact/language help | `src/App.tsx`; `src/features/mail/Composer.tsx` | `blueprint-ui-results.json` | implemented and tested | First-use skip exercised; native-language selector and public identity shown. No long forced tutorial. |

## 45. Accessibility Beyond Visual Design

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 45.01 — Semantic HTML, native controls, accessible dialogs/menus/validation, keyboard focus | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Seven axe scans and focus-return behavior pass in Chromium. |
| 45.02 — Native screen-reader roles/focus/buttons/dynamic text | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | outside current delivery | Authoritative product decision: native Expo, iOS/Android apps, APKs and stores are outside this website/portal delivery; no owner scope decision is pending. Historical source assessment only. |
| 45.03 — Human web screen-reader review | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented but unverified | Automated checks cannot establish screen-reader comprehension or all assistive technology behavior. |

## 46. Internationalization Architecture

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 46.01 — Central English catalog, whole-message parameters, lazy locale loaders and locale formatting; optional review overlay | `src/i18n/index.ts`; `src/i18n/en.json`; `src/i18n/ta.draft.json`; `src/i18n/LanguageSelector.tsx` | `auth-final-ui-results.json`; `tests/i18n.test.ts`; `tests/blueprint.test.ts`; `TRANSLATION-REVIEW.md` | implemented and tested | 827 English entries; catalog audit and token validation pass. English-only ordinary dev/production. Tamil overlay is explicit review only, with English fallback for newer entries. |
| 46.02 — All rare system prose and translation quality | `src/i18n/index.ts`; `src/i18n/en.json`; `src/i18n/ta.draft.json`; `src/i18n/LanguageSelector.tsx` | `blueprint-ui-results.json`; `tests/blueprint.test.ts`; `TRANSLATION-REVIEW.md`; `locale-ui-results.json` | partial | Unexpected third-party exceptions and rare system prose need exhaustive editorial/security review. Additional language quality is outside this English-only launch; no fluent approval is implied. |

## 47. Date and Time

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 47.01 — Today time, Yesterday, older dates/year and shared locale-aware formatting without raw ISO UI | `src/components/ui.tsx`; `src/i18n/index.ts` | `tests/i18n.test.ts`; `blueprint-ui-results.json` | implemented and tested | Formatter/unit and browser representative dates checked; phone/address/fingerprint values invariant. |
| 47.02 — Timezone/day-boundary visual cases | `src/components/ui.tsx`; `src/i18n/index.ts` | `tests/i18n.test.ts`; `blueprint-ui-results.json` | implemented but unverified | Full locale/timezone/date-boundary matrix not exercised. |

## 48. Accessibility of Color

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 48.01 — Unread weight/count, error/success text/icons and labeled state beyond color | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Rendered styles/axe/source confirm alternatives; human color-vision/AT review remains separate. |

## 49. Reliability During Navigation

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 49.01 — Explicit compose close, failed-write recovery, attachment progress and durable pending sends preserve work | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented and tested | Offline/ambiguous/E2EE reload suites pass, with truthful unsaved/unknown state. |
| 49.02 — Browser Back and unsaved encrypted text when manually locking keys mid-compose | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json`; `web-recovery-ui-results.json` | implemented and tested | Actual Back and reload cancellation retain ordinary/encrypted unsaved text; saved drafts recover. Actual key-lock service hides encrypted composer text; close cannot drop unsaved memory and inline unlock restores it. Accepting browser leave warning still intentionally loses unsaved memory; decrypted plaintext is not persisted. |

## 50. Security Boundaries

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 50.01 — Backend remains authority for every protected operation; no proof/role/local-state bypass | `src/lib/api.ts`; `src/lib/recipients.ts`; `../frontrepo/backend/src/routes` | `account-live-results.json`; `otp-continuity-ui-results.json`; `Source inspection` | implemented and tested | Inspected contracts and real negative/session/key tests. No backend architecture changes. |

## 51. API Contract Compatibility

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 51.01 — Inspect actual routes/schema/auth/errors/paging/states/files/recipient and verification contracts; no invented endpoint behavior | `docs/REMAINING-BACKEND-CONTRACTS.md`; `../frontrepo/backend/src/services/conversationService.ts` | `thread-contract-ui-results.json`; `account-live-results.json` | implemented and tested | Supported original-sender route verified; limitations and compatibility proposals linked. |

## 52. No Fake Features

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 52.01 — No fake delivered/encrypted/organization/government/sent state | `src/features/auth/AuthScreen.tsx`; `src/features/mail/DeliveryStatus.tsx` | `packaged-ui-results.json`; `browser-ui-results.json`; `Source inspection` | implemented and tested | Production legal/Tamil gates, actual provider/status data and pending identity checks preserve honest boundaries. |

## 53. Error Recovery

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 53.01 — Direct retry/sign-in/draft/upload/send/OTP recovery without restart for normal errors | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented and tested | Actual failure suites pass. Unknown sends/drafts remain explicit rather than blindly duplicated. |
| 53.02 — Every combined recovery path | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json`; `web-recovery-ui-results.json`; `local-acceptance-ui-results.json` | partial | Browser Back/reload, dropped committed phone-change response and focused cross-engine auth/draft/encryption/portal flows pass. Exhaustive combinations, browser eviction and cross-engine offline tests remain unverified. |

## 54. Testing

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 54.01 — Critical website tests: auth/OTP/mail/compose/confirm/send/drafts/search/files/blocking/settings/session/network and continuity | `scripts/test-otp-continuity-ui.mjs`; `scripts/test-blueprint-ui.mjs`; `scripts/test-ui-live.mjs` | `INTEGRATION-RESULTS.md` | implemented and tested | Named browser suites plus distinctly labeled API/module evidence; this row does not promote API-only subchecks to UI acceptance. |
| 54.02 — Complete critical-flow UI matrix | `scripts/test-otp-continuity-ui.mjs`; `scripts/test-blueprint-ui.mjs`; `scripts/test-ui-live.mjs` | `INTEGRATION-RESULTS.md`; `web-recovery-ui-results.json`; `local-acceptance-ui-results.json`; `layout-resume-ui-results.json` | partial | Focused critical browser checks include folders, portal, auth, compose/key-lock, phone change, settings failures and cross-engine draft/encryption. Full privacy/search/form combinations remain unverified; native suites are outside scope. |

## 55. Cross-Platform Testing

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 55.01 — Chromium mobile/desktop widths, keyboard focus, actual reload, expired-session/races, offline and CDP slow-network lab | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Representative rendered workflows exercised with isolated accounts/contexts. |
| 55.02 — Firefox, WebKit, physical keyboards/screen readers/camera, tablet and native platform acceptance | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json`; `local-acceptance-ui-results.json`; `layout-resume-ui-results.json` | partial | Official Firefox 155.0/WebKit 26.6 and Chrome 154 execute the focused auth/portal and critical mailbox/draft/encryption-unlock set. Tablet/text/zoom are emulation; physical keyboards, screen readers and camera remain unverified. Native is outside scope. |

## 56. Performance Testing

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 56.01 — 126-message fixture, bounded pages/history, delayed API ownership, repeated navigation, cache/restart and production throttling | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented and tested | Heap delta/paging and cold/warm/offline/encryption timings attached with host/network limits. |
| 56.02 — Very large mailbox soak/many-large-file memory and real cellular performance | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented but unverified | Current sample is 126 messages, not millions or a prolonged field deployment. |

## 57. Visual Consistency

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 57.01 — Shared typography/spacing/buttons/fields/cards/dialogs/navigation/status/focus/contrast system | `src/styles.css`; `src/components/ui.tsx`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `docs/screenshots`; `Source inspection` | implemented and tested | Existing visual direction preserved; concrete contrast/wrapping fixes accepted by representative scans/screenshots. |

## 58. Mobile Interaction Rules

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 58.01 — Mobile labeled targets, optional swipe reply with visible reply alternative, navigation and input modes | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Emulated target measurements and responsive suite pass; gestures never mandatory. |
| 58.02 — Physical keyboard dismissal/occlusion, pull refresh and destructive-action thumb comfort | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented but unverified | Requires real-device hands-on acceptance. |

## 59. Web Interaction Rules

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 59.01 — Native web controls for mouse/touch/keyboard, visible focus and keyboard-accessible dialog/actions | `src/components/ui.tsx`; `src/styles.css`; `src/features/auth/auth.css` | `blueprint-ui-results.json`; `responsive-ui-results.json` | implemented and tested | Browser keyboard/focus regression and emulated touch; no custom inaccessible replacement controls introduced. |

## 60. Local Persistence

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 60.01 — HttpOnly session cookies, explicit per-account mail/draft cache, language/UI preferences and protected private-key storage | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented and tested | Storage denial/quota-boundary injection, cache opt-in/offline reload and account isolation pass. |
| 60.02 — Actual OS/browser eviction or full disk; native secure storage | `src/lib/storage.ts`; `src/lib/sync.ts`; `src/lib/outbox.ts` | `offline-ui-results.json`; `multitab-ui-results.json`; `ambiguous-draft-ui-results.json` | implemented but unverified | Faults are injected at storage boundaries, not hardware quota exhaustion or OS eviction. Native persistence is outside scope. |

## 61. Notifications and Background Behavior

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 61.01 — Respect visible/background platform limits; conservative one-minute refresh, no continuous background/push assumption | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs` | `Source inspection`; `packaged-ui-results.json`; `Source inspection` | implemented and tested | Source inspection and live manual update. No aggressive health polling; status reflects last actual API request. |
| 61.02 — Long background suspension/resume scenarios | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs` | `Source inspection`; `packaged-ui-results.json`; `Source inspection`; `layout-resume-ui-results.json` | partial | Actual mail during real 120-second CDP lifecycle freeze appears on visible resume with opted-in announcement. Visibility boundary is simulated and is not OS eviction, mobile background execution or multi-day soak. |

## 62. Accessibility + Low Bandwidth Together

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 62.01 — Essential text/system fonts/small icons, no animation dependency or remote accessibility resource | `src/features/mail/Workspace.tsx`; `scripts/service-worker.mjs`; `scripts/measure-browser.mjs` | `blueprint-ui-results.json`; `performance-browser-results.json`; `bundle-measurement.json` | implemented and tested | Bundle/precache verifies optional assets are lazy; representative text accessible offline. |

## 63. Government Communication Readiness

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 63.01 — Do not fabricate government/verified organization or structured service functionality | `src/features/mail/types.ts`; `docs/REMAINING-BACKEND-CONTRACTS.md` | `Source inspection`; `Source inspection` | implemented and tested | No fabricated UI or badges introduced. |
| 63.02 — Future verified organizations/official senders/structured requests/service messages | `src/features/mail/types.ts`; `docs/REMAINING-BACKEND-CONTRACTS.md` | `Source inspection`; `Source inspection` | backend-dependent | Requires product scope, authorized backend contracts and owner-approved verification policy. |

## 64. Future Extension Compatibility

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 64.01 — Real aliases and identity QR sharing preserve existing account model | `src/features/security/SecurityPanel.tsx`; `src/features/security/service.ts`; `src/vendor/e2ee/client.ts` | `browser-ui-results.json`; `tests/e2ee.test.ts` | implemented and tested | Aliases have API evidence; QR/backup/fingerprint workflow rendered acceptance. Unreviewed QR address claims labeled. |
| 64.02 — Phone recovery/recovery codes/trusted devices/organizations/government/structured requests/richer push | `src/features/security/SecurityPanel.tsx`; `src/features/security/service.ts`; `src/vendor/e2ee/client.ts` | `browser-ui-results.json`; `tests/e2ee.test.ts` | backend-dependent | Future product/backend scope; no fake placeholders or unsupported flows. |

## 65. Critical UX Principle

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 65.01 — VERIFY → ADDRESS → INBOX primary journey | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | resolved product decision | Unified Home is the approved primary mobile mailbox. Inbox, Sent and other supported folders remain accessible. This supersedes historical Inbox/Sent-first wording; no decision is pending. |
| 65.02 — First-time simplicity and secondary advanced functionality | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | First-time rural comprehension and human usability review remain external. English is the sole launch language; additional language approval is not required. |

## 66. Implementation Order

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 66.01 — Phases 1–8: foundation, auth, mail, management, accessibility/reliability, user features, continuity and hardening | `docs/INTEGRATION-RESULTS.md`; `docs/NATIVE-SCOPE.md` | `All named evidence artifacts` | partial | Incremental website/portal implementation retained; external acceptance, owner legal/deployment inputs and missing backend contracts remain separate from local completion. Native is outside scope. |

## 67. Agent Instructions

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 67.01 — Inspect/reuse existing code, preserve package architecture/strict types, real API compatibility, incremental work and fix findings | `package.json`; `docs/INTEGRATION-RESULTS.md`; `docs/NATIVE-SCOPE.md` | `npm run check`; `packaged-ui-results.json`; `Source inspection` | implemented and tested | Check/build/unit/live/browser runs recorded; only relevant frontend responsibilities changed and axe dev dependency added. |
| 67.02 — After-work checks: tests/types/lint/build/mobile/backend/responsive/accessibility/performance | `package.json`; `docs/INTEGRATION-RESULTS.md`; `docs/NATIVE-SCOPE.md` | `npm run check`; `packaged-ui-results.json`; `Source inspection` | partial | No lint script configured; strict TypeScript, catalog AST audit, unit/build/budgets and relevant browser/API/module suites run. Physical/external coverage remains unverified. Native builds outside delivery. |

## 68. Definition of Done

| Requirement | Implementation source | Evidence | Status | Outcome / remaining work |
|---|---|---|---|---|
| 68.01 — Website objective steps 1,3–6,8–21,23,25: local proof/auth/address/mail/read/reply/compose/phone recipient/confirm/send/state/draft/recovery/search/manage/contact/settings/logout/desktop/continuity | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | implemented and tested | Rendered critical paths pass with exact gaps in section 54; API-only subchecks identified in evidence. |
| 68.02 — Steps 2,7,22,24 and complete product definition: comprehension, comfortable phone use, accessibility and overall minimal effort | `src/features/mail/Workspace.tsx`; `src/features/mail/Composer.tsx` | `browser-ui-results.json`; `blueprint-ui-results.json`; `thread-contract-ui-results.json` | partial | Human rural/mobile/assistive-technology review, approved legal/deployment inputs and unsupported backend contracts remain. Native and additional languages are outside this delivery; navigation decision resolved. |
