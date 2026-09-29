# Owner inputs and release boundaries

The current delivery is the responsive website and separate registration portal, with **English only** in ordinary development and production. Unified Home is the approved primary mobile view; Inbox/Sent remain available. Native Expo/apps and additional launch languages are outside this delivery. No Tamil approval or native-scope decision is needed for this launch.

## Immediate launch inputs

- Approved, published Terms and Privacy content and their exact URLs: `VITE_TERMS_URL`, `VITE_PRIVACY_URL`. `VITE_TERMS_VERSION` must match that approved copy and the backend contract (currently `mvp-1`). Production registration remains disabled until configured; existing-account login remains available. Development consent is explicitly labeled and is not approval.
- Final backend origin for the server-side `API_PROXY_TARGET`, public website/portal HTTPS hostnames, matching backend CORS/cookie/CSRF settings and deployment routing. Browser requests remain same-origin `/api`; never put provider credentials or a developer's localhost API into deployed browser code. Final-host/TLS checks remain necessary.
- If OTP-only accounts must sign in at launch: an owner-configured production OTP provider and authorized delivery acceptance. The isolated local sink proves the integration only. Password accounts can sign in independently of capability discovery or OTP delivery.

## Later optional activation and backend work

- Inbound call registration: owner-approved E.164 official number (`VITE_IVR_PUBLIC_NUMBER`), signed provider inbound/decision webhook configuration, reviewed consent wording aligned to the approved legal version, and a working sign-in path for call-created accounts. Set `VITE_IVR_REGISTRATION_ENABLED=true` and `VITE_IVR_SIGNIN_READY=true` only after those checks. Leave both false until then. Website configuration is public; provider SID/token/signing secrets belong exclusively on the backend.
- Current inbound IVR creates a random undisclosed password hash, while OTP login rejects password-backed accounts. Secure password setup/reset or an explicitly reviewed OTP policy for call-created accounts is required before activation. Do not give users a number that leads to an unusable account. See proposals 6–7.
- Outbound voice OTP (`channel=ivr`) is a separate provider capability. The website supports its request/error lifecycle; no real voice call or SMS was placed. SMTP, notification IVR/SMS, upload-scanner and push outcomes need their own contracts/configuration and authorized acceptance.
- OTP-only encryption key enrollment/rotation/revocation needs the dedicated reauthentication contract in proposal 5. BCC, arbitrary-thread attachments, atomic reply-draft consumption, attachment-list metadata and unsaved-sender blocking remain backend proposals. Supported original-sender thread attachments already work.
- Additional languages can be added later through the catalog registry. Tamil draft review is optional future work, available only with an explicit review flag; it is not a launch blocker. Native applications are outside current scope.

## Unverified external acceptance

Physical phone keyboards/autofill/camera, human screen-reader and rural usability review, actual low-end hardware, real storage exhaustion/eviction, deployed TLS/cookie policy, production providers/scanners and independent security review remain unverified. Tablet widths, CSS content zoom 200% and text scaling are emulation. CDP CPU/network shaping on this Mac is not physical low-end-device acceptance.

Focused Chrome/Firefox/WebKit flows pass, not full cross-engine offline/storage/E2EE parity. Exhaustive form/search permutations, multi-day background eviction and large-file soak remain unverified. Canceling compose navigation warnings preserves unsaved memory; accepting a leave warning can discard it. Phone-change proof/operation state deliberately stays in memory; loss of the tab requires normal sign-in and account inspection, not secret persistence.

The owner's API/database on 3000 remain unchanged. The isolated `deploy/compose.otp-test.yml` environment on 13000 uses disposable tmpfs PostgreSQL and private documented `/tmp/phonemail-blueprint-otp` proof files, with frontend 18082. Codes are read only by tests, never returned by public endpoints, logged, or written to evidence. Do not deploy test infrastructure or credentials.
