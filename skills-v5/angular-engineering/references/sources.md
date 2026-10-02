# Source map

Read API behavior against the repository's Angular version. The parent frontend discipline owns the interaction contract; these sources resolve Angular-specific ownership rather than prescribe a migration.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader frontend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Angular documentation**: https://angular.dev/overview
  - Scope: Angular documentation as available 2026-09-04
  - Use: documentation navigation; use the precise contracts below for lifetime and form decisions.
  - Verified: 2026-09-04; refresh after 45 days.
- **Hierarchical injectors**: https://angular.dev/guide/di/hierarchical-dependency-injection
  - Use: injector scope, resolution, and component-local service instances.
  - Verified: 2026-09-06; refresh after 45 days.
- **Reactive forms**: https://angular.dev/guide/forms/reactive-forms
  - Use: explicit form models, validation, and observable state in applications using reactive forms.
  - Verified: 2026-09-06; refresh after 45 days.
- **takeUntilDestroyed**: https://angular.dev/api/core/rxjs-interop/takeUntilDestroyed
  - Use: Observable completion at context destruction; pass a DestroyRef when calling outside an injection context.
  - Verified: 2026-09-06; refresh after 45 days.

## Interpretation rules

- Adopted: make injector, form, and subscription ownership explicit so navigation and destruction do not retain unintended work or state.
- Adapted: apply teardown and form APIs supported by the installed release, keeping the current form and rendering architecture when it meets the contract.
- Rejected: mandating reactive forms, signals, or standalone migration for every Angular task, or treating template compilation as proof of route and lifecycle behavior.
