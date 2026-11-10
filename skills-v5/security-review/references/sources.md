# Source map

`security-review` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound version-sensitive review guidance; they do not replace repository/runtime evidence for a finding.

## Authoritative standards and practitioner guidance

- **OWASP ASVS 5.0.0**: https://owasp.org/www-project-application-security-verification-standard/
  - Version: 5.0.0, released 2025-05-30; latest stable verified 2026-09-05.
  - Use: control taxonomy and coverage for application-security review. A requirement match is not proof that the implementation is vulnerable.
- **OWASP WSTG 4.2**: https://owasp.org/www-project-web-security-testing-guide/v42/
  - Version: 4.2 is the current stable guide verified 2026-09-05; the OWASP project states 5.0 is still in development.
  - Use: entry-point and execution-path mapping plus stable test categories for authentication, authorization, input validation, error handling, business logic, and client-side risks.
- **NIST SP 800-218 SSDF 1.1**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Version: 1.1 final, February 2022.
  - Use: secure-development review, vulnerability identification, remediation, and root-cause/recurrence context. It is a development framework rather than a vulnerability taxonomy.
- **MITRE CWE 4.20**: https://cwe.mitre.org/data/archive.html
  - Version: 4.20, released 2026-04-30.
  - Use: map a validated root-cause weakness to the most appropriate supported CWE. Do not force a mapping or infer severity from the CWE identifier.
- **FIRST CVSS 4.0**: https://www.first.org/cvss/v4.0/specification-document
  - Version: CVSS 4.0; specification document revision 1.2 dated 2024-06-18.
  - Use: standardized technical severity when requested or useful. Publish the vector with the score; distinguish Base, Threat, and Environmental context and do not substitute CVSS for business risk.
- **OWASP Secure Code Review Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html
  - Version scope: maintained OWASP Cheat Sheet Series snapshot verified 2026-09-05.
  - Use: current practitioner workflow for baseline vs diff review, architecture/entry-point analysis, data-flow tracing from sources through processing to sinks, threat-based review, business-logic analysis, and human filtering of automated false positives.

## Review interpretation rules

- Start from the actual diff or reachable baseline and its trust boundaries; use standards to improve coverage, not to manufacture findings.
- A finding needs a plausible source/control-flow path, attacker prerequisites, a security-relevant sink or state transition, and concrete evidence that the intended guard is missing or bypassable.
- Search for downstream guards, framework guarantees, parameterization/encoding, canonicalization, caller constraints, feature/runtime configuration, and unreachable/test-only paths before reporting a candidate.
- Distinguish static-review confidence from executed proof. Runtime exploitability, allow/deny matrices, isolation, and fix regression belong to `security-verification` when execution is requested or required.
- Keep application hardening, authorization-policy design, threat model creation, and infrastructure/cloud posture work with their dedicated specialties when those are the primary deliverables.
- Refresh version-sensitive facts when a source exceeds its declared freshness window or the target depends on a newer framework/runtime/provider behavior.
