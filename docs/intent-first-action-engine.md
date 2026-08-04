# AutoAI Intent-First Adaptive Action Engine

Every non-empty AI Chat message enters `/api/v1/intent-engine/interpret`. A strict `IntentClassification` captures domain, primary/secondary intent, action type, entities, missing requirements, confidence, urgency, risk, autonomy, capabilities, and active workflow reference. A deterministic router returns one outcome before response generation or tool planning.

Persistent tables store intent audit events, declarative definitions, resumable runs, requirements, secure challenge metadata, receipts, preference suggestions, and privacy-safe feedback. All rows are user-owned. Workflow JSON is limited to declarative step types, 50 steps, 900-second step timeouts, registered tools, acyclic `next` links, and mandatory confirmation before high-risk tools.

The chat renderer supports only its compiled component allowlist. Unknown types are ignored; model-supplied HTML or JavaScript is never executed. Authentication values use a separate endpoint, are hashed with per-value salt, expire within ten minutes, are tied to one user and workflow, are never returned, and are excluded from normal interaction submission.

Allowlisted low-risk alarm requests can continue into the existing action assistant and Trust Decision Gateway. High-impact form, government, finance, identity, medical, legal, destructive, and submission workflows stop for explicit review. The receipt hook records `VERIFIED` only when concrete evidence exists; otherwise it records `ATTEMPTED_UNVERIFIED`.
