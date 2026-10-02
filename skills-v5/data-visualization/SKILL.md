---
name: data-visualization
description: Design accurate visual representations matched to the analytical question, audience, and display medium. Use when the request specifically requires data visualization, design a chart, dashboard design, visualize results; prefer a narrower child only when its boundary is established.
---

# Data Visualization

Own the mapping from an analytical question to an accurate visual encoding. `data-analysis` owns the analysis, `visual-interface-design` the broader visual system, and `accessibility-practice` the accessibility facet.

## Operating contract

1. State the reader, decision, medium, and analytical task: comparison/trend, distribution, relationship, composition, flow, geography, uncertainty, or exact lookup.
2. Preserve the data contract. Label population, time window, units, denominator, transformations, missingness, and uncertainty. Do not imply precision the source does not support.
3. Match encoding to the task. Prefer position/length for precise comparison; use tables for exact lookup. Maps require a spatial question. Interaction may reveal detail but must not hide the core truth.
4. Avoid misleading defaults: unexplained truncated axes, dual scales that manufacture correlation, unmarked smoothing, unequal bins/exposure, color-only categories, hover-only evidence, decorative charts, and dashboards without a reader task.
5. Verify representative reading tasks in the real display medium, including small-screen/nonvisual access where relevant. A screenshot alone does not prove readability, accessibility, or analytical correctness.

Return the question-to-encoding rationale, source/transformation boundary, scale/uncertainty treatment, accessibility evidence, representative reader-task checks, and any unresolved data or rendering limitation.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
