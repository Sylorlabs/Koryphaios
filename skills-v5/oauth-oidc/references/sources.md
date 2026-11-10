# Source map

`oauth-oidc` owns delegated authorization and OIDC federation protocol correctness. Local authenticators and application resource entitlements remain separate concerns.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader authorization-security.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **RFC 7662: OAuth 2.0 Token Introspection**: https://www.rfc-editor.org/rfc/rfc7662.html
  - Scope: October 2015 specification, sections 1 and 2 inspected 2026-09-06.
  - Adopt: an authorized resource server can obtain active state and authorization metadata independently of token encoding.
  - Adapt: opaque tokens use authenticated introspection or an established provider validation contract; JWT validation applies when the artifact is a JWT. Reject mandatory JWT conversion and trusting a decoded token or untrusted introspection endpoint.
  - Verified: 2026-11-07; refresh after 365 days.

- **RFC 9700 / BCP 240: Best Current Practice for OAuth 2.0 Security**: https://www.rfc-editor.org/rfc/rfc9700.html
  - Scope: January 2025 BCP; updates OAuth-related RFCs with current security guidance.
  - Use: exact redirect matching, PKCE, CSRF and mix-up defenses, implicit-grant deprecation guidance, token leakage, sender constraint, refresh rotation, and audience restriction.
  - Verified: 2026-11-07; refresh after 365 days.
- **OpenID Connect Core 1.0 incorporating Errata Set 2**: https://openid.net/specs/openid-connect-core-1_0-errata2.html
  - Scope: approved OIDC Core Errata Set 2; the OpenID Foundation continues to list this as the approved Core errata version.
  - Use: RP/OP semantics, ID token and nonce validation, issuer/audience/claims, and security/privacy considerations.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 7636: Proof Key for Code Exchange**: https://www.rfc-editor.org/rfc/rfc7636.html
  - Scope: September 2015 standards-track PKCE specification.
  - Use: verifier/challenge construction and code-interception binding. Apply RFC 9700's stronger modern requirements on top.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 9449: OAuth 2.0 DPoP**: https://www.rfc-editor.org/rfc/rfc9449.html
  - Scope: September 2023 standards-track specification.
  - Use: sender-constraining access/refresh tokens, DPoP proof JWT structure, proof/token binding, and replay protections.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Treat RFC 9700 as the primary modern OAuth security baseline; older OAuth examples may be syntactically valid but no longer recommended.
- OIDC ID tokens authenticate/describe the login session for the RP; access tokens authorize API access for resource servers. Do not substitute one for the other.
- Exact redirect matching, issuer binding, PKCE, state/nonce, audience, and token lifecycle are separate checks with separate failure modes.
- Scopes/claims do not replace application tenant/object/field authorization.
- Key generation/storage/rotation belongs to `secrets-key-management`; this skill defines how OAuth/OIDC consumes and validates those keys/artifacts.
