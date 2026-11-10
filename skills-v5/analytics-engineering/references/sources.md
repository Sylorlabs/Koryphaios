# Source map

This map records the primary sources behind the decisions in this skill. dbt pages are implementation evidence for dbt projects, while grain, ownership, reconciliation, and history decisions remain transferable concepts that must be verified in the target warehouse.

## Adopted principles

- Incremental models need an explicit row-selection rule and, when updates are possible, a key that represents model grain. dbt documents both the incremental filter and `unique_key` behavior on its incremental-model page.
- Data tests should encode falsifiable assertions such as uniqueness, non-null, accepted values, relationships, and business-specific failing-record queries.
- Incremental correctness needs comparison with a full recomputation because provider settings such as `on_schema_change` do not backfill historical values automatically.
- Historical snapshots are useful when change history or point-in-time state is required. They are not a default substitute for a current-state model.

## Conditional or non-adopted recipes

- dbt materializations, `is_incremental()`, `unique_key`, snapshots, and built-in data tests are conditional implementation recipes for dbt projects. Do not require dbt when the repository uses another transformation framework.
- A fixed medallion, staging, mart, or semantic-layer directory layout is not mandated. Preserve repository ownership boundaries when they express the same concepts clearly.
- Full refresh is a verification and recovery option, not a universal production scheduling policy.

## Verification scope

Verify model grain, invariant tests, critical metric reconciliation, incremental versus full-recompute equivalence for representative changed data, late-arrival behavior, and history semantics. Warehouse-specific performance and transaction claims remain outside this source map unless separately evidenced for the target engine.

## Primary sources

- dbt documentation root: https://docs.getdbt.com/docs/introduction
  - Current navigation source rechecked 2026-10-19.
- Configure incremental models: https://docs.getdbt.com/docs/build/incremental-models
  - Adopted for incremental filters, `unique_key`, schema-change behavior, and full refresh.
  - Verified 2026-09-06. Page reports last update 2026-09-03.
- Add data tests to your DAG: https://docs.getdbt.com/docs/build/data-tests
  - Adopted for assertions and failing-record semantics.
  - Verified 2026-09-06.
- Add snapshots to your DAG: https://docs.getdbt.com/docs/build/snapshots
  - Adopted only for dbt snapshot behavior when historical state is required.
  - Verified 2026-09-06.
