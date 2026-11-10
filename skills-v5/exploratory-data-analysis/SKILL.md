---
name: exploratory-data-analysis
description: Understand unfamiliar data through structure, quality, distributions, relationships, and anomalies. Use when the request specifically requires exploratory analysis, explore dataset, find patterns, data profiling; prefer a narrower child only when its boundary is established.
---

# Exploratory Data Analysis

## Responsibility

Identify provenance, observation unit, schema, units, missingness, censoring, duplication, selection, time coverage, and transformations. Examine distributions, subgroups, relationships, anomalies, and cleaning sensitivity while labeling discoveries as hypotheses. Use the native medium; do not assume SQL, Python, or tables.

## Hierarchy and routing

- Broader skills: data-analysis.
- No narrower bundled child is declared.

## Exploratory data analysis

## Goal

Learn what the data can support before making explanatory or causal claims. Identify provenance, collection purpose, observation unit, population coverage, schema, units, time zone and interval, identifiers, transformations, missingness, censoring, duplication, sampling, and known instrumentation changes. Preserve the raw boundary and make each transformation reproducible in the medium actually available.

## Method

Profile completeness, cardinality, ranges, distributions, outliers, time coverage, subgroup balance, relationships, and contradictions. Inspect records as well as summaries; a smooth aggregate can hide unit errors, merged populations, retries, or impossible values. Compare alternative reasonable cleaning and aggregation choices, and mark discoveries as hypotheses rather than results. Ask what process generated each field and whether absence, zero, and unknown are distinct. Explore meaningful slices supplied by the domain, but avoid repeated fishing that turns visual surprise into a confident finding.

Before computing a headline summary, write down the observation unit and denominator as observed facts or explicitly unresolved questions. Keep record-, entity-, exposure-, and time-window denominators separate; do not infer row semantics from field names, labels, or an attractive aggregate. Classify each statement as observed, computed from supplied rows, hypothesis, or unavailable. If only a sealed packet, metadata, or a description is available, provide the reproducible profiling plan and preserve numeric findings as unavailable rather than filling them from the description.

## Evidence and failure modes

Publish a data-quality profile, transformation log, representative examples, exploration outputs, and open questions. State which dimensions cannot be assessed. Do not assume tabular data, SQL, a notebook, or a particular language. Common failures are silently dropping missing values, treating event rows as people, mixing clock domains, double-counting retries, comparing raw counts with unequal exposure, overfitting a story to an outlier, and presenting exploratory correlations as confirmed effects.

## Completion evidence

- Quality profile
- Reproducible transformations
- Exploratory findings
- Hierarchy boundary and selected specialist rationale
- Representative success, negative-path, and recovery verification
- For recovery, distinguish an executed rerun after a failed cleaning/aggregation choice from a proposed procedure; label procedural evidence as unexecuted.
- Preserve contradictory or missing evidence explicitly.
- Verify the highest-value invalid, partial, compatibility, interruption, or recovery path for the actual environment.
- Do not claim success from compilation, a screenshot, a happy-path example, or source documentation alone when runtime or operational evidence is required.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
