# Portal Adapter Guide

## Contract

An adapter declares its ID, mode, supported service IDs, official domains, capabilities, authentication type, timeout, retry policy, terms note, and evidence types. It implements availability, requirements, draft preparation, validation, optional supported-field filling, session continuation, submission, verification, tracking, and recovery.

All adapter calls receive a server-created task context and minimum scoped data. Adapters never receive an unrestricted user profile, raw chat history, or model instructions. Secrets use a separate ephemeral method and cannot appear in return values.

## Implemented strategies

- `local_verified`: submits the bundled safe test service to a local deterministic adapter and returns an evidence-backed test receipt clearly labeled non-government.
- `guided_browser`: prepares a draft and opens the verified official HTTPS portal for user completion; completion remains user-reported or externally verified.
- `official_api`: strict interface for an authenticated provider API. A service cannot select it until credentials, endpoint allowlist, and response verifier are configured.
- `human_handoff`: creates an approved, revocable package containing only user-selected non-secret fields/documents. Authentication and final submission remain with the user.

## Adding an adapter

Add a registry entry, domain verification evidence, contract implementation, typed errors, timeout/retry limits, idempotency behavior, evidence verifier, tracking behavior, availability health check, and tests for redirects, secrets, duplicate submission, timeouts, expiry, and recovery. Never enable automation where portal terms or technical controls prohibit it.
