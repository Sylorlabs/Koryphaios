# Source map

## Lifetime interpretation

- **Dependency injection guidelines**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines
  - Opened 2026-09-06; refresh within 90 days. The .NET container owns disposal for instances it creates, while externally supplied instances retain a different ownership contract.
  - Adopt explicit creation, borrowing, lifetime, and disposal ownership. Adapt this distinction to the actual host's module lifecycle, including partially initialized and long-lived owners.
  - Reject imposing .NET, a dependency-injection container, singleton services, or a factory pattern on every backend. These mechanisms are conditional examples, not portable requirements.

Topology belongs to `backend-engineering`. Host execution, not this documentation, proves isolation between consumers, reentrancy, and cleanup. This content review does not establish paired or blind efficacy qualification.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: lifecycle background and reference discovery only; the landing page is not evidence for host-specific disposal or concurrency semantics.
  - Verified: 2026-09-04; refresh after 180 days.
