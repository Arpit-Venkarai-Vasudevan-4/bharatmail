# PhoneMail website and portal handoff

The responsive website and separate portal are implemented against the available contracts. English-only launch and unified mobile Home are resolved. Owner backend/database remain unchanged. Native apps and Tamil approval are outside this delivery. Local passing checks do not establish production readiness.

- Website: http://localhost:8080/
- Portal: http://localhost:8080/portal.html
- Backend: http://localhost:3000
- Frontend-only production acceptance: http://localhost:18080/ and http://localhost:18081/portal.html

## Changed behavior

Password/verification-code alternatives are clear; password stays available despite late/failed capabilities, preserves exact input and has accessible reveal/autofill semantics. Code flows bind challenges, reject stale requests, handle timestamp expiry/resend/Retry-After and show accepted-request wording. Portal completion displays the actual address and correct sign-in method, revokes temporary sessions and resets without affecting a mailbox. Cleanup retry and 200% content-zoom overflow defects were repaired.

English is the sole ordinary selector choice. Unsupported stored locale falls back to English without an unrelated profile update overwriting backend language. Public call-registration configuration provides safe unavailable defaults, normalized tel/copy/manual fallback and honest continuation. No calls, SMS or external mail were sent.

## Authentication capability boundaries

| Capability | Actual status |
|---|---|
| Password signup/login/session restoration/logout | Live local UI verified in Chrome, Firefox and WebKit; works despite OTP discovery failure. Password signup itself does not prove phone ownership. |
| OTP signup/login | Real legitimate isolated development proofs verified for passwordless accounts. Wrong/expired/exhausted/resend/interrupted paths covered. No production provider delivery claim. |
| OTP for password-created accounts | Current backend rejects even a valid code; UI directs to Password. |
| Inbound call registration | Website unavailable/configured states verified only. Official number/provider, consent and usable call-created account login are pending; current backend assigns an undisclosed random password. |
| Outbound voice OTP | Relevant capability/request/error UI exercised with controlled fixtures; no actual voice delivery. Separate from inbound registration and notifications. |
| Password setup/reset; OTP-only key management | Missing backend contracts. No invented password or proof bypass. |

## Verification and performance

Types, 20 unit tests, 827-message extraction audit, build and 95,018/204,800 gzip-byte budget pass. New auth tests distinguish 13 grouped live assertions from six controlled-fault groups; two additional keyboard/layout groups. Focused three-engine mailbox/portal/encryption-unlock acceptance, 15 E2EE production-browser groups, seven offline groups, direct/group file routing, real OTP continuity and frontend packaging pass. See exact per-suite timestamps, assertions and remaining limits in [integration evidence](INTEGRATION-RESULTS.md).

M5/Chrome154 production lab, CDP 4× CPU, shared page-target 150 ms / 200 KiB/s down / 50 KiB/s up: three cold/warm LCP medians 1308/400 ms; offline 74 ms; measured routes 405–414 ms; encryption enrollment 974 ms. These are emulated lab samples, not low-end phones or field percentiles.

## Inputs needed

Immediate: approved Terms/Privacy published URLs and content, matching `VITE_TERMS_VERSION` (current contract `mvp-1`), final HTTPS frontend/portal origins and backend proxy/CORS/cookie/CSRF configuration. Production registration stays gated until legal values are valid. Production OTP accounts additionally need a configured provider and authorized real delivery tests.

Later optional IVR activation: approved `VITE_IVR_PUBLIC_NUMBER`, backend signed inbound/decision webhooks and provider credentials, reviewed consent/version and working call-created account sign-in. Only then enable `VITE_IVR_REGISTRATION_ENABLED` and `VITE_IVR_SIGNIN_READY`. Provider secrets never enter browser configuration. No Tamil or native decision is requested.

Backend-dependent: password setup/reset and IVR login policy, OTP-only key reauthentication, BCC privacy, arbitrary-thread attachments, atomic reply-draft consumption, authorized list attachment metadata, unsaved-sender blocking and push. [Minimal proposals](REMAINING-BACKEND-CONTRACTS.md) include compatibility and acceptance conditions.

Physical devices/autofill/camera, human screen readers/rural studies, actual low-end hardware/storage eviction, deployed TLS and provider/scanner outcomes, long soak and exhaustive cross-engine/form permutations remain unverified. [Owner inputs](OWNER-INPUTS.md), [requirement matrix](REQUIREMENT-MATRIX.md), [coverage](FRONTEND-COVERAGE.md), and [configuration README](../README.md) preserve these boundaries.
