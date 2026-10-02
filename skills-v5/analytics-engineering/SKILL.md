---
name: analytics-engineering
description: Engineer analytical models with explicit grain, lineage, tests, governed metrics, and correct incremental/history semantics. Use when the task is analytics engineering, dbt modeling, semantic-layer work, or warehouse modeling.
---

# Analytics Engineering

## Responsibility

Define grain, freshness, keys, dimensions/history, metric semantics, and lineage before transforming data. Reuse canonical business definitions and keep incremental results equivalent to full rebuilds.

Treat the caller's deliverables as a hard contract. Complete requested implementation, regression tests, and evidence artifacts before optional analysis; do not substitute a strong explanation for a missing requested file or test.

## Transferable decisions

- State the grain and stable unique key. If no stable key exists, define deduplication and its failure cases before choosing incrementality.
- Define incremental change predicates, late-arrival/correction behavior, schema changes, and the full-rebuild path. If order is observable, preserve canonical ordering and stable tie-breakers so incremental output matches a clean rebuild.
- Own each business metric at one semantic boundary; repeated downstream formulas are drift risk.
- Define metric identity and population semantics at the business entity that persists across periods. Do not compute churn, retention, or cohort movement from row identifiers that are recreated each period.
- Treat freshness separately from correctness: fresh data may still violate uniqueness, relationships, ranges, or business invariants.
- Preserve history only when consumers need as-of or change semantics, with explicit effective-time rules.

## Observable checks

- Assert effective-key uniqueness/nullability plus material relationship and business invariants.
- Compare incremental output with a full recomputation over a representative period containing an updated key and late record; reconcile observable rows/order and critical aggregates.
- Reconcile a critical aggregate to an authoritative source at matching grain, filters, and time boundary.
- Check lineage and metric ownership after changes. For history models, test insert, update, unchanged, and out-of-order records.
- When the task asks for regression tests, add executable tests that exercise the corrected grain, history, metric, or incremental behavior. A useful regression must fail against the known broken behavior and pass against the repair; descriptive evidence alone is not a substitute.
- Execute representative migration recovery when the task asks for rollback or restatement. Distinguish checks actually run from checks only specified, and record source freshness assumptions explicitly.

## Failure boundaries

Do not bury business logic in dashboards, join unclear grains, duplicate metric definitions, treat not-null tests as sufficient proof, or hide anomalies with coercion whose meaning is undefined.

## Hierarchy and routing

- Broader skills: data-analysis.
- Required skills: verification, data-analysis.

Route here when the task is about transformation models, warehouse grain, incremental correctness, semantic metrics, lineage, or analytical data quality. Route ingestion scheduling and cross-system movement to `data-pipeline-engineering`, and route query-plan diagnosis to `database-performance`.

## Completion evidence

- Grain/keys, freshness assumptions, metric ownership, lineage, and material data-test results.
- Reconciliation to authoritative aggregates and incremental-versus-full evidence when relevant.
- Late-arrival, correction, or history evidence when those behaviors are in scope.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
