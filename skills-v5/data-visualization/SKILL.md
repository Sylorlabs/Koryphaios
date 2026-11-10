---
name: data-visualization
description: Design accurate visual representations matched to the analytical question, audience, and display medium. Use when the request specifically requires data visualization, design a chart, dashboard design, visualize results; prefer a narrower child only when its boundary is established.
---

# Data Visualization

Own the mapping from an analytical question to an accurate visual encoding. `data-analysis` owns the analysis, `visual-interface-design` the broader visual system, and `accessibility-practice` the accessibility facet.

## Operating contract

1. Establish the evidence boundary before choosing a chart: analytical task, reader, decision, medium, units, time window, denominator, missingness, and uncertainty. If a reader/audience/persona is not supplied, keep it explicitly `unspecified` / `not provided` in any serialized field instead of inferring a role.
2. Preserve the source contract. Compute rates, percentages, intervals, and other derived values from the supplied raw inputs, retain the relevant numerator/denominator or raw values, keep units/scales consistent, preserve unresolved labels, and verify every emitted row against the source.
3. Match the encoding to the task. Prefer position/length for precise comparison and tables for exact lookup. Keep incompatible units on distinct scales. For line/path charts, missing intervals stay visible gaps; do not reconnect them by filtering null rows or interpolation. An annotation such as a deployment marker is not causal evidence.
4. Put accessibility in the artifact itself. Use a redundant non-color distinction for series/categories and include an equivalent text alternative plus tabular rows exposing the plotted observations, gaps, annotations, and uncertainty. A surrounding prose summary does not replace these fields in a structured visualization specification.
5. Keep ownership bounded. Do not redefine telemetry, source data, metric semantics, pipelines, or product strategy unless the request actually asks for that adjacent work.
6. Before reporting success, re-read the serialized artifact and verify three things: derived values recompute from retained source inputs; reader/audience/persona fields remain evidence-backed; and the non-color plus text/table fallback is present. Exercise a representative failure/recovery condition when it can change interpretation. Any claimed executed check must be persisted and bound to the exact source/artifact; otherwise label it unobserved or unavailable.

Return the encoding rationale, source/transformation boundary, scale/uncertainty treatment, accessibility evidence, artifact-bound verification, and unresolved limitations.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
