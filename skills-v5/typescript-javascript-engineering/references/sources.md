# Source map

`typescript-javascript-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **TypeScript Handbook:** https://www.typescriptlang.org/docs/handbook/intro.html
  - Scope: TypeScript documentation as fetched 2026-09-06.
  - Use: Primary language and type-system reference.
  - Verified: 2026-09-06; refresh after 60 days.
- **Narrowing:** https://www.typescriptlang.org/docs/handbook/2/narrowing
  - Scope: Page last updated 2026-08-31.
  - Use: Control-flow narrowing, discriminated unions, `never`, and exhaustive checks.
  - Verified: 2026-09-06; refresh after 60 days.
- **Modules reference:** https://www.typescriptlang.org/docs/handbook/modules/reference
  - Scope: Current module reference as fetched 2026-09-06.
  - Use: `module`, `moduleResolution`, package `exports`, conditional resolution, and emitted/runtime module boundaries.
  - Verified: 2026-09-06; refresh after 60 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, authored 2026-09-04T08:43:27Z; repository `package.json` reports `mattpocock-skills` 1.2.3.
  - Use: Community reference for concise model-invoked engineering disciplines and explicit routing layers. Never authority over TypeScript semantics.
  - Verified: 2026-09-06; refresh after 30 days.

## Research notes

- Adopted: Matt Pocock's current skills repository keeps reusable engineering disciplines composable and distinguishes them from the router that chooses a flow. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: this skill routes on language semantics, module resolution, emitted declarations, or runtime behavior rather than on file extension alone. Framework skills remain responsible for framework semantics.
- Rejected: no fixed TDD, ticket, review, or issue-tracker flow is embedded here. Those are orchestration choices, not TypeScript or JavaScript language rules.
- Primary-source concepts adopted: narrow runtime values instead of asserting them; use discriminated unions for real mutually exclusive states; evaluate package `exports` and `moduleResolution` together with the runtime loader; treat typecheck as static evidence, not runtime validation.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
