# Source map

Read API behavior against the repository's Angular version. The parent frontend discipline owns the interaction contract; these sources resolve Angular-specific ownership rather than prescribe a migration.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader frontend-engineering.
- Routing fixtures: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases for the real resolver. Fixture presence is not a recorded routing result.
- Full-task fixtures: two individual scenarios with six falsifiable checks each, specifying same-model skill/no skill pairing and blind semantic judging. These contracts do not establish that either execution or judging has run.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

The live documentation identified itself as Angular v22.2.3 when inspected on 2026-10-17. That is the documentation scope, not a mandate to upgrade or a claim about a task fixture's installed version. Recheck the installed release before adopting version-sensitive APIs.

- **Angular documentation**: https://angular.dev/overview
  - Use: documentation navigation; use the precise contracts below for lifetime and form decisions.
  - Verified: 2026-10-17; refresh after 45 days.
- **Hierarchical injectors**: https://angular.dev/guide/di/hierarchical-dependency-injection
  - Use: injector scope, resolution, and component-local service instances.
  - Verified: 2026-10-17; refresh after 45 days.
- **Reactive forms**: https://angular.dev/guide/forms/reactive-forms
  - Use: explicit form models, ngSubmit, validation feedback, observable state, and change detection notification for zoneless applications using reactive forms.
  - Verified: 2026-10-17; refresh after 45 days.
- **takeUntilDestroyed**: https://angular.dev/api/core/rxjs-interop/takeUntilDestroyed
  - Use: Observable completion at context destruction; pass a DestroyRef when calling outside an injection context. Stable since v19.0; destruction is not a route-id change on a reused component.
  - Verified: 2026-10-17; refresh after 45 days.
- **createComponent**: https://angular.dev/api/core/createComponent
  - Use: distinct `elementInjector` and `environmentInjector` options and explicit application-view attachment for independently created components.
  - Verified: 2026-10-17; refresh after 45 days.
- **Read route state**: https://angular.dev/guide/routing/read-route-state
  - Use: changing ActivatedRoute parameter streams versus static snapshots in reused components.
  - Verified: 2026-10-17; refresh after 45 days.
- **Making HTTP requests**: https://angular.dev/guide/http/making-requests
  - Use: cold request observables, duplicate requests per subscription, error handling, and client-side request abortion on unsubscribe. Cancellation does not establish server-side rollback.
  - Verified: 2026-10-17; refresh after 45 days.
- **Required validator implementation**: https://github.com/angular/angular/blob/29bfe100d5870cb29efe822d713345b2a8a9a671/packages/forms/src/validators.ts
  - Scope: immutable Angular main snapshot `29bfe100d5870cb29efe822d713345b2a8a9a671`, not a released-version claim.
  - Use: `requiredValidator` delegates to null/empty length checks without trimming; whitespace-only strings require a domain validator or explicit submit guard.
  - Verified: 2026-10-17; refresh after 45 days.

## Interpretation rules

- Adopted: make injector, form, and subscription ownership explicit so navigation and destruction do not retain unintended work or state.
- Adapted: apply teardown and form APIs supported by the installed release, keeping the current form and rendering architecture when it meets the contract.
- Rejected: mandating reactive forms, signals, or standalone migration for every Angular task, or treating template compilation as proof of route and lifecycle behavior.
