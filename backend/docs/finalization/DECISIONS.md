# PhoneMail Finalization Decisions

## Contract and scope

* This stage changes backend code only. The separately managed mobile and web teams own frontend behavior. No dependency or framework upgrade was made.
* Existing public PhoneMail identities remain phone-derived; immutable UUID `user_id` values own accounts and their mailbox data. Public canonical numbers are digit-normalized, without guessing a country prefix. Country handling remains explicit at input.
* Existing addresses are not silently rewritten with an inferred country code. Canonical collisions or ambiguous legacy ownership fail closed for the affected operation; they are not merged.
* `phone_history` is a permanent non-routable reservation. There is no automatic reassignment or indefinite forwarding. A person with a recycled number does not gain access to an older account merely by receiving a new OTP.
* Password fallback is retained. Password registration and local mock OTP do not prove independent real-world phone ownership. Only provider-backed verification is marked provider-verified; no KYC, Aadhaar, PAN, name-based identity, or VPA-like identifier is introduced.

## Authentication and phone continuity

* Local OTP proof consumption and account/session creation run in one database transaction. External-provider approval is not rolled back by PostgreSQL; instead, approval is persisted as a short-lived authorization bound to the exact provider request, challenge SID, phone, purpose, account, and operation. A retry must submit the same approved code; grants are bounded and single-use.
* The exact Twilio Verify Verification SID is used for the check, rather than selecting a newer verification for the same phone. Provider calls are outside long-lived account mutation transactions. Network timeouts are ambiguous, never treated as approval.
* OTP-only accounts must provide independent fresh verification for the current number and proposed number. Password-backed accounts must reauthenticate with their password and verify the proposed number. A proposed-number OTP alone never proves control of an existing account.
* Successful phone change atomically updates number/address/history/audit/sync state, retains the account UUID and mailbox, updates direct conversation pair keys, and invalidates prior sessions. Old addresses remain reserved and do not forward.
* Lost HTTP responses can be recovered only when the client opts in with `Idempotency-Key`. A credential-bound and body-bound response is encrypted with AES-256-GCM and stored in the same transaction, then recoverable for 15 minutes through the phone-change route. The original unexpired bearer/cookie credential remains a narrowly scoped recovery capability on that route only. Reusing the key with another body is a conflict. This is not independent lost-phone recovery.
* Sessions use 15-minute signed access tokens and revocable 30-day refresh families. Opaque refresh credentials are stored as SHA-256 hashes with generation history. The immediately previous credential recovers a cached encrypted response for at most 90 seconds; replay outside that window revokes only its session family. Bearer and cookie renewal are supported, cookie renewal requires CSRF, and logout/phone change/account suspension revoke the applicable session family.

## Concurrency, sync, privacy

* Multi-account message writers lock all involved accounts in sorted UUID order before changes/events. Account streams use a shared advisory lock for retention validation, page reads, and pruning.
* Initial sync is a stable snapshot with continuation; incremental sync begins only at the snapshot's final handoff cursor. Snapshots up to 10,000 records are materialized. Larger snapshots use a repeatable-read stream with at most four active snapshots per API instance and finite expiry. The stream pins a database connection and is process-local, so continuation/close must route to its owner instance; misrouted requests return a recoverable `SNAPSHOT_INSTANCE_AFFINITY_REQUIRED` error. This affinity and pinned-connection cost must be considered by deployment operators. Snapshot state is not reconstructed from a possibly expired event log. Deletion/tombstone behavior and restart/reset outcomes are explicit.
* Legacy unsent messages in conversation history remain owner-private. Authorization is applied consistently to snapshots, incremental projections, searches, message/conversation reads, and downloads, not just one route.
* Contacts, blocks and privacy settings are account-scoped. Blocks are enforced by backend conversation/message operations; recipient confirmation returns minimal discoverability-aware information.

## Abuse controls, providers, and test safety

* Login and password-registration rate limits are database-backed across instances and use HMAC keys for canonical phone/IP identifiers. OTP limits use persisted limits and cooldowns. Expired limit rows are opportunistically cleaned; no raw OTP/password/token is stored in those keys.
* Local OTP remains development-only. No OTP-returning development endpoint or production mock fallback was added. No live provider credentials or traffic were used.
* Integration targets require explicit environment variables and positively check isolated API/database endpoints and database name. The repository-owned acceptance harness runs API and driver on Node 24 in Linux containers, uses the explicit `phonemail-stage3-disposable` network target, starts primary/secondary APIs from the same image, gates readiness, and tracks resources it owns before cleanup. Development services are not a target.
* Phone test identities are generated by a bounded shared allocator that validates candidates through the application's real normalization rules, rejects deterministic invalid examples, and avoids duplicates/retained identities. The allocator has no provider integration and is test-only.
* An earlier unexplained registration HTTP 400 is preserved as unresolved historical evidence. Subsequent tests passed, but logs/status/error details were insufficient to prove its original cause; no root cause is asserted.
* Security event writes are part of the triggering transaction so rollback cannot leave a completed event/notification. Existing successful idempotent retries return their result without duplicating completion events; genuine repeated operations use their ordinary transaction semantics. Failed-password events are recorded only for a known account and coalesced within five minutes, avoiding account enumeration and unbounded per-attempt rows. Event metadata is allowlisted and excludes phone/address strings, credentials, message content, and IP-derived device claims. Durable security notifications are in-app and owner-authorized; no external delivery is performed. Bounded batch maintenance purges audit events and notifications older than 365 days; this is an operational bound, not a legal/compliance assertion. Account recovery, administrator action, account deletion, and device recognition have no implemented trigger and are not represented as supported event categories.
* Migration 029 adds durable security notifications additively; fresh install and upgrade from migration 028 are tested.
* The final source hash manifest is generated only after docs settle, excludes `.env`, dependencies, build outputs, runtime/test data, and does not hash itself. The separate backup remains untouched.

## Stage 2 implementation decisions and current boundaries

* Aliases are now in scope: alias addresses have lifecycle state and explicit create/list/activate/deactivate/delete operations. An inactive alias is not eligible for new routing. The account UUID, rather than a phone string or alias, remains the stable mailbox owner.
* Replies remain limited to one reply per parent message, enforced by the database uniqueness constraint. This does not mean a conversation is limited to one response; replies to distinct parent messages remain separate.
* Existing-thread To/CC roles are immutable across sends and draft sends. Forwarding must be represented as a separate authorized composition, not as a membership change or disclosure of the original thread.
* Message local commitment, provider acceptance/delivery, recipient mailbox state, and read evidence are distinct concepts. Current delivery rows record local commitment; they do not imply external SMTP/SMS delivery or exactly-once provider side effects.
* Snapshot and BIGINT sync cursors are transported as decimal strings to avoid JavaScript precision loss. The materialized snapshot is retained; clients receive the incremental handoff cursor only on its final page.
* Local mock SMS/IVR capability is not evidence of a configured/live provider. Capability output separates `supported`, `configured`, `simulated`, and `liveTested`. `/api/otp/webhook` is the generic test protocol, not a Twilio-signed webhook endpoint.
* Streaming snapshot expiry closes the held client, and instance restart invalidates the old stream with the documented affinity error. Recovery uses the original incremental watermark plus a fresh snapshot, not a silently advanced cursor. Production TTL remains 15 minutes.

## Intentionally deferred or not yet complete

* Local provider-adapter inbound SMS signup, inbound voice press-1 signup, notification processing, signed callback validation/reconciliation, and approved-template fallback are implemented and fixture-tested. Live account/device acceptance, real SMS/call traffic, paid trial setup, and production readiness require separate authorization and credentials.
* External Internet SMTP interoperability is not claimed. The local outbox/MIME harness is not an external delivery transport.
* Independent account recovery without the current number, mobile/web UI work, QR identities, organizations, government workflows, advanced spam systems, `/api/v1` migration, production TLS/deployment, and full metrics/tracing remain future scope.
* Historical authorized message search, basic spam/mailbox controls, privacy enforcement, and aliases are Stage 2 requirements and must not be mislabeled as future work merely because advanced search/classification or rich alias verification is deferred.
* These remaining boundaries are not evidence that preference values alone enforce behavior. Backend-enforced settings and explicit limitations are documented in API/security references; see `VERIFICATION.md` for current Stage 3 test evidence and unverified operational gates.
