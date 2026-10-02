# Source map

`gcp-cloud` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Google Cloud's framework and service guidance are rolling sources, so provider behavior that can drift must be rechecked against the target service and region.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google Cloud Well-Architected Framework**: https://docs.cloud.google.com/docs/get-started/well-architected-framework
  - Scope: continuously updated framework; page last updated 2026-08-26.
  - Use: current architecture baseline across operational excellence, security, reliability, cost, performance, and sustainability.
  - Verified: 2026-09-05; refresh after 30 days.
- **Resource Manager documentation**: https://docs.cloud.google.com/resource-manager/docs
  - Scope: organization/folder/project guidance; page last updated 2026-08-26.
  - Use: resource hierarchy and ownership boundaries.
  - Verified: 2026-09-05; refresh after 45 days.
- **Service account security best practices**: https://docs.cloud.google.com/iam/docs/best-practices-service-accounts
  - Scope: rolling IAM guidance as available 2026-09-05.
  - Use: short-lived identity, service-account key avoidance, impersonation/attachment and privilege boundaries.
  - Verified: 2026-09-05; refresh after 21 days.
- **Aggregate and store organization logs**: https://docs.cloud.google.com/logging/docs/central-log-storage
  - Scope: rolling Cloud Logging aggregation guidance as available 2026-09-05.
  - Use: organization aggregated sinks and protected central audit/log storage.
  - Verified: 2026-09-05; refresh after 30 days.

## Interpretation rules

- Resolve organization/folder/project, service, region and quota before applying provider-specific advice.
- Prefer short-lived workforce/workload identity and avoid service-account keys when a supported alternative exists.
- Treat configured HA, replication or backup as design state, not proof of recovery; preserve restore/failover evidence.
- Keep security assessment, Terraform mechanics, serverless handler semantics and FinOps analysis in their owning skills while composing when the task genuinely spans them.
