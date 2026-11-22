---
name: data-analysis
description: Analyze structured data with explicit assumptions and reproducible calculations. Use when the request specifically requires data analysis, analyze this dataset.
---

# Data Analysis

## Responsibility

Inspect the data shape and actual analysis medium first. State assumptions, preserve units, validate calculations, and use tables or charts only when they clarify relationships.

## Hierarchy and routing

- This is a graph root for its responsibility.
- Narrower children: analytics-engineering, data-pipeline-engineering, data-visualization, experimental-analysis, exploratory-data-analysis, financial-modeling, ml-evaluation, operational-data-analysis, product-analytics, statistical-inference.

## Professional practice

### Operating contract

Turn data into a reproducible, bounded conclusion without exceeding its provenance.

### Execution sequence

1. Define decision, population, unit, window, measures, and success criteria.
2. Audit provenance, schema, units, missingness, duplicates, censoring, and selection.
3. Create reproducible cleaning and derivation steps while preserving source data.
4. Choose descriptive, inferential, predictive, or causal methods to match the claim.
5. Stress assumptions, validate surprising results, and communicate uncertainty.

### Decisions that must be explicit

- Which records and transformations are in scope.
- Whether aggregation changes the unit of analysis.
- Which assumptions materially affect the answer.
- Which table or visualization improves the decision rather than decorates it.

### Failure and recovery discipline

- Denominators or units disappear.
- Missing data is silently treated as zero.
- Correlation becomes causation.
- A convenient sample becomes a population claim.
- A zero count is still evidence: when a requested quality dimension such as missingness, duplicates, exclusions, or reconciliation has no findings, report the observed zero/none result instead of omitting the check.
- When the task asks for failure or recovery evidence, execute a representative invalid-input or failed-reconciliation path and its recovery when the environment permits it. Otherwise label that verification unavailable; do not turn a successful happy path into recovery evidence.

### Evidence required before completion

- An explicit analysis invariant: decision, population, unit, window, measures, and success criteria.
- Data-quality and provenance report covering the requested dimensions, including observed zero/none results and source limitations.
- Reproducible calculations.
- Sensitivity and uncertainty results.
- Representative success plus negative/recovery verification, or an explicit unavailable label for checks the environment cannot execute.
- Decision-focused output with limitations.

### Anti-misinterpretation boundaries

- Protect identifying and small-group data.
- Do not fabricate absent records or measurements.
- Do not overstate statistical significance as practical importance.
- Do not use a chart when a sentence or small table is clearer.

## State the missingness, concentration and sensitivity result

A segment comparison is not a finding until the reader can see whether the segments were comparable in the first place. The analysis artifact must record how much data is missing per cohort and how missingness was handled, the concentration of the difference (which account or segment dominates, and the share it holds), and a sensitivity figure computed with the dominant contributor removed, reported as each cohort's rate and the difference in percentage points. End with two explicit booleans: whether the conclusion survives that removal, and whether the difference can be called causal.

Write that result as the structured object the task declares, at the path it declares, with the keys it names. Where the contract asks for a naive comparison, an account concentration with the dominant contributor and its share, a sensitivity block with each cohort's rate and the difference in percentage points, and a conclusion with `robust` and `causal` booleans, supply all four blocks: a prose summary in `analysis.json` with the right numbers in the wrong shape scores the same as a wrong answer, and a partially filled object is read as a failed contract. A rate quoted without the concentration and without the removal test is the exact claim a dominated cohort produces, and it is not supportable.

## Completion evidence

- Reproducible calculations plus the analysis invariant and data-quality/provenance record.
- Observed negative/recovery evidence when required, with unavailable or simulated checks labeled as such.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
