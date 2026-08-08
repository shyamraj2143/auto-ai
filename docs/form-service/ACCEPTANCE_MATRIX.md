# Form Service Acceptance Matrix

| Requirement | Status | Verification evidence |
|---|---|---|
| Chat intent creates a persistent task and plan card | Pass | Authenticated service API and chat integration path |
| Misspelled supported service still routes correctly | Pass | Regression tests for `incom certificate`, Hindi/Hinglish aliases and unknown-service rejection |
| Known service is not redundantly requested again | Pass | High-confidence registry match starts the persisted service workflow directly |
| Short validated information steps | Pass | Production-autoflush state/API and component tests |
| Empty step never displays false saved success | Pass | Dynamic interaction regression tests require valid input and backend persistence |
| Card resets when workflow advances | Pass | Completed interaction is replaced by the next active field card |
| Real working state is visible | Pass | Task event stream, current operation, step count, elapsed time and progress card |
| Secrets excluded from persistence/model/logs | Pass | OTP isolation, schema/tool redaction and chat-history tests |
| Document upload, validation, analysis, ownership | Pass | MIME/magic/size/parser, signed-preview, extraction review and ownership tests |
| Just-in-time truthful permissions and fallback | Pass | Component and Android capability implementations |
| Verified portal session with exact domain/mode | Pass | Origin policy, gateway and guided-session tests |
| CAPTCHA/biometric/payment pauses without bypass | Pass | Human-action state and guided adapter contract |
| Review displays values, sources, confidence, warnings | Pass | Review card and application preview |
| Final confirmation blocks early/duplicate submission | Pass | Confirmation and idempotency enforcement |
| Receipt separates acknowledgement from evidence | Pass | Verified and intentionally unverified adapter behavior |
| Printable application is available | Pass | Web and Android print flow plus downloadable HTML summary |
| Printable output excludes secrets | Pass | Password/OTP/PIN exclusion and identity-number masking regression test |
| State transitions are legal and append-only | Pass | Legal transition and audit mutation rejection tests |
| Cross-user isolation | Pass | Task/API/document ownership predicates and tests |
| App restart resumes latest card | Pass | Persisted task and latest-card reload behavior |
| Unsupported portal switches to guided mode | Pass | Resolver and guided portal contract |
| Offline drafts recover without unsafe replay | Pass | Non-secret local draft restore; external controls wait for connectivity |
| Unrestricted mobile/app access is blocked | Pass | Android integration exposes scoped user-initiated capabilities only |
| Fresh and existing schema upgrade | Pass | Migration script and registry initialization |

## Explicit non-acceptance

“Any website can always be autonomously submitted” is not an acceptable completion claim. Real autonomous submission requires an official API or a tested, permitted adapter for that portal. Otherwise AutoAI must use guided completion and label the result truthfully.
# Seva agent workflow — 2026-08-09

| Requirement | Evidence | Result |
|---|---|---|
| Admin creates agent ID/password and capacity | Agent management API/UI; password hash only | Pass |
| Separate agent login and assigned-work isolation | `/agent/login`, `/agent/work`, backend role/profile checks | Pass |
| Automatic fair assignment and queue | Least-loaded capacity service; FIFO queue position/recovery test | Pass |
| User/agent requirement updates | Durable private notifications and 10–12 second live refresh | Pass |
| Documents and final receipt | Scoped PDF/image request/upload/download and deliverable completion | Pass |
| OTP/password/CAPTCHA safety | Protected action confirmation only; raw value rejected/excluded | Pass |
| Website and Android | Shared responsive React/Capacitor implementation; production build passes | Pass |
