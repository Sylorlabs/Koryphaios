---
name: statistical-inference
description: Estimate effects or relationships with explicit population, assumptions, uncertainty, and multiplicity. Use when the request specifically requires statistical analysis, confidence interval, hypothesis test, estimate effect; prefer a narrower child only when its boundary is established.
---

# Statistical Inference

Own inferential claims about a population or effect. `data-analysis` owns the broader analytical workflow; use the narrower `experimentation-ab-testing` child when randomized experiment design/operation is the established boundary.

## Operating contract

1. Define the estimand before choosing a method: population, outcome unit, denominator, weighting, comparison, time horizon, units, and decision consequence. Keep the unit of assignment and the unit of dependence separate from the outcome unit. Randomizing workspaces does not silently change an individual conversion estimand into the average of workspace conversion rates.
2. Establish how observations arose, including sampling/assignment, clustering/dependence, selection, missingness/censoring, measurement error, and relevant confounding. Do not infer causality from association without an identifying design and assumptions.
3. State the identification assumptions and relevant confounders before selecting a method. Choose a method consistent with the sampling and assignment process and check sensitivity to plausible alternatives, including unequal cluster sizes when relevant. If the question is not identified, narrow the claim instead of manufacturing precision.
4. Report effect size plus interval/posterior uncertainty, sample or effective sample size, practical significance, and important subgroup/sensitivity results. Make repeated looks, multiple outcomes, exclusions, transformations, and model selection explicit.
5. Preserve a reproducible record of data version, estimand, analysis choices, diagnostics, sensitivity, and limitations. A threshold crossing is not proof; a large sample does not remove bias; an interval must be interpreted within its statistical framework.

Reject pseudo-replication, ignored dependence, undefined denominators, outcome switching, uncorrected multiplicity, confounded comparisons, and sophisticated models used to obscure weak sampling. Return the estimand, assumptions, effect/uncertainty, sensitivity/multiplicity treatment, reproducible calculation, and unresolved limitations.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
