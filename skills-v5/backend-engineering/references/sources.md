# Source map

## Applied curation, 2026-09-06

[Handling Overload](https://sre.google/sre-book/handling-overload/) was inspected for resource limits and retry ownership. Adopt bounded work and explicit degradation. Do not require Google's topology, quota ratios, CPU heuristic, or retry count. Shared authority and general verification prose was removed; the parent retains state, topology and consumer boundary decisions. No runtime or skill qualification is implied.

`backend-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: root responsibility; narrower children bun-deno-runtime, compiler-runtime-backend, distributed-backend, in-process-backend, linux-systems, local-service-backend, mongodb-engineering, network-service-backend, nodejs-runtime, redis-engineering, relational-data-modeling, search-indexing, vector-search-systems.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional-practice baseline.
  - Verified: 2026-09-04; refresh after 180 days.
- **Google SRE book**: https://sre.google/sre-book/table-of-contents/
  - Scope: Google Site Reliability Engineering book as available 2026-09-04
  - Use: Reliability, monitoring, incident response, capacity, release, and distributed-systems operating practices.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
