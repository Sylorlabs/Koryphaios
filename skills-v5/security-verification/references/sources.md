# Source map

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader verification, security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OWASP Application Security Verification Standard 5.0.0**: https://owasp.org/www-project-application-security-verification-standard/
  - Use: current stable application-security verification requirements and control taxonomy, including access-control verification.
  - Version scope: ASVS 5.0.0, listed by OWASP as the latest stable release on 2026-09-05.
  - Verified: 2026-11-07; refresh after 90 days.

- **OWASP Web Security Testing Guide 4.2: Authorization Testing**: https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema
  - Use: horizontal/vertical authorization matrices, same-role cross-user checks, and server-side access-control testing methodology.
  - Version scope: WSTG 4.2 stable material available 2026-09-05; latest branch may contain newer draft guidance.
  - Verified: 2026-11-07; refresh after 90 days.

- **OWASP WSTG 4.2: Insecure Direct Object References**: https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/05-Authorization_Testing/04-Testing_for_Insecure_Direct_Object_References
  - Use: object-reference authorization tests that change resource identifiers while preserving the test identity.
  - Version scope: WSTG 4.2 stable material available 2026-09-05.
  - Verified: 2026-11-07; refresh after 90 days.

- **NIST SP 800-218 SSDF 1.1**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Use: secure-development verification and recurrence-prevention context; it is not a substitute for product-specific control evidence.
  - Version scope: NIST SP 800-218 version 1.1 final.
  - Verified: 2026-11-07; refresh after 365 days.

- **IETF RFC 9700 / BCP 240: Best Current Practice for OAuth 2.0 Security**: https://datatracker.ietf.org/doc/rfc9700/
  - Use: current OAuth 2.0 security requirements when an authorization-boundary test depends on OAuth token/code/redirect behavior.
  - Version scope: RFC 9700, January 2025.
  - Verified: 2026-11-07; refresh after 180 days.

## Interpretation rules

- Security verification is permissioned, target-specific evidence. Use owned, synthetic, or explicitly authorized environments.
- Test both allowed and denied paths at the enforcing boundary; a denial response is insufficient if protected state still changes or data leaks.
- Distinguish authentication, authorization, isolation, and audit/secret-handling claims instead of collapsing them into a generic security pass.
- Prefer the target protocol/platform specification over generic OWASP guidance when a version specific contract changes the expected behavior.
