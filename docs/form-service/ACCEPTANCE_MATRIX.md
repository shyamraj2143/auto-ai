# Form Service Acceptance Matrix

| Requirement | Status | Verification evidence |
|---|---|---|
| Chat intent creates a persistent task and plan card | Pass | Authenticated browser smoke and API integration test |
| Short validated information steps | Pass | Production-autoflush state/API and component tests |
| Secrets excluded from persistence/model/logs | Pass | OTP isolation, schema/tool redaction and chat-history tests |
| Document upload, validation, analysis, ownership | Pass | MIME/magic/size/parser, signed-preview, extraction review and ownership tests |
| Just-in-time truthful permissions and fallback | Pass | Component tests and Android capability tests |
| Verified portal session with exact domain/mode | Pass | Origin policy, gateway and guided-session tests |
| CAPTCHA/biometric/payment pauses without bypass | Pass | Human-action state tests and guided adapter contract |
| Review displays values, sources, confidence, warnings | Pass | Component tests and browser review step |
| Final confirmation blocks early/duplicate submission | Pass | Confirmation, idempotency and browser submit tests |
| Receipt separates acknowledgement from evidence | Pass | Verified and intentionally unverified adapter tests |
| State transitions are legal and append-only | Pass | Legal transition and audit mutation rejection tests |
| Cross-user isolation | Pass | Task/API/document ownership predicates and tests |
| App restart resumes latest card | Pass | Browser reload retained verified receipt and exact identifiers |
| Unsupported portal switches to guided mode | Pass | Resolver and guided portal contract tests |
| Offline drafts recover without unsafe replay | Pass | Non-secret local draft restore component test; external controls wait for connectivity |
| Fresh and existing schema upgrade | Pass | Migration script validated 7 required tables and 6 registry services on both paths |
