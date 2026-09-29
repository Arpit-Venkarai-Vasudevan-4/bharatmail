PhoneMail Frontend — Comprehensive Implementation Blueprint

1. Frontend Objective

Build PhoneMail as a highly accessible, simple, reliable email application for rural users where the user's phone number is their public PhoneMail identity.

Example:

9876543210@phonemail.com

The frontend must make email understandable and usable even for users with limited technical familiarity, smaller screens, slower networks, lower-end devices, and limited experience with conventional email applications.

The frontend must integrate with the existing PhoneMail backend and must NOT redesign or replace the backend architecture.

Core principle:

PHONE NUMBER → PHONEMAIL ADDRESS → USER ACCOUNT → MAILBOX

The frontend must treat the backend's immutable "user_id" as an internal identifier only. It must never expose "user_id" to users or replace the phone-number-based public identity with a VPA/UPI-style architecture.

---

2. Existing Frontend Architecture

Inspect the existing repository before changing anything.

Expected frontend areas:

- "mobile/" — Expo React Native application
- "web-client/" — React/Vite email client
- "web-portal/" — React/Vite signup/onboarding portal

Do not create a new frontend framework or replace the existing stack.

Mobile:

- Expo 52
- React Native 0.76.9
- React 18.3.1
- TypeScript
- AsyncStorage where appropriate

Web:

- React
- Vite
- TypeScript

Use the existing backend API as the authoritative source of account, mailbox, message, authentication, recipient, and verification state.

---

3. Product Surfaces

A. Mobile Application

Primary user experience.

Must support:

- onboarding
- phone verification
- login
- inbox
- sent
- drafts
- trash
- spam
- archive
- compose
- message reading
- replies
- forwarding
- contacts
- search
- account/profile
- settings
- notifications
- blocking
- privacy settings
- logout
- account security
- phone-number change flow where backend supports it

Mobile must be designed for one-handed use.

---

B. Responsive Web Client

The web client must use the same backend and account model.

On small screens:

- single-column layout
- large touch targets
- bottom navigation or similarly accessible navigation
- simplified message presentation
- minimal horizontal scrolling

On desktop:

- persistent sidebar
- wider message list
- keyboard-friendly interaction
- optional multi-column Gmail-like layout
- efficient mouse interaction
- larger information density without sacrificing readability

Do NOT build separate incompatible product logic for mobile and web.

---

C. Signup / Public Portal

The web portal should be focused on account creation/onboarding rather than becoming another full email client.

It should provide:

- phone number entry
- phone number formatting/normalization feedback
- OTP verification
- account creation status
- clear success/failure states
- transition into the PhoneMail experience

Do not expose internal implementation details.

---

4. Design Philosophy

The interface should feel familiar without copying another company's branding.

Use the usability principles of a modern email client:

- clear inbox
- obvious Compose button
- obvious unread state
- predictable navigation
- familiar message cards
- simple search
- clear back navigation
- obvious reply/forward actions

But optimize specifically for PhoneMail's rural-accessibility objective.

Avoid:

- unnecessary animations
- excessive decorative graphics
- dense dashboards
- tiny icons
- jargon
- hidden critical functions
- complicated multi-step interactions
- unnecessary confirmation dialogs
- excessive visual noise

Every important action should be understandable without technical knowledge.

---

5. Accessibility Requirements

Accessibility is a core product requirement, not a cosmetic enhancement.

Support:

- large readable typography
- strong text/background contrast
- scalable text where platform allows
- minimum comfortable touch targets
- icon + text labels for important actions
- screen-reader-compatible labels
- semantic accessibility roles
- meaningful focus states on web
- keyboard navigation on web
- logical tab order
- no color-only communication
- clear disabled states
- clear validation messages
- accessible loading states
- accessible error messages

Important actions must remain understandable when icons are unfamiliar.

For example:

Do not rely only on a trash icon.

Use:

Trash

with an appropriate icon.

---

6. Language Accessibility

Build the UI so localization is possible from the beginning.

Do not hard-code user-facing strings throughout components.

Create a centralized localization structure.

Initial architecture should support:

- English
- Tamil
- other Indian/local languages later

Language selection should be easy to find.

Changing language should update UI labels without changing backend account identity.

Do not translate email addresses or phone numbers.

---

7. Onboarding

The onboarding experience should be extremely simple.

Suggested flow:

1. Welcome
2. Enter phone number
3. Explain that this phone number becomes the user's PhoneMail address
4. Send OTP
5. Enter OTP
6. Verify
7. Create/complete account
8. Explain the resulting PhoneMail address
9. Enter inbox

Example explanation:

Your PhoneMail address is:

9876543210@phonemail.com

Use this address to send and receive email.

Do not overwhelm the user with technical terminology.

---

8. Phone Number Input

Phone number input must:

- support Indian numbers cleanly
- normalize formatting
- avoid accidental spaces/symbol problems
- provide country-code handling where appropriate
- validate before submitting
- show simple human-readable errors
- prevent obvious invalid input
- never treat frontend validation as a security boundary

Backend remains authoritative.

---

9. OTP Experience

OTP UI must support:

- clear OTP input
- automatic focus progression where appropriate
- paste/autofill support where platform allows
- resend countdown
- clear expired-code message
- incorrect-code feedback
- attempt-limit feedback
- loading state
- network failure handling

Do not expose backend security implementation details.

Example:

"That code didn't work. Please check the code and try again."

rather than:

"OTP verification failed with error 401."

---

10. Authentication State

Frontend must have a centralized authentication/session state.

Handle:

- logged out
- authenticating
- authenticated
- session refreshing
- session expired
- authentication failure
- logout
- token/session cleanup

Protected screens must never be accessible merely by manipulating client-side state.

Backend authorization remains authoritative.

---

11. Main Application Navigation

Mobile navigation should prioritize the functions users perform most frequently.

Primary navigation:

- Inbox
- Sent
- Drafts
- Contacts
- Settings/Profile

Compose should be visually prominent.

Secondary folders:

- Archive
- Spam
- Trash

Navigation must always provide an obvious way to go back.

Avoid deeply nested navigation.

A user should never become trapped inside a screen.

---

12. Inbox

Inbox should display:

- sender
- subject
- short preview
- timestamp/date
- unread status
- attachment indicator
- important state where supported

Unread messages must be visually distinguishable without relying only on color.

Each message row should have a large enough interaction area.

Support:

- refresh
- pagination/infinite loading
- pull-to-refresh on mobile
- loading state
- empty state
- error state
- retry
- offline/cache-aware behavior

Example empty state:

"No messages yet."

Avoid intimidating technical messages.

---

13. Message Reading

Message view should clearly separate:

- sender
- recipient
- date/time
- subject
- body
- attachments
- actions

Primary actions:

- Reply
- Forward

Secondary actions:

- Archive
- Delete
- Mark unread
- Spam
- Block sender where supported

Avoid hiding basic actions behind tiny menus.

---

14. Compose

Compose must be one of the simplest flows in the application.

Fields:

- recipient
- CC
- BCC
- subject
- message body
- attachments

Recipient entry should support PhoneMail addresses naturally.

Because the public identity is phone-number based, make recipient entry especially easy.

Support:

- phone number
- complete PhoneMail address
- contacts
- recipient suggestions
- backend recipient resolution
- recipient confirmation

Do not silently send to an unresolved recipient.

---

15. Recipient Confirmation

When a user enters a recipient, resolve it through the backend.

Show a safe confirmation such as:

9876543210@phonemail.com
Rahul

if the backend provides an appropriate display name.

Do not reveal unnecessary information about whether arbitrary phone numbers have accounts.

Protect against account enumeration.

---

16. Drafts

Draft behavior should be resilient.

Automatically save drafts when appropriate.

Handle:

- draft creation
- draft updates
- draft reopening
- draft deletion
- navigation away
- temporary network loss

Where practical, preserve unsent composition locally so a temporary network failure does not erase the user's work.

Clearly distinguish:

Saved
Saving…
Unable to save

Do not falsely claim a draft was saved if the backend has not confirmed it.

---

17. Sending Email

Sending flow:

1. Validate fields
2. Resolve recipients
3. Show sending state
4. Submit to backend
5. Prevent accidental duplicate submissions
6. Display confirmed result
7. Update local state

Use backend idempotency support where available.

If sending fails:

- preserve the draft/message
- explain the problem simply
- provide retry
- do not silently discard the message

---

18. Offline / Low-Bandwidth Behavior

This is a major PhoneMail requirement.

Optimize for:

- slow mobile networks
- intermittent connectivity
- high latency
- temporary disconnection
- limited data usage

Avoid unnecessary network requests.

Cache appropriate mailbox data.

Use compact API payloads.

Do not automatically download large attachments.

Allow composition to continue when temporarily offline.

Queue appropriate operations only when their semantics are safe.

Clearly distinguish:

Offline
Syncing
Synced
Failed to sync

Do not pretend an email has been sent while it is merely queued locally.

---

19. Loading States

Every network-dependent screen must have an intentional loading state.

Avoid blank screens.

Use:

- skeletons where useful
- lightweight spinners where appropriate
- loading text for important actions

For slow connections, communicate that the application is still working.

---

20. Error States

Every important operation needs:

- error message
- understandable explanation
- recovery action where possible

Examples:

Network unavailable:
"You're offline. Your saved draft is still available."

Server error:
"PhoneMail couldn't complete this right now. Please try again."

Expired session:
"Your session has expired. Please sign in again."

Never expose raw stack traces, database errors, SQL errors, or internal service details.

---

21. Empty States

Design explicit empty states for:

- inbox
- sent
- drafts
- trash
- spam
- archive
- contacts
- search results

Each should explain what the user can do next.

Example:

"No drafts yet."

rather than an empty blank screen.

---

22. Search

Search should support mailbox content appropriate to backend capabilities.

Potential searchable fields:

- sender
- recipient
- subject
- message text

Include:

- search input
- loading state
- results
- no-result state
- pagination

Search must not download the entire mailbox just to perform client-side filtering.

---

23. Contacts

Contacts should make phone-number-based email easier.

Contact fields can include:

- display name
- phone number
- PhoneMail address
- optional notes/profile information

Actions:

- create
- edit
- delete
- search
- use recipient

Do not expose unnecessary private account information.

---

24. Blocking

Provide an understandable block/unblock experience.

Example:

Block this sender?

Explain the consequence in plain language.

Backend must enforce blocking.

The frontend must not assume that hiding a sender locally constitutes actual blocking.

---

25. Privacy Settings

Expose supported privacy controls in understandable language.

Potential controls:

- discoverability
- profile visibility
- read receipts
- communication permissions
- notification preferences

Avoid technical terminology.

For example:

"Let others find you using your PhoneMail address"

rather than:

"Enable recipient-resolution discoverability."

---

26. Account / Profile

Show:

- PhoneMail address
- current verified phone number where appropriate
- display name
- language
- notification settings
- privacy settings
- security
- logout

Do not show internal "user_id".

---

27. Phone Number Change

Frontend must follow the backend's account-continuity architecture.

When supported:

1. Authenticate current account.
2. Ask for the new phone number.
3. Explain that the PhoneMail address will change.
4. Verify the new number using OTP.
5. Confirm successful change.
6. Refresh the authenticated account state.
7. Display the new PhoneMail address.

The frontend must NOT create a new local account.

The same backend "user_id" remains the account identity.

Historical messages must continue appearing after the phone-number change.

Clearly communicate this to the user:

"Your PhoneMail address has changed. Your existing messages and account remain available."

---

28. Security UX

Frontend must follow secure UX principles.

Never:

- store passwords in plaintext
- expose tokens in UI
- display secrets
- trust client authorization
- expose internal IDs unnecessarily
- put sensitive information into URLs unnecessarily
- log authentication secrets

Handle:

- token/session expiry
- logout cleanup
- unauthorized responses
- secure storage appropriate to platform
- protected routes
- authenticated API requests

---

29. Attachments

Support:

- selecting files
- upload progress
- upload failure
- retry
- file-size validation
- supported-file feedback
- attachment preview where safe
- download/open actions
- multiple attachments where backend supports it

Do not automatically download large files.

Clearly show attachment sizes.

On slow networks, show progress rather than appearing frozen.

---

30. Notifications

Frontend should integrate with backend notification state.

Support where implemented:

- new mail
- delivery/read events
- security events
- important account changes

Notification preferences must be user-controlled.

Avoid excessive notifications.

---

31. Message Status

Where backend supports it, show understandable states:

- Draft
- Sending
- Sent
- Delivered
- Read
- Failed

Do not expose internal queue/service terminology to normal users.

---

32. Responsive Design

The same application must adapt across:

- small phones
- large phones
- tablets
- laptop screens
- desktop monitors

Do not simply scale the mobile UI upward.

Use responsive layouts.

Desktop can provide more information density.

Mobile must prioritize:

- touch
- readability
- one-handed navigation
- minimal horizontal movement

---

33. Performance

Optimize:

- initial load
- JavaScript bundle size
- unnecessary renders
- image usage
- API requests
- mailbox pagination
- attachment downloads
- local storage usage

Avoid heavy libraries unless they provide meaningful value.

Do not introduce large UI frameworks unnecessarily.

---

34. Low-End Device Support

Assume that some target users may have:

- limited RAM
- slower CPUs
- older Android hardware
- unstable connectivity

Avoid:

- unnecessary animation
- huge images
- excessive simultaneous rendering
- expensive background operations
- unnecessarily large lists in memory

Use virtualized lists for large mailboxes.

---

35. Data Synchronization

Maintain a clear distinction between:

Local UI state
Server state
Cached state
Pending state

Do not allow stale local data to silently overwrite newer server data.

After mutations:

- update optimistically only where safe
- otherwise wait for backend confirmation
- reconcile server state afterward

---

36. API Integration

Create a centralized API client.

It should handle:

- base URL
- authentication
- headers
- request serialization
- response parsing
- error normalization
- retries only where safe
- timeout handling

Do not scatter raw "fetch()" calls throughout every component.

Map backend errors into user-friendly frontend errors.

Do not modify backend contracts merely to make frontend code easier.

---

37. State Management

Separate:

- authentication state
- server/mailbox state
- UI state
- form state
- local persistence

Do not put the entire application into one giant global state object.

Use the simplest architecture that adequately handles the existing application.

---

38. Component Architecture

Create reusable components for recurring UI patterns.

Examples:

- Button
- Input
- PhoneInput
- OTPInput
- MessageRow
- MessageList
- MessageHeader
- ComposeForm
- RecipientChip
- AttachmentItem
- LoadingState
- ErrorState
- EmptyState
- ConfirmationDialog
- Toast/Feedback
- Avatar
- NavigationItem

Components should have clear responsibilities.

Avoid giant components containing navigation, API calls, business logic, and UI simultaneously.

---

39. Form Handling

Every form must have:

- labels
- validation
- keyboard support
- loading state
- disabled state while submitting where appropriate
- error feedback
- successful completion state

Do not clear user input after a failed request unless necessary.

---

40. Accessibility-Friendly Errors

Errors should appear close to the relevant field.

For example:

Phone number
[___________]

"Enter a valid 10-digit phone number."

Do not merely display:

Invalid input.

Use accessible live regions/announcements where appropriate on web and platform accessibility APIs on mobile.

---

41. Confirmation Dialogs

Use confirmations for destructive or consequential operations:

- delete
- permanently delete
- block
- logout where appropriate
- phone-number change completion
- account-related security actions

Do not add confirmation dialogs to every small action.

---

42. Visual Hierarchy

Important actions should visually dominate secondary actions.

Primary:

Compose
Send
Reply
Verify
Save

Secondary:

Archive
Mark unread
More

Destructive:

Delete
Block

Do not make every button visually equally prominent.

---

43. Rural Accessibility

The application should be understandable to a user who has never used Gmail or another advanced email client.

Use:

- plain language
- familiar wording
- obvious navigation
- large controls
- icon + text
- minimal steps
- helpful first-use explanations
- predictable behavior
- visible feedback

Avoid assuming knowledge of:

- CC
- BCC
- SMTP
- IMAP
- JWT
- domains
- server errors
- HTTP status codes

Advanced functions may exist, but should not dominate the basic experience.

---

44. First-Use Guidance

Consider lightweight contextual guidance for:

- Compose
- PhoneMail address
- Inbox
- Contacts
- language selection

Do not force a long tutorial.

Users should be able to skip guidance.

---

45. Accessibility Beyond Visual Design

Support platform accessibility features.

Mobile:

- screen reader labels
- accessible buttons
- appropriate roles
- focus management
- dynamic text where supported

Web:

- semantic HTML
- keyboard navigation
- focus management
- ARIA only where necessary
- accessible dialogs
- accessible menus
- accessible form validation

---

46. Internationalization Architecture

All user-facing strings must be localization-ready.

Do not concatenate sentences in a way that makes translation difficult.

Use translation keys.

Support pluralization and locale-specific date/time formatting where necessary.

---

47. Date and Time

Display timestamps in a human-friendly way.

Examples:

Today → time
Yesterday → date/relative format
Older → date

Allow the platform/browser locale to influence formatting where appropriate.

Do not expose raw ISO timestamps to normal users.

---

48. Accessibility of Color

Do not communicate:

Unread = only blue
Error = only red
Success = only green

Use:

- text
- icons
- labels
- visual weight

in addition to color.

---

49. Reliability During Navigation

Prevent accidental loss of user work.

Examples:

If composing an email and pressing Back:

- save draft if possible
- preserve local content if backend save fails
- warn only when necessary

If an attachment is uploading:

- communicate its state
- don't silently discard it

---

50. Security Boundaries

The frontend is NOT a security authority.

Never rely on:

- hidden UI
- disabled buttons
- client-side role checks
- local state
- local storage
- route protection alone

for authorization.

The backend must authorize every protected operation.

Frontend should nevertheless hide unavailable actions to provide a clean UX.

---

51. API Contract Compatibility

Before implementing:

1. Inspect existing backend routes.
2. Inspect request schemas.
3. Inspect response schemas.
4. Inspect authentication behavior.
5. Inspect error formats.
6. Inspect pagination.
7. Inspect message states.
8. Inspect attachment endpoints.
9. Inspect recipient-resolution behavior.
10. Inspect phone verification behavior.

Use the actual backend contracts.

Do not invent endpoints.

If a required frontend feature has no backend support, document it rather than silently implementing fake functionality.

---

52. No Fake Features

Do not create UI that pretends functionality exists.

Examples:

Do not display "Delivered" unless backend provides delivery state.

Do not display "Verified organization" unless backend provides verification.

Do not claim an email is sent while it is only locally queued.

Do not create fake government communication functionality.

Do not create fake encryption indicators.

Every visible capability must correspond to real implemented behavior or be clearly marked as unavailable/future.

---

53. Error Recovery

Whenever possible provide a direct recovery action.

Examples:

Network error → Retry
Expired session → Sign in again
Failed draft save → Retry
Failed attachment → Retry
Failed send → Return to draft
Invalid OTP → Enter again / resend when available

The user should not need to restart the entire application to recover from a normal error.

---

54. Testing

Implement frontend tests for critical flows.

Minimum critical flows:

1. Signup
2. OTP verification
3. Login
4. Logout
5. Inbox loading
6. Open message
7. Compose
8. Recipient resolution
9. Send
10. Draft save
11. Draft reopen
12. Search
13. Attachment handling
14. Block/unblock
15. Privacy settings
16. Session expiry
17. Network failure
18. Empty states
19. Phone-number change
20. Account continuity after phone-number change

Critical continuity test:

Create account
→ user_id X
→ receive/send messages
→ change phone number
→ verify new phone
→ refresh account
→ same account remains
→ same mailbox remains
→ old messages remain available
→ new PhoneMail address is displayed.

---

55. Cross-Platform Testing

Test:

Mobile:

- small screen
- larger screen
- keyboard open
- screen-reader navigation where possible
- poor network
- offline transition

Web:

- mobile browser width
- tablet width
- desktop width
- keyboard navigation
- browser refresh
- expired session
- slow network

---

56. Performance Testing

Test:

- large inbox
- many messages
- multiple attachments
- slow API
- slow network
- repeated navigation
- app restart
- cached data

Ensure message lists remain responsive.

---

57. Visual Consistency

Create a small shared design system.

Define:

- typography scale
- spacing
- buttons
- inputs
- cards
- dialogs
- navigation
- status indicators
- accessibility states

Do not create every screen independently.

---

58. Mobile Interaction Rules

Prioritize thumb-friendly interaction.

Important controls should generally be reachable without precision tapping.

Avoid placing destructive actions directly beside primary actions without sufficient separation.

Support:

- swipe gestures only when discoverable and accessible alternatives exist
- pull-to-refresh
- back navigation
- keyboard dismissal
- appropriate keyboard types for inputs

Do not make gestures mandatory.

---

59. Web Interaction Rules

Support:

- mouse
- touch
- keyboard

Important operations should have keyboard-accessible alternatives.

Maintain visible focus.

Do not create inaccessible custom controls when native HTML controls are sufficient.

---

60. Local Persistence

Persist only data that genuinely improves UX.

Potential candidates:

- session information using secure platform-appropriate mechanisms
- language preference
- UI preferences
- unsent draft content
- safe cached mailbox data

Do not persist sensitive information unnecessarily.

Do not store authentication secrets in ordinary plaintext local storage when a safer platform mechanism is available.

---

61. Notifications and Background Behavior

Respect platform limitations.

Do not assume the frontend can continuously run background synchronization.

Use backend-driven mechanisms where necessary.

Avoid aggressive polling.

---

62. Accessibility + Low Bandwidth Together

These requirements must not fight each other.

Examples:

- Use text instead of unnecessary images.
- Use lightweight icons.
- Avoid large decorative assets.
- Keep essential information available as text.
- Don't require animations to understand state.
- Don't make accessibility dependent on remote resources.

---

63. Government Communication Readiness

PhoneMail may eventually support verified government/public-service communication.

The frontend architecture should therefore be extensible for:

- verified organization indicators
- official sender information
- structured requests
- service-related messages

But do not fabricate these features if the backend does not currently implement them.

---

64. Future Extension Compatibility

Keep architecture extensible for:

- phone-number recovery
- recovery codes
- trusted devices
- aliases
- QR identity sharing
- verified organizations
- government services
- structured requests
- richer notification systems

Do not implement future features as fake placeholders unless required by the current product.

---

65. Critical UX Principle

PhoneMail should never feel like a complicated enterprise email system.

The default user journey should be:

VERIFY PHONE
→ SEE PHONE MAIL ADDRESS
→ OPEN INBOX
→ READ
→ COMPOSE
→ SEND

Everything else should remain secondary.

---

66. Implementation Order

Implement in this order:

Phase 1 — Foundation

- inspect existing code
- routing
- design system
- API client
- authentication state
- error architecture
- loading/empty states
- responsive foundation

Phase 2 — Authentication

- onboarding
- phone input
- OTP
- login
- session handling
- logout

Phase 3 — Core Mail

- inbox
- message list
- message view
- sent
- drafts
- compose
- recipient resolution
- send

Phase 4 — Mail Management

- archive
- trash
- spam
- search
- pagination
- read/unread
- reply
- forward

Phase 5 — Accessibility / Reliability

- localization
- Tamil-ready architecture
- screen reader support
- keyboard navigation
- low-bandwidth behavior
- offline draft preservation
- robust errors
- retry behavior

Phase 6 — User Features

- contacts
- blocking
- privacy
- notifications
- profile/settings
- attachment UX

Phase 7 — Account Continuity

- phone-number change flow
- account refresh
- same-user continuity verification
- historical mailbox verification

Phase 8 — Hardening

- security review
- API-contract review
- accessibility audit
- responsive audit
- performance audit
- network failure testing
- cross-platform testing

---

67. Agent Instructions

Before changing code:

1. Inspect the entire existing "mobile/", "web-client/", and "web-portal/" structure.
2. Inspect backend API contracts and existing documentation.
3. Inspect existing components and utilities.
4. Identify what is already implemented.
5. Do not duplicate existing functionality.
6. Do not replace working architecture unnecessarily.
7. Preserve existing package versions unless there is a concrete compatibility reason.
8. Reuse existing components when appropriate.
9. Implement incrementally.
10. Keep TypeScript strict and maintainable.
11. Do not invent backend endpoints.
12. Do not invent backend responses.
13. Do not fake unsupported features.
14. Keep mobile and web behavior conceptually consistent.
15. Prioritize real working functionality over visual decoration.

After implementation:

- run available tests
- run type checking
- run linting
- build web applications
- verify mobile compilation/bundling where available
- test backend integration
- test authentication
- test mailbox flows
- test failure states
- test responsive layouts
- test accessibility
- test low-bandwidth behavior

Fix actual issues found.

Do not perform unrelated refactors.

---

68. Definition of Done

The frontend is complete only when a new user can realistically:

1. Open PhoneMail.
2. Understand what PhoneMail is.
3. Enter their phone number.
4. Verify using OTP.
5. See their PhoneMail address.
6. Enter the mailbox.
7. Understand the inbox without prior email expertise.
8. Open a message.
9. Reply.
10. Compose a new message.
11. Enter a phone-number-based recipient.
12. Confirm the recipient.
13. Send the message.
14. See the resulting state.
15. Save and reopen drafts.
16. Handle network failure without losing work.
17. Search messages.
18. Manage messages.
19. Use contacts.
20. Change supported privacy/settings.
21. Log out safely.
22. Use the interface comfortably on a phone.
23. Use the same account on desktop web.
24. Navigate using accessibility features.
25. Continue using the same mailbox after a supported phone-number change.

The final frontend should feel simple to a first-time user while having the underlying architecture required for a serious email application.

Most importantly:

DO NOT optimize for the number of screens or visual complexity.

Optimize for:

CLARITY
ACCESSIBILITY
RELIABILITY
LOW-BANDWIDTH USABILITY
SECURITY
RESPONSIVENESS
REAL BACKEND INTEGRATION
AND MINIMAL USER EFFORT.