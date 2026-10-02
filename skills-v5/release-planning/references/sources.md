# Source map

`release-planning` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources anchor canarying, reproducible release practice and compatibility signaling; actual release gates must be derived from the target service's current SLOs, telemetry, support and recovery capabilities.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader planning; narrower children cicd-engineering, mlops.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE Workbook: Canarying Releases**: https://sre.google/workbook/canarying-releases/
  - Scope: chapter as available 2026-09-05.
  - Use: partial/time-limited canary exposure, control comparison, progressive evaluation and limiting blast radius.
  - Verified: 2026-09-05; refresh after 180 days.
- **Google SRE: Release Engineering**: https://sre.google/sre-book/release-engineering/
  - Scope: chapter as available 2026-09-05.
  - Use: reproducible release units, automated testing/deployment, canary strategies and rollback-oriented delivery.
  - Verified: 2026-09-05; refresh after 180 days.
- **Semantic Versioning 2.0.0**: https://semver.org/spec/v2.0.0.html
  - Scope: SemVer 2.0.0.
  - Use: public-API compatibility/version contract; a major/minor/patch label is not itself a rollout or migration plan.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Bind every release decision to an exact immutable release unit and current target-environment evidence.
- Choose canary/cohort size and observation windows from blast-radius and signal-quality needs; a fixed percentage sequence is not universal.
- Treat missing or ambiguous telemetry as a hold/stop condition unless the plan explicitly justifies otherwise.
- If rollback is not actually safe because contracts or state have changed, compose `migration-planning` and use a tested roll-forward/recovery path instead of inventing a revert.
