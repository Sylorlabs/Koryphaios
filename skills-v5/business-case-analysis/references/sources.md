# Source map

`business-case-analysis` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Sources bound methodological or version-sensitive guidance; behavioral qualification still requires paired same-model skill/no skill runs, deterministic checks, and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GAO Cost Estimating and Assessment Guide**: https://www.gao.gov/products/gao-20-195g
  - Scope: GAO-20-195G official overview and HTML highlights rechecked 2026-09-06; this recheck did not reread the full PDF report.
  - Use: Assumption, uncertainty, sensitivity, risk, traceability, and estimate-quality guidance.
  - Verified: 2026-09-06; refresh after 365 days.
- **HM Treasury: The Green Book (2026)**: https://www.gov.uk/government/publications/the-green-book-appraisal-and-evaluation-in-central-government/the-green-book-2026
  - Scope: 2026 Green Book, updated 2026-02-05.
  - Use: Objectives, option generation, shortlist appraisal, costs/benefits/risks, uncertainty, presentation, monitoring, and evaluation.
  - Verified: 2026-09-06; refresh after 90 days.
- **HM Treasury: Green Book and accompanying guidance**: https://www.gov.uk/government/collections/the-green-book-and-accompanying-guidance-and-documents
  - Scope: Green Book/business-case guidance collection as updated through 2026-06-30.
  - Use: Current business-case framework, templates, appraisal guidance, approvals context, and supplementary material.
  - Verified: 2026-09-05; refresh after 90 days.
- **Agent Skills specification**: https://agentskills.io/specification
  - Scope: Agent Skills specification as available 2026-09-05.
  - Use: Portable discovery metadata and progressive disclosure for this package.
  - Verified: 2026-11-03; refresh after 90 days.
- **OpenAI public skill-creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Scope: OpenAI skill-creator guidance on `main` as inspected 2026-11-03.
  - Use: Narrow activation, explicit boundaries, progressive disclosure, and behavior-based evaluation.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

Local evaluator addition, 2026-09-06: `backend/src/kory/skill-eval-business-case-fixtures.ts` supplies the two declared synthetic business-case packets. Five platform alternatives and four automation alternatives each have eight joint/single-driver cases (72 numerical comparisons). The scorer independently reconciles incremental cash flows, staff capacity, terminal costs, escalation, opportunity cost and bounded break-even adoption. It checks source IDs and unresolved funding/expansion conditions, not memo keywords. Alternative recommendations and paraphrased risks are accepted when the structured evidence remains consistent. The memo still needs an independent blind-semantic judge; deterministic self-tests do not establish skill uplift or real-world forecast accuracy.

The Green Book's sunk-cost, cash/noncash and sensitivity distinctions inform general appraisal discipline. Its UK public-sector social-appraisal perspective, mandated approval process and social discount rates are not universal corporate requirements. The fixture's three-year horizon, USD figures, 8% experiment rate, calculation appendix and numerical gates are synthetic task inputs, not additions to the reusable skill or investment recommendations.

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
