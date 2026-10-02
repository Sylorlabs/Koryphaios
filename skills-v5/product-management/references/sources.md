# Source map

`product-management` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound factual or version-sensitive guidance; behavioral qualification still depends on paired same-model skill/no-skill runs, deterministic checks, and independent blind evaluation rather than source citations alone.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GOV.UK Service Manual**: https://www.gov.uk/service-manual
  - Scope: GOV.UK Service Manual guidance as available 2026-09-05.
  - Use: User-centered service/product discovery, iteration, multidisciplinary evidence, and operating decisions.
  - Verified: 2026-09-05; refresh after 90 days.
- **GOV.UK Service Standard**: https://www.gov.uk/service-manual/service-standard
  - Scope: GOV.UK Service Standard as available 2026-09-05.
  - Use: Outcome-oriented quality boundary covering user needs, joined-up journeys, accessibility, privacy/security, measurement, iteration, reliability, and responsible operation.
  - Verified: 2026-09-05; refresh after 90 days.
- **GOV.UK: Measuring the success of your service**: https://www.gov.uk/service-manual/measuring-success/measuring-the-success-of-your-service
  - Scope: GOV.UK service-success measurement guidance as available 2026-09-05.
  - Use: Define success measures, baselines, targets, and evidence before treating delivery as success.
  - Verified: 2026-09-05; refresh after 90 days.
- **GOV.UK: Using performance data to improve your service**: https://www.gov.uk/service-manual/measuring-success/using-data-to-improve-your-service-an-introduction
  - Scope: GOV.UK performance-data guidance as available 2026-09-05.
  - Use: Continuous learning loops, segmentation, triangulation, and product/service improvement from observed performance.
  - Verified: 2026-09-05; refresh after 90 days.
- **U.S. Digital Services Playbook**: https://playbook.usds.gov/
  - Scope: U.S. Digital Services Playbook as available 2026-09-05.
  - Use: User needs, iterative delivery, analytics, security/privacy, automated testing/deployment, and operating-service guidance.
  - Verified: 2026-09-05; refresh after 180 days.
- **Agent Skills specification**: https://agentskills.io/specification
  - Scope: Agent Skills specification as available 2026-09-05.
  - Use: Portable skill metadata and progressive disclosure constraints for this package itself.
  - Verified: 2026-09-05; refresh after 90 days.
- **OpenAI public skill-creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Scope: OpenAI skill-creator guidance on `main` as inspected 2026-09-05.
  - Use: Narrow activation, explicit boundaries, progressive disclosure, and behavior-based evaluation of specialist skills.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
