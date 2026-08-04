# Trust Hub Acceptance Matrix

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Deterministic policy precedence | `trust_hub_service.py` | `test_policy_engine_is_deterministic_and_deny_wins` | Pass |
| Unknown actions require confirmation | `trust_hub_service.py` | `test_unknown_action_defaults_to_confirmation_and_external_text_is_data` | Pass |
| Lease requires native permission and valid expiry | `trust_hub_service.py` | `test_lease_requires_os_permission_and_valid_expiry` | Pass |
| Real action gateway enforcement | Pending milestone B | Acceptance scenario 1–3 | Pending |
| Commitment lifecycle/capacity | Pending milestone B/C | Acceptance scenario 4 | Pending |
| Receipt evidence/recovery | Pending milestone B/C | Acceptance scenario 5–6 | Pending |
| Multi-stage scam correlation | Pending milestone D | Acceptance scenario 7 | Pending |
| Evidence-only learning | Pending milestone D | Acceptance scenario 8 | Pending |
| Encrypted offline revalidation | Pending milestone E | Acceptance scenario 9 | Pending |
| Encrypted handoff integrity | Pending milestone E | Acceptance scenario 10 | Pending |
| Tenant isolation | Pending integration suite | Acceptance scenario 11 | Pending |
| Emergency pause | Pending milestone B | Acceptance scenario 12 | Pending |
| Hierarchical multilingual intent | `services/intent_engine.py` | `test_hindi_intent_detection`, `test_hinglish_intent_detection` | Pass |
| Missing-requirement dynamic UI | `RequirementResolver`, `DynamicInteractionCard` | dynamic field/document tests + frontend build | Pass |
| Secure input isolation | secure challenge API | OTP/schema isolation tests | Pass |
| Declarative workflow safety | `WorkflowValidator` | schema, invented-tool, loop, confirmation tests | Pass |
| Persistent restart recovery | workflow state tables | `test_persistent_run_can_resume` | Pass |
| Tenant isolation | ownership filters | `test_cross_user_active_run_protection` | Pass |
| Prompt injection fail-closed | tool registry/policy | injection and unsupported-tool tests | Pass |
| Verified/unverified receipts | assistant gateway receipt hook | `test_result_verification_creates_verified_receipt`, `test_unverified_result_is_labeled_without_false_success` | Pass |
| Service submission gateway | `form_service_gateway.py`, `trust_gateway.py` | confirmation, emergency-pause, idempotency and adapter-invocation tests | Pass |
| Service portal/document/handoff gateway | form-service routes and services | origin, OCR-consent, least-data handoff and revoke tests | Pass |
