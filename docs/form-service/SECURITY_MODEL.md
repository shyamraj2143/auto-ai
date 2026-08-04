# Form Service Security Model

## Trust boundaries

Authentication tokens identify the user; database ownership checks authorize resources. Registry data is administrative trust data. AI output, web content, uploaded files, filenames, OCR text, redirects, and adapter messages are untrusted.

## Mandatory controls

- Only verified HTTPS portal origins are accepted; IP literals, credentials in URLs, URL shorteners, non-default ports, cross-domain redirects, and private/link-local destinations are blocked.
- External actions require the shared policy gateway. Legal, government, identity, education, employment, medical, and financial submissions always require an unexpired explicit confirmation.
- Passwords, OTPs, recovery codes, payment PINs, CVVs, biometrics, and authentication tokens are excluded from task fields, chat history, model context, analytics, audit details, receipts, and server logs.
- Ephemeral authentication values are accepted only by the active adapter call, retained in function-local memory, and discarded after the response. OTPs are never persisted, including as hashes.
- Sensitive reusable profile values are encrypted at field level. Portal credentials remain in official OAuth/passkey sessions or Android Keystore-protected local storage.
- Uploads are user-owned, size-bounded, magic-byte checked, sanitized, hashed, de-duplicated, parser-bounded, and stored outside public directories. Script-bearing PDFs and mismatched types are rejected.
- Portal sessions expire, are task-bound, and expose the exact domain. Browser automation, where enabled for a permitted portal, runs isolated with a destination allowlist, bounded time/navigation/retries, no local-file access, and redacted output.
- Offline replay revalidates authentication, ownership, consent, portal, state, and draft. Secrets, payment, biometric, CAPTCHA, and high-risk submission are never replayed.

## Threat review

- **Stolen device/session:** short-lived authentication, device credential for high risk, revocable consent, session expiry.
- **Fake portal/SSRF:** normalized registry allowlist and DNS/IP policy; no arbitrary destination execution.
- **Cross-user/administrator/agent abuse:** ownership predicates on every resource; secret exclusion; explicit scoped handoff; immutable audit chain.
- **Prompt/web injection:** extracted content cannot alter policy, registry, consent, confirmation, or tool permissions.
- **Malicious files:** bounded reads, signature/MIME validation, decompression/page/dimension limits, safe filename/path generation, scanner status before parsing.
- **Replay/duplicate payment or submission:** unique idempotency and immutable attempt/receipt linkage.
- **XSS/CSRF/log leakage:** structured JSON, React escaping, existing bearer-token API model and strict CORS, redacted errors and audit payloads.
- **Insecure WebView/screenshots:** official origins shown; authentication uses Custom Tabs where possible; secure-input cards avoid history and can request native secure-screen confirmation.
