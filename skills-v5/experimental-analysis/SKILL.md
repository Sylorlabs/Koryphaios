---
name: experimental-analysis
description: Design and analyze randomized, factorial, blocked, or quasi-experimental studies for causal questions. Use when an intervention study or quasi-experimental identification strategy is central; use experimentation-ab-testing for product A/B operations and data-analysis for descriptive work.
---

# Experimental Analysis

Own the study-design and causal-evidence boundary for experiments and quasi-experiments outside the specialized product A/B workflow. Start from the intervention question and the data-generating process, then choose a design whose assumptions can actually support the intended claim.

## Frame the study

State the causal question, target population, units, intervention, comparator, outcomes, timing, estimand, assignment mechanism, exclusions, and decision before looking at outcomes where possible. Define the smallest practically meaningful effect and the precision or power needed to distinguish it.

Identify nuisance variables, interference or spillover, repeated measures, clustering, attrition, missingness, carryover, secular trends, and measurement changes that can break a naive comparison.

## Randomized and designed experiments

For randomized studies, preserve the assignment mechanism in the analysis. Use blocking or stratification for important controllable nuisance factors, and randomize what cannot be controlled. For factorial designs, state factors, levels, interactions of interest, replication, aliasing/confounding, and which effects cannot be identified under a fractional design.

Choose the randomization unit to match the treatment and interference structure. Cluster when units share treatment or outcomes; account for the resulting effective sample size and analysis dependence. Predeclare the primary outcome, analysis population, stopping, and multiplicity handling when the design is confirmatory.

## Quasi-experimental designs

Name the identification strategy and make its assumptions falsifiable where possible:

- difference-in-differences: define treatment timing, comparison units, pre-periods, parallel-trends evidence, anticipation, compositional change, and spillover;
- regression discontinuity: define the forcing variable, cutoff rule, bandwidth, functional-form sensitivity, manipulation/sorting checks, and local estimand;
- interrupted time series: model baseline level/trend, intervention timing, autocorrelation/seasonality, concurrent shocks, and enough pre/post observations;
- matched/comparison-group designs: establish baseline equivalence, overlap, measured-confounder balance, and the unmeasured-confounding limit.

A single-group pre/post change is not causal evidence when time itself is an uncontrolled confounder.

## Analysis and verification

Report effect size with units, baseline/comparator, uncertainty interval, sample or effective sample size, and practical significance. Preserve intention-to-treat for randomized assignment unless a different estimand and identification argument are explicit. Diagnose attrition, missingness, protocol deviations, balance, interference, repeated measures, and model assumptions before interpreting the headline estimate.

For quasi-experiments, add design-specific falsification or sensitivity checks: pre-trends/placebo dates, negative-control outcomes, bandwidth/model sensitivity, overlap/balance, alternative comparison groups, or bounds where appropriate. Separate confirmatory outcomes from exploratory slices and multiple comparisons.

## Boundaries

- `experimentation-ab-testing` owns online/product A/B design, ramp, exposure telemetry, SRM operations, and product-experiment stopping/guardrails.
- `statistical-inference` owns general estimation or hypothesis testing that does not require an intervention-design boundary.
- `data-analysis` and `exploratory-data-analysis` own descriptive/exploratory questions without a causal study design.
- `analytics-engineering` and `data-pipeline-engineering` own modeled datasets, ETL, lineage, and production data movement.
- `data-visualization` owns the presentation layer after the study result is valid.

Compose when both outputs are requested, but keep study validity separate from data plumbing, visualization, and downstream decisions.

## Failure boundaries

Do not infer causality from correlation or a single-group pre/post comparison, hide failed randomization or attrition, choose a model only because it produces significance, ignore cluster dependence, treat a quasi-experimental label as proof of identification, or report precise effects when the design assumptions or effective sample do not support them.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.
