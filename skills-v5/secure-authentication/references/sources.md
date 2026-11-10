# Source map

`secure-authentication` owns authenticator assurance and lifecycle: enrollment, verification, throttling, recovery, replacement, reauthentication, and compromise/session response. Federation protocol details and resource authorization remain separate.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST SP 800-63B-4: Authentication and Authenticator Management**: https://csrc.nist.gov/pubs/sp/800/63/B/4/final
  - Scope: final July 2025; supersedes the prior SP 800-63B publication.
  - Use: authenticator assurance levels, password and verifier requirements, phishing resistance, authenticator lifecycle, recovery, reauthentication, and related controls.
  - Verified: 2026-11-07; refresh after 365 days.
- **OWASP ASVS 5.0.0: V6 Authentication**: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
  - Scope: ASVS 5.0.0, latest stable as verified 2026-09-05.
  - Use: application authentication documentation, anti-automation, password handling, MFA, recovery, and verification requirements.
  - Verified: 2026-11-07; refresh after 120 days.
- **Web Authentication Level 3**: https://www.w3.org/TR/webauthn-3/
  - Scope: W3C Recommendation, 25 August 2026.
  - Use: current WebAuthn L3 RP/origin/challenge/credential/signature/user-verification behavior and terminology as a W3C Recommendation.
  - Verified: 2026-11-07; refresh after 90 days.
- **NIST SP 800-63B-4 authenticator details**: https://pages.nist.gov/800-63-4/sp800-63b/authenticators/
  - Scope: current Rev. 4 detail site available 2026-11-07.
  - Use: phishing-resistance definition and authenticator-type details.
  - Verified: 2026-11-07; refresh after 365 days.

## Interpretation rules

- State the authenticator's actual assurance properties. Enrollment in a strong authenticator does not make every later fallback or recovery event equally strong.
- Recovery and factor replacement are authentication events and must be designed to the account's risk; they cannot be treated as support-only UX.
- WebAuthn Level 3 is a W3C Recommendation (25 August 2026). Gate behavior on platform/support evidence where implementations vary, and confirm the deployed user-agent/authenticator support for any specific L3 feature.
- Keep OAuth/OIDC protocol validation, resource authorization, browser-origin defenses, and final security verification in their specialist packages.
