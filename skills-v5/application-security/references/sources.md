# Source map

`application-security` owns cross-cutting trust and source-to-sink safety for application data, files, processes, network requests, sessions, errors, and sensitive state. It composes with narrower authorization, authentication, browser, runtime, cloud, and verification skills rather than absorbing them.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review; narrower children authorization-security, secure-authentication, web-security.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OWASP Application Security Verification Standard 5.0.0**: https://owasp.org/www-project-application-security-verification-standard/
  - Scope: ASVS 5.0.0, latest stable version as verified 2026-09-05.
  - Use: secure application requirements across validation/encoding, APIs, files/resources, authentication/session, data protection, communications, configuration, logging/error behavior, and other runtime controls.
  - Verified: 2026-09-05; refresh after 120 days.
- **OWASP Web Security Testing Guide: current stable**: https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/
  - Scope: current stable WSTG site available 2026-09-05.
  - Use: test taxonomy for session, input-validation, error, business-logic, API, file, and related application-security failure modes. Browser-origin mechanics belong to `web-security`.
  - Verified: 2026-09-05; refresh after 120 days.
- **NIST SP 800-218: Secure Software Development Framework 1.1**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Scope: SP 800-218 SSDF 1.1.
  - Use: risk-based secure design/implementation, protection against vulnerabilities, review/analysis, and remediation expectations across the software lifecycle.
  - Verified: 2026-09-05; refresh after 365 days.
- **OWASP Input Validation Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
  - Scope: current OWASP guidance available 2026-09-05.
  - Use: syntactic and semantic allowlist validation, structured parsers, file-upload considerations, and boundaries where validation must be paired with sink-specific defenses.
  - Verified: 2026-09-05; refresh after 120 days.

## Interpretation rules

- Validate at the trust boundary, then still use the target sink's safe API. Generic validation is not a substitute for parameterized queries, structured process arguments, contextual output handling, or authorization.
- **OS Command Injection Defense Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
  - Verified: 2026-09-06; refresh after 120 days.
  - Adopted: parameter separation does not eliminate argument injection; inspect executable semantics and limit process authority.
  - Adapted: option/operand separation, including `--`, follows the selected tool's documented parser and the application's permitted effects.
  - Rejected: treating shell-free argv as universally safe, or importing an example character allowlist as the product's business schema. An authorized passthrough interface needs its own authority boundary.
- Canonicalize where canonical identity matters and enforce containment/policy on the canonical representation; be alert to later decoding or parser differentials.
- Treat stored data as untrusted when it is later reinterpreted by a more privileged sink.
- Resource limits are security invariants for parsers, archives, remote fetches, queues, subprocesses, and other attacker-amplifiable work.
- Model log/crash/diagnostic secrecy from the sensitive value's identity and data flow, not from one spelling of the surrounding key. Access and refresh credentials, bearer/API tokens, authorization/session material, and product-specific aliases stay secret if they are renamed, flattened, serialized, or embedded in free-form error text. Prefer structured allowlisted diagnostics that exclude those values at the source; when unstructured text is unavoidable, redact complete secret-bearing values/representations before storage or display, strip unsafe controls separately, and test more than one credential class or alias.
- Keep authentication, authorization, browser-origin security, untrusted-code sandboxing, and final security verification in their specialist packages when those are the primary claim.
