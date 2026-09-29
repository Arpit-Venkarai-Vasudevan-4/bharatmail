# PhoneMail web client

Responsive mailbox and separate registration portal using the existing PhoneMail backend. See the [completed handoff](docs/FINAL-HANDOFF.md) for current behavior, exact verification and remaining external inputs.

## Run locally

Use Node 24.21.x (the package requires >=24.21.0 and <25). The backend is already running at http://localhost:3000; do not restart it for frontend work.

```sh
cd /Users/shubhamchahar/Documents/buildfront/frontend
npm ci
cp .env.example .env.local
npm run dev -- --host localhost
```

Open http://localhost:8080/. The registration portal is http://localhost:8080/portal.html. All browser API calls use same-origin /api paths with cookie/CSRF protection. Configure the server-side proxy through `API_PROXY_TARGET=http://localhost:3000` in .env.local. The separate portal uses credentials:omit and temporary bearer credentials kept in memory.

For a production preview:

```sh
npm run build
npm run preview -- --host localhost
```

Stop the dev server before using preview on its same port. An optional separate portal dev server uses `npm run dev:portal -- --host localhost` on 8081.

Production registration is blocked until approved `VITE_TERMS_URL`, `VITE_PRIVACY_URL`, and matching `VITE_TERMS_VERSION` are configured. The current API contract uses mvp-1; configuration must match approved published copy. Development placeholders are explicitly labeled.

## Checks

```sh
npm run check
npm run measure
npm run test:live
npm run test:live:modules
npm run test:ui:packaged
npm run test:ui:e2ee
npm run test:ui:offline
npm run test:ui:multitab
npm run test:ui:responsive
npm run test:ui:ambiguous-draft
npm run test:ui:threads
npm run test:ui:auth-final
npm run test:ui:auth-edges
npm run measure:browser
```

The live and browser suites create disposable local accounts, contacts, mail, uploads and keys. They revoke sessions afterward; fixture records remain in the local database. They do not contact real recipients or send paid provider traffic. Override local test origins with `API_ORIGIN`, `CLIENT_ORIGIN`, or `UI_ORIGIN` as documented in each script.

The manual response-loss harness at `/tests/live-browser.html` is available only in the Vite development server and is excluded from production output. The automated browser acceptance scripts use Playwright with installed Chrome and real local backend requests.

```sh
npm run build
LAB_PORT=8081 LAB_LATENCY_MS=150 LAB_KBPS=200 npm run profile
```

The optional production lab server injects a visible numeric timing report. It throttles each static response independently; it does not throttle the local API or CPU. Use an origin allowed by the backend (localhost:8081 in the local configuration). Do not expose the lab server publicly.

## Packaging and evidence

Dockerfile, compose.frontend.yml and deploy/nginx.conf provide client/portal builds, SPA fallback, same-origin API proxy, cache policy and security headers. The Nginx container accepts `API_PROXY_TARGET` (default `http://backend:3000`). Docker was available and both frontend images were built and exercised without rebuilding or stopping the existing backend or database. Test containers used ports 18080 and 18081; the packaging report records the temporary local-origin forwarding required by the backend's 8080/8081 allow-list.

See [integration results](docs/INTEGRATION-RESULTS.md), [coverage and remaining work](docs/FRONTEND-COVERAGE.md), and the browser, package, offline, multi-tab, responsive, and performance evidence under `docs/`. These documents distinguish implemented behavior from tested behavior and remaining release requirements.

## Localization maintenance

English is the only launch and ordinary-development interface. Only explicit `VITE_TRANSLATION_PREVIEW=true` review builds offer the unapproved Tamil overlay with English fallback for newer messages. `src/i18n/en.json` is the source catalog; `src/i18n/index.ts` validates keys/interpolation tokens, provides locale-aware formatting, and loads only explicitly registered catalogs. App and authentication roots subscribe to locale changes. Catalog keys, HTTP headers, keyboard key values, account identities and API enum values must not be translated. Translate the displayed label for an enum instead.

For an owner-approved launch language, add a complete reviewed JSON catalog, register its dynamic import in `approvedLoaders` and its language/direction in `interfaceLanguages`, and expose it in the interface-language selector. The selector persists locally and synchronizes the supported account language preference; unsupported stored preferences must not imply that a translation is available. Verify plurals, date/number formats, RTL layout when applicable, and screenshots in that language before listing it as available. Tamil is registered only for explicit review preview; approval is optional future work, not an English-launch requirement. See [translation review](docs/TRANSLATION-REVIEW.md).

Run `npm run i18n:check` to audit authored strings, or `node scripts/extract-catalog.mjs --write` to migrate newly written copy and refresh catalog locations. Review the generated diff: the AST audit assists extraction but cannot certify translation quality or every third-party browser/library error. `npm run check` includes the audit.

## Isolated OTP acceptance

The owner's port-3000 backend has no test sink and must stay running unchanged. `deploy/compose.otp-test.yml` uses its existing backend image with a separate disposable PostgreSQL tmpfs and private documented OTP sink. It exposes API 13000 only on localhost. It disables transport/workers; no real provider traffic occurs.

```sh
mkdir -p /tmp/phonemail-blueprint-otp
chmod 700 /tmp/phonemail-blueprint-otp
docker compose -p pm-blueprint-otp -f deploy/compose.otp-test.yml up -d
API_PROXY_TARGET=http://localhost:13000 npx vite --host 127.0.0.1 --port 18082 --strictPort
# In another terminal:
npm run test:ui:otp
```

The script reads legitimate `{challengeId}.code` files only in its local process and never prints their contents. It takes at least 180 seconds to exercise real server-time expiry. This is simulated local OTP acceptance, not SMS delivery. Do not expose this development setup publicly or reuse its disposable credentials.

The [126-group requirement matrix](docs/REQUIREMENT-MATRIX.md) covers all 68 blueprint sections, including historical native traceability, and links implementation/evidence/remaining work. See [owner inputs](docs/OWNER-INPUTS.md) for release prerequisites. Native Expo/apps are outside the current delivery. Unified Home as the mobile default is a resolved product decision.

### Local acceptance continuation

With the existing isolated OTP stack running, start `API_PROXY_TARGET=http://localhost:13000 npx vite --host 127.0.0.1 --port 18082 --strictPort`. The portal is `/portal.html` on that same development origin, deliberately sharing the mailbox browser cookie scope for isolation tests. Development consent is not approved production legal content. Install managed alternate engines with `npx playwright install firefox webkit`.

- `npm run test:ui:local-acceptance`: Chromium/Firefox/WebKit critical paths and valid portal OTP/revocation/isolation; real proof expiry takes about three minutes.
- `npm run test:ui:web-recovery`: compose navigation, key-lock recovery, committed phone-change response loss, form errors and bounded contacts.
- `npm run test:ui:layout-resume`: keyboard, tablet/text/content-zoom, two-minute lifecycle freeze and trash/restore.

Use these tests against disposable local fixtures. Do not edit imported frontend sources/catalogs during dev-browser runs: Vite HMR can reload their execution context. No OTP codes or credentials are written to reports. The owner backend on 3000 is never restarted by these commands.

## Password, verification codes and call registration

Password is the initial choice and remains available if OTP capability discovery fails. Passwords are never trimmed; signup follows the backend minimum 6 characters / maximum 72 UTF-8 bytes. Password registration does not verify phone ownership. Code registration creates a passwordless account. These are alternative methods, not two-factor authentication.

The current backend permits OTP login only for accounts without a password hash: a password-created account must use Password even with a valid code. No secure password setup/change/reset endpoint is available. Inbound IVR currently assigns an undisclosed random password, so call-created web sign-in needs the backend change described in [proposals](docs/REMAINING-BACKEND-CONTRACTS.md).

Inbound call registration defaults to “coming soon.” To activate later, configure the public build values `VITE_IVR_PUBLIC_NUMBER` (approved international number), `VITE_IVR_REGISTRATION_ENABLED=true`, and `VITE_IVR_SIGNIN_READY=true`, plus approved legal URLs/version. Both client and portal Docker builds accept these arguments. Number validation rejects schemes, queries, pauses and appended consent digits. `tel:` only opens the calling application; no call or consent occurs automatically. Provider webhook/signing secrets are backend-only. Outbound voice OTP is separately gated by `/api/otp/capabilities` and uses `channel=ivr`.

The frontend uses `/api` in development and production. Set `API_PROXY_TARGET` on the Vite server or Nginx container to the final reachable API origin; configure backend CORS/cookie/CSRF for the public frontend origins. Public `VITE_*` values are build-time values, so rebuild frontend images after changing them. Nginx's proxy target is runtime configuration. Do not deploy the temporary test Origin-forwarding templates used on ports 18080/18081. Never deploy the OTP fixture stack or enable simulated delivery in production.

`npm run test:ui:auth-final` uses the isolated API/frontends on 13000/18082 and an optional configured IVR UI fixture on 18083. Start that second Vite process with the same isolated API target, `VITE_IVR_PUBLIC_NUMBER='+1 (415) 555-0123' VITE_IVR_REGISTRATION_ENABLED=true VITE_IVR_SIGNIN_READY=true`; this reserved fictional number is test configuration only and is never dialed. The suite distinguishes real sink-backed flows from controlled capability/provider failures. Tests must never activate call links or request configured paid providers.

Historical `test:ui:blueprint` and `test:ui:locale` suites contain Tamil-review assertions and require an explicitly `VITE_TRANSLATION_PREVIEW=true` review server. They are not ordinary English-launch acceptance. Their earlier artifacts remain dated evidence; use the final authentication/local-acceptance/recovery suites for the current default build.
