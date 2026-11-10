# Source map

`application-security` owns trust and safety across sources and sinks for application data, files, processes, network requests, sessions, errors, and sensitive state. It composes with narrower authorization, authentication, browser, runtime, cloud, and verification skills rather than absorbing them.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader `security-review`; specialist ownership boundaries are listed in `SKILL.md`, and composition edges are defined by the sidecars.
- Routing corpus: five positive, seven near-neighbor negative, three compound/ambiguous, and three adversarial cases for the real resolver. Direct-selection checks distinguish task ownership from inherited guidance; compound cases require the named specialist as well.
- Full-task definitions: two individual scenarios with six falsifiable checks each, configured for same-model skill/no skill pairing and blind semantic judging. Definitions, registration, and local scorer tests do not establish successful paired execution or qualification. See [evaluation coverage and blockers](../evals/README.md).
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OWASP Application Security Verification Standard 5.0.0**: https://owasp.org/www-project-application-security-verification-standard/
  - Scope: ASVS 5.0.0, latest stable version as verified 2026-09-05.
  - Use: secure application requirements across validation/encoding, APIs, files/resources, authentication/session, data protection, communications, configuration, logging/error behavior, and other runtime controls.
  - Verified: 2026-11-07; refresh after 120 days.
- **OWASP Web Security Testing Guide 4.2**: https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing
  - Scope: versioned WSTG 4.2 testing taxonomy at the official redirected site. The old OWASP versioned URL redirects here. The unversioned `stable` entry now serves a redirect stub pointing to v4.2; pin the working versioned page rather than treating that stub as an unavailable target.
  - Use: test taxonomy for session, input validation, error, business logic, API, file, and related application security failure modes. Browser-origin mechanics belong to `web-security`.
  - Verified: 2026-11-07; refresh after 120 days.
- **NIST SP 800-218: Secure Software Development Framework 1.1**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Scope: SP 800-218 SSDF 1.1.
  - Use: risk-based secure design/implementation, protection against vulnerabilities, review/analysis, and remediation expectations across the software lifecycle.
  - Verified: 2026-11-07; refresh after 365 days.
- **OWASP Input Validation Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
  - Scope: current OWASP guidance available 2026-09-05.
  - Use: syntactic and semantic allowlist validation, structured parsers, file-upload considerations, and boundaries where validation must be paired with sink-specific defenses.
  - Verified: 2026-11-07; refresh after 120 days.
- **OWASP Server-Side Request Forgery Prevention Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
  - Scope: OWASP guidance inspected 2026-10-11.
  - Use: validated outbound destinations, DNS rebinding and parser disagreement, destination enforcement through the actual connection, redirects, and network controls.
  - Verified: 2026-11-07; refresh after 120 days.
- **OWASP Logging Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
  - Scope: maintained guidance inspected 2026-10-17, especially “Data to exclude”, “Event collection”, and “Verification”.
  - Use: exclude credentials/session identifiers, sanitize untrusted event data for the log format, bound resource consumption, and exercise logging failures.
  - Verified: 2026-11-07; refresh after 120 days.

## Interpretation rules

- Validate at the trust boundary, then still use the target sink's safe API. Generic validation is not a substitute for parameterized queries, structured process arguments, contextual output handling, or authorization.
- **OS Command Injection Defense Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
  - Verified: 2026-11-07; refresh after 120 days.
  - Adopted: parameter separation does not eliminate argument injection; inspect executable semantics and limit process authority.
  - Adapted: option/operand separation, including `--`, follows the selected tool's documented parser and the application's permitted effects.
  - Rejected: treating shell-free argv as universally safe, or importing an example character allowlist as the product's business schema. An authorized passthrough interface needs its own authority boundary.
- Canonicalize where canonical identity matters and enforce containment/policy on the canonical representation; be alert to later decoding or parser differentials.
- For outbound URLs, the security decision must survive each redirect and the actual connection. Recheck destination IPs and bind the connection to a vetted address while retaining TLS hostname validation, or demonstrate an equivalent egress enforcement boundary; separately control credential forwarding across origins. An initial URL/DNS check alone does not constrain a later unchecked connection. Use the product's real destination policy rather than rejecting valid public fixtures by inventing a narrower policy.
  - Adapted from the SSRF guidance: disable automatic redirects, then either reject redirects entirely or implement bounded explicit hops with the same policy at each connection. This package's synthetic import fixture requires public-network HTTPS destinations; documentation-only ranges are not public success controls. Full user URLs are part of that interface, so parse and constrain them rather than replacing the interface with an invented host-only contract.
- Treat stored data as untrusted when it is later reinterpreted by a more privileged sink.
- Resource limits are security invariants for parsers, archives, remote fetches, queues, subprocesses, and other attacker-amplifiable work.
- Model log/crash/diagnostic secrecy from the sensitive value's identity and data flow, not from one spelling of the surrounding key. Access and refresh credentials, bearer/API tokens, authorization/session material, and product-specific aliases stay secret if they are renamed, flattened, serialized, or embedded in free-form error text. Prefer structured allowlisted diagnostics that exclude those values at the source; when unstructured text is unavoidable, redact complete secret-bearing values/representations before storage or display, strip unsafe controls separately, and test more than one credential class or alias.
  - Adapted from Logging: derive aliases, complete credential syntaxes, and replacement ordering from the application's actual data model. OWASP does not prescribe a universal alias regex or guarantee arbitrary free-form secret detection; discard unsafe text when its secrecy cannot be established. Numeric provisional ceilings are proposed product policy, not OWASP/NIST-mandated values.
- Keep authentication, authorization, browser-origin security, untrusted-code sandboxing, and final security verification in their specialist packages when those are the primary claim.
