# Source map

`authorization-security` owns entitlement design and trusted enforcement placement. It is not a substitute for authentication, OAuth/OIDC protocol design, or independent verification of the finished control. Formal V5 promotion still requires paired same-model skill/no skill results and blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader application-security; narrower children oauth-oidc.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OWASP ASVS 5.0.0: V8 Authorization**: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md
  - Scope: ASVS 5.0.0, latest stable ASVS version as verified 2026-09-05.
  - Use: documented authorization rules, function/data/field restrictions, trusted-service-layer enforcement, immediate authorization changes or bounded mitigation, originating-subject decisions, and multi-tenant controls.
  - Verified: 2026-09-05; refresh after 120 days.
- **OWASP Authorization Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
  - Scope: current OWASP guidance available 2026-09-05.
  - Use: least privilege, deny by default, validation on every request, right enforcement location, ID tampering resistance, logging, and authorization tests.
  - Verified: 2026-11-07; refresh after 120 days.
- **OWASP Web Security Testing Guide: stable Authorization Testing**: https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/05-Authorization_Testing/
  - Scope: WSTG current stable site available 2026-09-05.
  - Use: horizontal/vertical authorization bypass, object-reference, directory traversal/file include, and privilege-escalation test patterns where applicable.
  - Verified: 2026-11-07; refresh after 120 days.
- **NIST SP 800-207: Zero Trust Architecture**: https://csrc.nist.gov/pubs/sp/800/207/final
  - Scope: NIST SP 800-207.
  - Use: resource-centric decisions and the principle that network location is not an implicit authorization grant.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Authentication identifies a subject; authorization decides whether that subject may act on a resource. Never treat successful login as resource permission.
- UI hiding and unguessable IDs are defense-in-depth/UX measures, not trusted enforcement.
- Apply policy to alternate paths: nested resolvers, bulk APIs, background jobs, indirect references, and service-to-service hops.
- Explicitly document revocation and distributed stale-policy windows. High-risk operations may require fresh policy state even when ordinary reads tolerate bounded staleness.
- Design negative cases and denied non-effects here; use `security-verification` to prove the implemented system actually satisfies them.
