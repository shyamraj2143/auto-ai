# Trust Hub Architecture

All consequential actions flow through one server-owned Trust Decision Gateway:

`proposal → policy → consent/OS permission → authority/elevation → constraints/risk → confirmation → adapter → receipt → evidence → recovery/learning`

Model output and external content can only produce proposals. Deterministic validated application code owns authorization and execution. User-owned rows are filtered by authenticated user ID. Native permission and biometric results come from Capacitor plugins; unsupported platforms fail closed. Offline mutations are encrypted locally, idempotent, and fully re-authorized before replay.

The existing React/Capacitor, FastAPI/SQLAlchemy, Android Java and additive runtime-migration conventions remain authoritative.

## Intent-first boundary

AI Chat sends every non-empty user message through the authenticated intent preflight before response generation or action planning. The interpreter emits a strict hierarchical object; deterministic policy then selects exactly one router outcome. Reply-only turns continue to the existing generation pipeline. Action turns enter a user-owned persistent workflow and render validated interaction metadata. Model output cannot grant permission, confirm an action, select an unregistered tool, create executable code, or write memory.

Secure challenges are separate requests and never enter message content, prompt context, analytics, receipts, feedback, or memory. External execution continues through the Trust Decision Gateway. Receipts distinguish verified completion from an attempted but unverified result.

## Service execution boundary

The Service Execution Engine resolves only persisted registry entries. Its service gateway validates task ownership, exact portal origin, legal state, scoped consent, emergency pause, final confirmation and idempotency before calling an adapter. Guided portal outcomes remain unverified until independent evidence exists. Cloud document analysis and human handoff use the same gateway and receive only the explicitly approved data scope.
