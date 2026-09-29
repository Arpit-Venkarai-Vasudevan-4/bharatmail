# PhoneMail integration results

Current evidence: 2026-09-29 final website/portal pass. **English only** is the authoritative launch and ordinary-development decision; Tamil is optional future review, native apps are outside delivery, and unified Home is the resolved primary mobile view. Historical evidence below is preserved with scope distinctions; no provider/native readiness is implied.

Frontend: `/Users/shubhamchahar/Documents/buildfront/frontend`. Backend contract source: `../frontrepo`. Owner backend remains live/ready at `http://localhost:3000`; development frontend remains `http://localhost:8080`. No owner backend/database image, container, volume or source was replaced. Frontend-only production test containers use 18080/18081. The authorized isolated OTP environment uses separate API 13000, frontend 18082, disposable PostgreSQL tmpfs and private development sink.

## Changes verified

- Public recipient identity is separate from UUID routing/trust/storage identity. Blocking, QR presentation, trust rows, encrypted draft/reply fields and errors use safe public/neutral labels. A previously missed UUID-bearing encryption error was fixed and added to the extraction audit/browser rejection check.
- Phone/country/address/contact To/CC entry uses private backend confirmation. Edits invalidate confirmation; failed lookup never permits sending. Saved-contact search works beyond 100 entries. Group creation supports multiple initial recipients; membership remains locked.
- Mailbox and history rendering are bounded to 30 and 60 items. Read, history, search and decrypt results have ownership guards; delayed replies cannot overwrite a new view or show plaintext after key lock. Older-page refresh preserves the current page and offers a return to newest.
- Explicit ordinary forwarding preserves attribution and requires new recipient selection and owned attachment re-upload. On-demand preview is limited to bounded inert text/raster images. Backend-octet-stream `.txt` is displayed only as inert text; executable types remain excluded.
- English-only ordinary builds retain catalog loaders, token validation and plural/date/number helpers. Explicit Tamil review mode remains optional with English fallback for newer entries; old stored Tamil preferences fall back cleanly, and unrelated profile saves preserve backend language. Historical Tamil screenshots/tests apply only to review mode.
- First-use address guidance, actionable empty copy, mobile secondary folders, opt-in real-mail announcements, honest reachability wording, contrast and dialog focus improvements retain the established design.

## Retained baseline checks (see final-pass reruns below)

| Check | Actual result / evidence |
|---|---|
| `npm run check` | TypeScript, 20/20 unit checks, 827-entry extraction audit with zero findings, build and service-worker generation pass. No lint command is configured. |
| `npm run test:live` | 38 live API checks pass: [artifact](account-live-results.json). API evidence, not browser acceptance. |
| `npm run test:live:modules` | 12 real frontend-module/backend checks pass: [artifact](frontend-live-results.json). Module evidence, not browser acceptance. |
| `npm run test:ui:e2ee` | 15 rendered production-browser checks pass: [artifact](browser-ui-results.json). Separate E2EE contexts; enrollment/independent trust, unverified/changed/revoked keys, received/durable signature rejection, encrypted draft/reply/files, Sent/receive decrypt, backup/import, rotation/history, delayed decrypt after lock and exact retry/reload before/after server commitment. |
| `npm run test:ui:blueprint` | 11 development-browser checks pass: [artifact](blueprint-ui-results.json). Contacts beyond 100, phone/CC confirmation, block/unblock, ordinary UUID absence, Tamil layouts, real 126-message paging, read/history/search ownership races, actual forward send, opted-in new-mail announcement and mobile folder access. Seven WCAG A/AA axe view scans: zero violations. |
| `npm run test:ui:locale` | Focused development preview checks recorded in [artifact](locale-ui-results.json): existing errors switch language, account preference synchronizes, mounted mailbox changes and actual reload retains Tamil. |
| `npm run test:ui:otp` | 8 checks pass: [artifact](otp-continuity-ui-results.json). Six rendered flow checks plus two explicitly API-level failure checks. UI signup includes resend; wrong then valid login; both phone-change styles with immutable identity, retained mail/contacts/new address/replacement sessions; password-backed historical encrypted Sent read after change; interrupted OTP request/reload. Real-time expiry/attempt limits/cooldown checked through API. |
| `npm run test:ui:offline` | 7 production-browser checks pass: [artifact](offline-ui-results.json). Actual offline startup, opted-in mail/local draft, interrupted snapshot/reconnection/expired cursor, durable write denial/quota and account isolation. |
| `npm run test:ui:multitab` | 2 production-browser races pass: [artifact](multitab-ui-results.json). One live refresh for simultaneous 401s; one committed message for concurrent retries of the same operation. |
| `npm run test:ui:ambiguous-draft` | 3 production-browser assertions pass: [artifact](ambiguous-draft-ui-results.json). Commit/drop-response preserves text; user reviews and links candidate; exactly one draft remains. |
| `npm run test:ui:threads` | Direct and To/CC group follow-ups pass: [artifact](thread-contract-ui-results.json). Existing atomic route preserves conversation/roles, attachment bytes, inert preview and draft consumption. |
| `npm run test:ui:responsive` | 3 production-browser checks pass: [artifact](responsive-ui-results.json). 390×844 touch emulation, core view fit, readable delivery/pending status, 44px measured key targets. |
| `npm run test:ui:packaged` | 6 frontend-only Docker/browser checks pass: [artifact](packaged-ui-results.json). Cookie/CSRF proxy, profile mutation, deep links, headers/cache/redirect, portal isolation/legal gate, actual startup cache. Additional assertion rejects unreviewed Tamil as a production option. |
| `npm run measure`, `npm run measure:browser` | Entry budget and repeated production lab samples pass; metrics below. |

Failures found and repaired: stale async message/history/decrypt ownership; unbounded mail rendering; UUID presentation/error leakage; stale recipient confirmation; inaccessible folder access on mobile; missing live announcement behavior and empty-baseline handling; low-contrast labels; Tamil header overflow; mobile Forward incorrectly below the footer (moved into the reading pane with a viewport regression); `.txt` preview metadata mismatch. A crypto unit assertion was updated for the new neutral error. Security dialogs now disable dismissal while key registration finishes instead of silently ignoring a close click. Test harness waits/selectors were corrected where refresh, busy dialogs or translated controls were being selected too early; those harness failures are not reported as product defects.

## Additional local acceptance (latest continuation)

Official Playwright-managed Firefox 155.0 (`firefox-1543`) and WebKit 26.6 (`webkit-2359`) installed successfully from `cdn.playwright.dev` and executed on this arm64 Mac. [The focused three-engine suite](local-acceptance-ui-results.json) records Chrome 154, Firefox and WebKit password authentication, mailbox reading, ordinary compose/draft/reload/send, encryption enrollment/wrong-passphrase/unlock, and valid portal OTP registration. Each portal test shares the mailbox browser context and origin, confirms every portal API request omits cookies, verifies the temporary bearer session returns 401 after logout, preserves mailbox cookies, and resets phone/consent/code for another registrant. A dropped revocation request exercises the actual retry UI. Chromium additionally waits for real 180-second proof expiry and exercises expired-code/resend feedback. Development consent is explicitly labeled; this does not enable production registration or establish approved Terms/Privacy.

[Web recovery suite](web-recovery-ui-results.json): seven grouped browser checks cover all folder/Home/search/contact empty states; ordinary/encrypted Back and reload; unsaved key-lock recovery; lost committed phone-change response and identical operation replay; representative profile/alias/preference transport failures; real contact validation; and contact paging/search at 152 total contacts (151 scale fixtures plus one encryption contact). Explicit beforeunload cancellation protects unsaved text, while actual saved-draft navigation/reload verifies durability. Choosing to leave despite the warning can lose unsaved memory. No decrypted plaintext is persisted. Key lock is triggered through the actual frontend service while the composer owns focus; it is not a manually clickable control behind the modal.

The phone-change test drops a successful response and restores its pre-change cookies to model loss of both body and replacement cookies. Recovery sends the same payload and idempotency key and retains the account identity. It found a real stale `accountChangePending` flag after successful recovery; a completion guard now prevents the pending effect from re-enabling the request barrier. Subsequent profile writes are part of this regression.

[Layout/resume suite](layout-resume-ui-results.json): keyboard-only authentication and compose, dialog Tab wrapping/Escape/focus return; 768/1024 tablet viewports; CSS content zoom 200%; settings text scaled to 150%; actual mail arrival during a real 120-second CDP lifecycle freeze with simulated visibility boundaries; and cancel/confirm Trash followed by Restore. CSS content zoom exposed a viewport-height sizing defect that hid dialog controls above the viewport; percentage-based dialog limits fix it. This emulation does not certify browser chrome/OS zoom, physical keyboards, assistive technology or OS background eviction.

Additional fixes: contact pages replace rather than append 50 entries; new previous/next controls retain bounded server search. Settings action errors render beside their initiating section with profile/alias descriptions and contact address association. Locked encrypted compose retains unsaved memory and offers inline unlock rather than silently closing. Draft discard and Trash require explicit confirmation. Dialog keyboard focus wraps, and hidden preference inputs have a visible focus indicator. Portal OTP help contrast meets the automated scan. Visible-resume refresh preserves the current older-page notice and avoids polling while hidden/composing.

Twelve new scans report zero violations; results are recorded per screen in these artifacts (portal reset/expiry, locked composer, profile/preference/contact failures, bounded contacts, enlarged settings/compose). They do not replace human screen-reader review. Initial failures from obsolete selectors, asynchronous mark-read request counting, and development HMR reloads during source/catalog edits were harness issues; final stable-source runs are the acceptance evidence. An earlier Chrome target crash during a canceled navigation was not reproduced in the stable-source reruns and is not claimed as a diagnosed product fix.

Relevant checks rerun: existing isolated OTP continuity suite (both phone-change proof styles and retained encrypted history), `npm run check` (19 unit tests, types, 784-entry zero-findings catalog audit, production build/service worker), 38 live API and 12 live module checks, E2EE browser suite, offline suite, responsive, multi-tab send/renewal, ambiguous draft, thread-attachment and frontend-only Docker packaging. API helpers create disposable fixtures; only rendered actions are called UI acceptance. Existing other suite artifacts remain dated prior evidence, not silently counted as rerun. Frontend containers alone were recreated on 18080/18081; owner API/database containers were preserved.

Contact paging sample: unthrottled development frontend/isolated local API on the same Mac, 50-row render bound, latest rerun 74/40/64 ms page transitions, garbage-collected JS heap 17,539,960 → 17,095,616 bytes. This short sample ran alongside other local browser acceptance and is not a soak or low-end performance claim. Production startup measurement below was refreshed after acceptance work (finished 2026-09-29T06:00:08.603Z; superseded by the final-pass measurement below).

## Conditions and limits

Browser actions use Playwright and installed headless Chrome with isolated disposable local accounts. Normal API requests hit the live backend. Controlled faults use actual requests with response interception/delay, offline context mode or boundary exceptions; success is not mocked. Cryptographic identities/fingerprints are compared across separately controlled contexts as the independent channel for these fixtures. Camera scanning was not exercised.

Offline quota/denial inject real IndexedDB boundary exceptions rather than filling a device disk or opening a browser permission prompt. The expired-cursor test changes the retention watermark only for its generated account row, receives a real 410, then resets it. Snapshot reconciliation preserves unsent work. Same-profile tab races share cookies, IndexedDB, BroadcastChannel and Web Locks.

The isolated OTP setup uses the owner's existing backend image with its documented `OTP_TEST_SINK_DIR`, development local provider, 180-second TTL, one-second resend cooldown and three attempts. Tests read legitimate private sink files without logging codes or inserting proof rows. Browser clock advancement only accelerates the conservative UI countdown; proof expiry waits for real backend time. No owner process was reconfigured, no proof bypassed, and no paid or real-recipient traffic sent.

Docker local proxy templates forward the Origin allowed by the owner API (8080/8081), while browser-facing test ports are 18080/18081. This adaptation is not deployed-host/TLS acceptance. Only frontend images/containers were rebuilt/recreated. The startup cache excludes cryptography, scanner, settings/security/contacts and optional Tamil; auth/compose essentials remain available offline. Static fingerprinted JavaScript/CSS assets now use negotiated gzip with Vary: Accept-Encoding; API responses are unchanged.

## Earlier performance baseline (superseded below)

Conditions: production Docker frontend; Chrome 154.0.8037.58; Apple M5 arm64 Mac, 16 GiB RAM, Node 24.21.0; 390×844 viewport; CDP page-target network shaping at 150 ms latency, 200 KiB/s down, 50 KiB/s up; CPU slowdown factor 4. Other acceptance suites completed before measurement. Cold samples use fresh contexts with HTTP cache disabled; warm samples reload each same context after one visit. API remains local.

| Metric (milliseconds unless bytes) | Samples | Median |
|---|---|---:|
| Cold DOM content loaded | 855, 860, 871 | 860 |
| Cold LCP | 1260, 1276, 1328 | 1276 |
| Cold observed resource bytes | 106670, 105995, 106670 | 106670 |
| Warm DOM content loaded | 21, 21, 20 | 21 |
| Warm LCP | 380, 392, 400 | 392 |
| Warm observed resource bytes | 1178, 1178, 1178 | 1178 |

Offline startup: 72 ms elapsed, FCP/LCP 60/60 ms, 0 observed network bytes, after online visit/storage opt-in with active service worker. Route transitions wait for heading, completed main API and cleared updating state: Drafts 456 ms, Favorites 411 ms, Home 419 ms. Browser key creation/enrollment: 985 ms, 3 long tasks totaling 248 ms, maximum 107 ms. These are single route/offline/enrollment passes, not distributions.

Critical-route JavaScript: 93,892 gzip bytes against 204,800 budget. On-demand encryption: 131,914 gzip bytes; scanner: 99,934; Tamil draft: 29,669. Complete details: [bundle](bundle-measurement.json), [performance](performance-browser-results.json).

Separate unthrottled development mailbox sample: 126 real messages; four page transitions 62, 63, 50, 51 ms; garbage-collected JS heap 17,321,252 → 17,456,104 bytes (134,852-byte delta). Rendering stayed ≤30 list rows and ≤60 history messages. This is a short lab sample, not long-term memory proof.

CDP throughput is shared across the measured page target's requests, not per static response. Separate service-worker requests and traffic from other devices are not guaranteed to share that cap. Resource timings exclude the navigation document and precache-worker transfers. CPU emulation on a fast M5 is **not low-end-device acceptance**, and these timings are not field percentiles or real cellular-radio/packet-loss tests. Earlier per-response fast-Mac samples are superseded, not promoted to device acceptance.

## Remaining work and owner inputs

See [all 68 sections](REQUIREMENT-MATRIX.md), [backend proposals](REMAINING-BACKEND-CONTRACTS.md), [native assessment](NATIVE-SCOPE.md), and [exact owner inputs/unverified combinations](OWNER-INPUTS.md).

Backend-dependent: server-routed existing-thread attachments, atomic ordinary reply-draft consumption, separately reviewed encrypted reply-draft consumption if required, privacy-preserving BCC, reliable authorized attachment list metadata, and optional unsaved-sender block resolution. Supported original-sender ordinary attachments already work. Direct pair reuse means an explicit new message does not guarantee a fresh direct conversation. No backend source was changed.

Owner inputs: approved Terms/Privacy URLs/content/version and final backend/public-host proxy/cookie/CSRF configuration. OTP provider delivery needs authorized acceptance when enabled. Optional later IVR activation requires an approved public number, signed provider setup, aligned consent and call-created account sign-in. Tamil approval and native decisions are outside current delivery; no native build is claimed.

Unavailable/unverified: physical mobile keyboard/autofill/camera, human screen-reader/rural studies, low-end hardware, actual storage exhaustion/eviction, scanner/provider/TLS outcomes, independent security audit and the specific unexercised UI combinations listed there. No remaining failed completed check is concealed; absent acceptance remains unverified. Builds and passing local tests do not establish production readiness.

OTP-only key enrollment/rotation/revocation is backend-dependent: the current encryption reauthentication endpoint accepts only a password. See proposal 5; disabled controls do not count as implemented key management for OTP-only accounts.

## Final website pass: authentication, IVR framework and English launch

The changed frontend uses clear Password / Verification code choices, keeps password typing stable when capabilities resolve late/fail, accepts exact password bytes under the actual 6-character/72-UTF-8-byte rule, and exposes accessible show/hide and explicit submit actions. Password registration does not claim phone verification. Code registration does not claim a password. Request acceptance is not delivery confirmation. Capabilities are fetched once per mounted auth screen, with development simulation unavailable in production.

OTP challenges are invalidated when method/number/country/channel changes. Request generations plus aborts reject stale responses; committing authentication disables mode changes. Timestamp-based expiry/cooldowns recompute on visibility and honor Retry-After. Existing server challenge responses lack resend metadata, so the client retains a conservative 60-second fallback; optional resendAt/retryAfterSeconds are supported for a future additive response. Real local proof tests do not fabricate backend validation.

Portal completion displays the real returned address, appropriate password/code guidance and Go to sign in. The cleanup-retry regression found and fixed during this pass was an OTP cooldown guard blocking a retry after account creation had already succeeded. Three-engine portal tests now exercise a dropped logout request, successful retry, revoked bearer session, next-registrant reset and unchanged mailbox cookies. Country/channel labels were made explicit, and the registration grid's fixed minimum columns were replaced with shrinkable columns plus container-aware reflow after 200% content zoom exposed overflow. These are product fixes; obsolete Next/link test selectors were harness updates.

Live account-method result: password-backed accounts are rejected by OTP login even after a valid local proof; passwordless OTP signup/login succeeds. Source inspection confirms inbound IVR creates an undisclosed random password hash and thus has no usable current web sign-in path. No password setup/reset/change routes exist. Proposals 6–7 define the exact missing integration; no credentials or backend data were altered to bypass this restriction.

IVR website controls have a validated public E.164 number, separate activation/sign-in-readiness flags, production legal gate, tel handoff, copy/manual fallback and normal sign-in continuation. The default says coming soon and has no tel link. Configured UI verification used the reserved fictional +1 (415) 555-0123 fixture on local 18083, never dialed. Voice OTP uses separate relevant capabilities and `channel=ivr`; configured-channel, provider-error and timestamp responses were controlled fixtures, not real voice/SMS delivery. Provider secrets stay on the backend.

English is the only ordinary development/production selector value. Unsupported local preferences fall back to English. Saving profile does not overwrite a stored backend Tamil preference. 827 English messages are audited; archived Tamil is a review-only overlay behind an explicit flag, not complete approved current copy or a release requirement. Native delivery and further language approval are excluded; navigation is resolved.

### Final-pass checks and repaired failures

| Verification | Result in this pass |
|---|---|
| `npm run check` / `npm run measure` | TypeScript, 20/20 unit tests, 827 catalog entries with zero unextracted findings, production build/service worker; 95,018 gzip-byte critical entry against 204,800 budget. |
| [Authentication final](auth-final-ui-results.json) | 11 grouped live assertions, 5 controlled capability/error/timing assertions; Chrome 154, Firefox 155 and WebKit 26.6. Eight axe scans, zero violations. The no-password-setup finding is source inspection, not an API assertion. |
| [Auth edges](auth-edge-ui-results.json) | Two live groups (portal password validation/completion, real attempt-limit/change-number), one controlled unavailable-backend retry, two layout/keyboard groups; two axe scans, zero violations. |
| [Local acceptance](local-acceptance-ui-results.json) | 13 browser groups: three-engine auth, draft/reload/send/Sent, enrollment/unlock, valid portal OTP + wrong code + revocation retry + isolation/reset; genuine elapsed 180-second portal expiry/resend. Four axe scans, zero violations. |
| [OTP continuity](otp-continuity-ui-results.json) | Eight groups: six rendered flows and two API failure groups; both phone changes, historical encrypted Sent and interrupted request preserved. Real server expiry, not a fabricated proof. |
| [Layout/resume](layout-resume-ui-results.json) | Four groups including updated reveal-button keyboard order, tablet/zoom/text, actual two-minute frozen lifecycle with arriving mail, Trash cancel/confirm/Restore; three axe scans, zero violations. |
| API / frontend module integration | [38 live API](account-live-results.json), [12 module](frontend-live-results.json) pass against running 3000. Neither is labeled browser UI. |
| Production browser regressions | [15 E2EE](browser-ui-results.json), [7 offline](offline-ui-results.json), [2 direct/group thread-attachment](thread-contract-ui-results.json) pass on rebuilt Docker client. |
| Recovery/concurrency reruns | [Seven recovery groups](web-recovery-ui-results.json), [two multi-tab races](multitab-ui-results.json), [three ambiguous-draft assertions](ambiguous-draft-ui-results.json) pass after the final auth changes. Contact sample remains bounded at 50 rows. |
| [Frontend packaging](packaged-ui-results.json) | Six grouped checks; both frontend images rebuilt, only test frontend containers replaced on 18080/18081. Default IVR unavailable/no tel, English-only selector, production legal gate, cookie/CSRF, omitted portal cookies, deep links, gzip/security/cache policies and minimal startup cache verified. No test harness, .env, code files or fixture credentials found in served output; no browser localhost API embedded. |

Final completed checks above have no remaining failure. Failures repaired: cleanup retry blocked by OTP resend guard, implicit channel labeling ambiguity, and enlarged registration grid overflow. Harness selectors were changed from obsolete Next/Go to PhoneMail labels and updated for the new accessible password-reveal tab stop. No security gate or proof validator was bypassed. Previous blanket-suite artifacts not listed as rerun remain historical; optional Tamil suites require an explicit review server.

The website listener on 8080 was absent at final verification, so the existing Vite application was started there with API_PROXY_TARGET=http://localhost:3000; both `/` and `/portal.html` and the same-origin capabilities proxy return successfully. No backend/container restart was needed. Owner API readiness remains healthy.

### Final performance sample

Production Docker client on Chrome 154.0.8037.58, Apple M5 arm64 / 16 GiB, Node 24.21.0; 390×844; CDP page-target shared throughput 200 KiB/s down / 50 KiB/s up, 150 ms latency, CPU factor 4. Three fresh-context cold and three same-context warm reloads. Finished 2026-09-29T09:00:01.542Z. Earlier browser suites had finished except the final few seconds of an OTP server-expiry wait; no concurrent load suite ran. This is emulation on a fast Mac, not physical low-end acceptance.

| Metric | Samples (ms unless bytes) | Median |
|---|---|---:|
| Cold DCL | 871, 871, 871 | 871 |
| Cold LCP | 1332, 1288, 1308 | 1308 |
| Cold page-observed resource bytes | 107788, 107788, 107788 | 107788 |
| Warm DCL | 19, 20, 18 | 19 |
| Warm LCP | 388, 400, 404 | 400 |
| Warm page-observed resource bytes | 1178, 1178, 1178 | 1178 |

Single samples: offline startup 74 ms (FCP/LCP 60/60, zero observed network bytes), Drafts/Favorites/Home transitions 405/409/414 ms, browser key generation/enrollment 974 ms (three long tasks, total 248 ms, maximum 108 ms). Critical entry grew 1,126 gzip bytes from 93,892 to 95,018; optional crypto/scanner/Tamil remain out of the initial critical path/precache. Cold LCP remains above one second; warm and measured routes are below it. Small differences are not statistical device/field claims.

[Raw performance](performance-browser-results.json) and [bundle](bundle-measurement.json) include conditions. CDP page-target shaping does not guarantee worker/other-device traffic shares the cap; timing excludes navigation document and worker precache transfers. No real cellular radio, packet loss, physical screen reader, provider delivery or native build acceptance is implied.
