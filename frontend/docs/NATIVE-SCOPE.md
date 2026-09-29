# Native and product scope assessment

The active website is `frontend/`: one React 18.3.1 / Vite / TypeScript project with separate client and portal entry points. It is not duplicated into directory names mentioned by the blueprint. Existing backend source and architecture were not edited.

`../frontrepo/mobile/` contains `App.tsx`, `app.json`, `babel.config.js`, `Dockerfile`, historical `dist/` and `node_modules/`. It has **no package.json, package lock or TypeScript project configuration** at its root. Historical generated files and installed dependencies do not establish a reproducible application. No native compilation/device acceptance was claimed.

The native App.tsx is a monolithic earlier implementation: password-based account forms, basic conversation list/reader/compose/profile and a few folders. It has English literals, only an English language button, simplistic local terms text, limited recipient input, no equivalent current OTP/draft/offline/E2EE/contacts flows, and bearer token persistence in AsyncStorage rather than platform-protected session storage. Its compose creation path and account forms need review against current backend contracts. This is source inspection, not evidence these screens function now.

Current product decision: native Expo, iOS/Android, APKs, stores and native parity are **outside this website/portal delivery**, not launch blockers. The observations above preserve historical blueprint traceability; no owner decision or native implementation is requested in this pass.

Navigation decision is resolved: unified **Home** is the primary mobile mailbox view, with Inbox, Sent and other supported folders accessible as secondary views. This supersedes the Inbox/Sent-first wording of historical blueprint sections 11/65/68.
