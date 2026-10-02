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

### Evidence required before completion

- Data-quality and provenance report.
- Reproducible calculations.
- Sensitivity and uncertainty results.
- Decision-focused output with limitations.

### Anti-misinterpretation boundaries

- Protect identifying and small-group data.
- Do not fabricate absent records or measurements.
- Do not overstate statistical significance as practical importance.
- Do not use a chart when a sentence or small table is clearer.

## Completion evidence

- Reproducible calculations

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
