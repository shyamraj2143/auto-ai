# Service Execution Architecture

## Request path

`AI Chat input → deterministic service resolver → persistent ServiceTask → typed chat card → authenticated task API → Service Policy Gateway → adapter → receipt evidence → refreshed chat card`

The LLM may propose a service or tool call but cannot mutate the database, invoke Android, navigate a portal, consume a secret, or submit a form. The application resolves service IDs from the verified registry and validates every transition.

## Components

- **Registry:** normalized service/portal/adapter records, official HTTPS domains, requirements, restrictions, fees, authentication, tracking, and verification timestamps.
- **Task engine:** legal persistent state machine, versioned edits, user-owned steps, field requests, documents, drafts, sessions, confirmations, attempts, transitions, events, and recovery.
- **Gateway:** centralized ownership, selected service, portal verification, capability, consent, data scope, state, risk, restrictions, confirmation, idempotency, and evidence checks. Consequential execution also passes through the Trust Decision Gateway.
- **Adapters:** `local_verified`, `guided_browser`, `official_api`, and `human_handoff` implement a typed contract. Guided mode prepares data and opens an allowlisted official destination; it never claims external submission.
- **Chat UI:** the server returns a typed active card. The card renderer owns validation and invokes task APIs; free-form markdown never represents executable controls.
- **Native capabilities:** Capacitor provides truthful capability state and user-initiated Android system surfaces. Protected access is requested only at the action where it is required.

## State and evidence

Every state change records actor, source, reason, request ID, previous/new states, and optional evidence. Adapter acknowledgement and verified completion are distinct. `COMPLETED_VERIFIED` requires a validated application identifier, signed/API acknowledgement, confirmation page evidence, or receipt artifact.

## Persistence and concurrency

All task resources include `user_id`; API queries always include it. Editable records carry a version and use optimistic concurrency. Consequential operations have unique per-user idempotency keys. Audit and transition rows are append-only.
