# Source map

`azure-cloud` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Azure service behavior is often region/SKU dependent, so rolling Microsoft Learn guidance must be rechecked when the task depends on availability-zone support, limits, identity behavior, or monitoring defaults.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Azure Well-Architected Framework: What's new**: https://learn.microsoft.com/en-us/azure/well-architected/whats-new
  - Scope: rolling framework change log through June 2026 as available 2026-09-05.
  - Use: current architecture/reliability/operations guidance and recently introduced design guidance.
  - Verified: 2026-09-05; refresh after 30 days.
- **Azure management groups**: https://learn.microsoft.com/en-us/azure/governance/management-groups/overview
  - Scope: management-group/subscription hierarchy guidance checked 2026-09-05.
  - Use: inherited Policy/RBAC and enterprise governance scope.
  - Verified: 2026-09-05; refresh after 90 days.
- **Managed identity best-practice recommendations**: https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations
  - Scope: page last updated 2025-03-14; checked 2026-09-05.
  - Use: identity lifecycle, least privilege and identity-assignment blast-radius guidance.
  - Verified: 2026-09-05; refresh after 90 days.
- **Azure availability zones**: https://learn.microsoft.com/en-us/azure/reliability/availability-zones-overview
  - Scope: current Azure zone-resilience guidance as available 2026-09-05.
  - Use: zonal versus zone-redundant behavior and exact service/SKU support requirement.
  - Verified: 2026-09-05; refresh after 45 days.
- **Azure Monitor diagnostic settings**: https://learn.microsoft.com/en-us/azure/azure-monitor/platform/diagnostic-settings
  - Scope: current diagnostic-settings guidance as available 2026-09-05.
  - Use: routing resource logs, Activity Log and metrics to deliberate durable destinations; resource logs require collection configuration.
  - Verified: 2026-09-05; refresh after 30 days.

## Interpretation rules

- Resolve tenant, management-group/subscription/resource-group, exact service, region and SKU before applying provider-specific advice.
- Prefer managed identities/short-lived credentials where supported; verify both downstream RBAC and who may assign the identity to executable resources.
- Treat configured zone redundancy, replication and backup as design state, not proof of recovery; preserve restore/failover evidence.
- Verify diagnostic settings and received telemetry instead of assuming resource logs are retained automatically.
