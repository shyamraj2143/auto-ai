# Service Execution Architecture

## Request path

`AI Chat input → typo-tolerant verified-service resolver → persistent ServiceTask → typed chat card → authenticated task API → Service Policy Gateway → portal adapter → submission evidence → printable receipt/summary → refreshed chat card`

The LLM may interpret intent and propose a service or tool call, but it cannot directly mutate the database, invoke Android, navigate a portal, consume a secret, or submit a form. The application resolves a service from the verified registry, validates every state transition, and executes only through registered capabilities.

## Components

- **Intent and service resolver:** normalizes Hindi, English and Hinglish input, corrects common spelling errors, ranks registered service aliases, and rejects unknown generic forms instead of pretending that they are supported.
- **Registry:** stores normalized service, portal and adapter records, official HTTPS domains, requirements, restrictions, fees, authentication, tracking and verification timestamps.
- **Task engine:** owns the legal persistent state machine, versioned edits, user-owned steps, field requests, documents, drafts, sessions, confirmations, attempts, transitions, events and recovery.
- **Requirement renderer:** converts verified service requirements into typed information, document, permission, secure-input, review, confirmation, progress and receipt cards without requiring a separate hardcoded React form for each service.
- **Gateway:** centralizes ownership, selected service, portal verification, capability, consent, data scope, state, risk, restrictions, confirmation, idempotency and evidence checks. Consequential execution also passes through the Trust Decision Gateway.
- **Adapters:** `local_verified`, `guided_browser`, `official_api` and `human_handoff` implement a typed contract. A portal-specific implementation may prepare fields, validate documents, fill supported fields, submit, verify and track only when its declared capabilities and policy allow those operations.
- **Chat UI:** the server returns a typed active card. The card renderer owns validation and invokes task APIs; free-form markdown never represents executable controls. Completion appears only after the backend confirms persistence.
- **Live workflow view:** server events update the current operation, elapsed time, step number, progress and application preview. A timer alone never claims real external progress.
- **Printable output:** verified or unverified receipt cards can open Android/browser print preview and download an A4-compatible HTML summary. Authentication secrets are excluded and sensitive identity values are masked.
- **Native capabilities:** Capacitor exposes truthful, scoped and user-initiated Android capabilities such as camera permission, document selection, verified Custom Tabs, device confirmation, app settings and printing. It does not expose unrestricted access to every app, screen, file or credential.

## Execution strategy

AutoAI selects the safest available strategy in this order:

1. Official authenticated API with verifiable response.
2. Tested and permitted portal-specific adapter.
3. Verified guided browser session with prepared data and documents.
4. User-controlled official portal completion.
5. Explicit least-data human handoff when the user approves it.

Unknown or changed portals do not fall back to arbitrary browser scripting. They remain unsupported or guided until a verified adapter and tests are added.

## Portal-specific automation boundary

A universal schema-driven workflow avoids rebuilding the chat UI for every new form, but external websites still have different fields, authentication, CAPTCHA, declarations, payments, anti-bot controls and terms. Therefore autonomous submission is enabled service-by-service through verified adapters or official APIs.

Guided mode may collect information, validate documents, prepare mappings, open the exact official origin, show what remains and preserve progress. It must not claim that an external submission succeeded until evidence is independently verified.

Passwords, OTPs, PINs, CAPTCHA answers, payments, biometrics and legally binding declarations remain user-controlled unless an official supported flow explicitly allows a narrowly scoped operation. CAPTCHA bypass, OTP interception and hidden credential capture are prohibited.

## State and evidence

Every state change records actor, source, reason, request ID, previous/new states and optional evidence. Adapter acknowledgement and verified completion are distinct. `COMPLETED_VERIFIED` requires a validated application identifier, signed/API acknowledgement, confirmation-page evidence or official receipt artifact.

Printing an application summary does not itself prove submission. The printed document clearly labels verified, unverified and in-progress states.

## Persistence and concurrency

All task resources include `user_id`; API queries always include it. Editable records carry a version and use optimistic concurrency. Consequential operations have unique per-user idempotency keys. Audit and transition rows are append-only. Non-secret drafts may resume after refresh or restart; secrets are never restored from ordinary storage.
