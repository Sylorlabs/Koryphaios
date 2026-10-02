# Source map

`web-security` owns browser-origin, execution, credential, framing, and cross-window defenses. Formal V5 promotion still requires paired same-model skill/no-skill observations plus independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **W3C Content Security Policy Level 3**: https://www.w3.org/TR/CSP3/
  - Scope: Working Draft dated 13 August 2026.
  - Use: current CSP3 policy semantics. Preserve its Working Draft status; the stable W3C Recommendation remains CSP Level 2 for finalized Recommendation status.
  - Verified: 2026-09-05; refresh after 60 days.
- **OWASP Cross Site Scripting Prevention Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
  - Scope: current guidance available 2026-09-05.
  - Use: framework escape-hatch risks, safe sinks, contextual encoding, sanitization, and the warning against relying on CSP alone.
  - Verified: 2026-09-05; refresh after 120 days.
- **OWASP CSRF Prevention Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
  - Scope: current guidance available 2026-09-05.
  - Use: token/header patterns, SameSite, Origin/Fetch Metadata, and client-side CSRF caveats.
  - Verified: 2026-09-05; refresh after 120 days.
- **OWASP ASVS 5.0.0**: https://github.com/OWASP/ASVS/tree/master/5.0/en
  - Scope: ASVS 5.0.0.
  - Use: stable verification requirements for encoding/sanitization, session handling, browser/client, API, and communication controls.
  - Verified: 2026-09-05; refresh after 120 days.

## Interpretation rules

- Fix dangerous sinks first; CSP is defense in depth and containment, not a substitute for context-safe rendering.
- CSRF applies when ambient browser credentials can authorize state changes. SameSite reduces some risk but does not replace a deliberate anti-CSRF design for vulnerable flows.
- CORS controls whether a browser shares a response with another origin; it is not authentication or resource authorization.
- `postMessage` trust requires exact origin and message-schema validation. Avoid wildcard target origins for sensitive data.
- Keep federation protocol, local authenticator lifecycle, and backend resource permissions in their specialist packages.
