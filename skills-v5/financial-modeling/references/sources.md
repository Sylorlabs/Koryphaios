# Source map

`financial-modeling` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Sources bound data provenance and model-quality guidance; behavioral qualification still requires paired same-model skill/no-skill runs, deterministic checks, and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SEC EDGAR filing guidance**: https://www.sec.gov/submit-filings/about-edgar
  - Scope: U.S. SEC EDGAR filing guidance as available 2026-09-05.
  - Use: Authoritative public-company filing provenance and financial source records.
  - Verified: 2026-09-05; refresh after 180 days.
- **SEC EDGAR Application Programming Interfaces**: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
  - Scope: SEC data.sec.gov submissions and XBRL API guidance as available 2026-09-05.
  - Use: Companyfacts/frames provenance, periods, units, taxonomy tags, and the distinction between filed facts and aggregate frames.
  - Verified: 2026-09-05; refresh after 90 days.
- **GAO Cost Estimating and Assessment Guide**: https://www.gao.gov/products/gao-20-195g
  - Scope: GAO-20-195G as available 2026-09-05.
  - Use: Ground rules/assumptions, data collection, estimating methods, sensitivity, risk/uncertainty, documentation, traceability, and updating estimates with actuals.
  - Verified: 2026-09-05; refresh after 365 days.
- **HM Treasury: The Green Book (2026)**: https://www.gov.uk/government/publications/the-green-book-appraisal-and-evaluation-in-central-government/the-green-book-2026
  - Scope: HM Treasury 2026 Green Book, updated 2026-02-05.
  - Use: Consistent appraisal horizon, option cash/economic timing, uncertainty and sensitivity principles when the model supports an investment appraisal.
  - Verified: 2026-09-05; refresh after 90 days.
- **Agent Skills specification**: https://agentskills.io/specification
  - Scope: Agent Skills specification as available 2026-09-05.
  - Use: Portable discovery metadata and progressive disclosure for this package.
  - Verified: 2026-09-05; refresh after 90 days.
- **OpenAI public skill-creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Scope: OpenAI skill-creator guidance on `main` as inspected 2026-09-05.
  - Use: Narrow activation, explicit boundaries, progressive disclosure, and behavioral evaluation.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
