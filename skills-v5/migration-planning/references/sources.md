# Source map

`migration-planning` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. The skill is intentionally domain-neutral: provider, database, language, and protocol skills remain authoritative for their own mechanics, while these sources anchor compatibility, progressive transition, deprecation, and rollback behavior.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Release Engineering**: https://sre.google/sre-book/release-engineering/
  - Scope: chapter as available 2026-09-05.
  - Use: repeatable releases, auditability, canarying, intentional change, and rollback-oriented release processes.
  - Verified: 2026-09-05; refresh after 180 days.
- **Google SRE: Reliable Product Launches at Scale**: https://sre.google/sre-book/reliable-product-launches/
  - Scope: progressive rollout and launch coordination guidance inspected 2026-09-06.
  - Use: progressive rollout, observation between stages, rollback on unexpected behavior, and automation that reduces migration toil.
  - Verified: 2026-09-06; refresh after 180 days.
- **Semantic Versioning 2.0.0**: https://semver.org/spec/v2.0.0.html
  - Scope: SemVer 2.0.0.
  - Use: distinguish compatible additions/fixes from incompatible public-API changes and communicate versioned compatibility boundaries.
  - Verified: 2026-09-05; refresh after 365 days.
- **RFC 8594: The Sunset HTTP Header Field**: https://datatracker.ietf.org/doc/html/rfc8594
  - Scope: RFC 8594, May 2019.
  - Use: HTTP service/API retirement signaling. `Sunset` indicates expected unavailability; it does not prove required clients have migrated.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Resolve the actual current and target versions before applying version-specific compatibility claims.
- Adopt observation gates and rollback planning from progressive launch guidance. Adapt expand/contract to migrations that require coexistence; reject treating every migration as a distributed rollout or ruling out an authorized offline/atomic cutover. Neither launch documentation nor a plan grants execution authority.
- A configured replication, backfill, adapter, or deprecation date is not proof of correctness. Require reconciliation, usage telemetry, or a recovery/cutover drill appropriate to the claim.
- Keep domain-specific commands in the owning skill and preserve unknown or irreversible steps explicitly.
