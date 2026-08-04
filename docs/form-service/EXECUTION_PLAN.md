# AutoAI Service Execution Engine — Execution Plan

## Delivery order

- Establish a persistent, user-owned service-task schema and legal state transitions.
- Resolve natural-language service requests through a verified registry; model output remains a proposal.
- Enforce ownership, portal allowlists, consent, confirmation, idempotency, and evidence through one gateway.
- Implement local verified, guided-browser, official-API, and human-handoff adapters behind one contract.
- Render typed workflow cards inside the existing AI Chat and persist each card in message metadata.
- Add secure document, ephemeral secret, offline recovery, tracking, and live event flows.
- Add Capacitor capabilities for document selection, permission state, secure confirmation, network state, and official Custom Tabs.
- Verify fresh/existing database initialization, backend/API/state/security tests, frontend tests/build, Android tests/build, and browser flows.

## Milestone gates

Each milestone requires production code, ownership tests, stable errors, persistence after reload, and updated evidence in `ACCEPTANCE_MATRIX.md`. External submission is never represented as complete without adapter evidence.

## Baseline recorded 2026-08-04

- Backend (Python 3.13): 292 passed. The machine-default Python 3.14 cannot collect the existing SQLAlchemy 2.0.36 `intent_engine` annotations; this is an environment compatibility issue, not a product-test failure.
- Frontend: 253 passed; TypeScript and production build passed.
- Android: `testDebugUnitTest` passed (71 tasks up to date).
- No frontend lint script exists in the repository.

## Completion evidence recorded 2026-08-04

- Backend: 319 tests passed under the production-compatible Python 3.13 environment.
- Frontend: 266 tests passed; TypeScript and production build passed.
- Schema: fresh initialization and repeated existing-database migration each validated 7 required tables and 6 service definitions.
- Android: 76 unit tests passed and signed release APK assembly passed after Capacitor sync.
- Browser: authenticated service plan, data collection, draft, review, separate confirmation, verified receipt, reload persistence, clean console/network and 390px responsive checks passed.
- Source scan: no unfinished or deceptive implementation markers remain in the feature paths.
