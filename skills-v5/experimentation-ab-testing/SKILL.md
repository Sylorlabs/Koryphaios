---
name: experimentation-ab-testing
description: Design and assess controlled product experiments with valid assignment, exposure, guardrails, and stopping. Use when planning an A/B test, diagnosing experiment health, or deciding from randomized product results; not for descriptive metrics, observational inference, or growth implementation alone.
---

# Experimentation and A/B Testing

Own the experimental design and trustworthiness boundary. The skill should make it possible to tell whether the treatment was assigned as intended, whether the measured comparison identifies the intended causal effect, and whether the result is reliable enough for the decision at hand.

## Before launch

Define the causal question before calculating sample size:

- hypothesis and decision to be informed;
- target population, eligibility, exclusion, and exposure rules;
- treatment/control behavior and the estimand;
- randomization unit, allocation ratio, stratification or clustering where justified;
- primary metric, secondary metrics, and invariant or guardrail metrics;
- baseline, minimum effect worth detecting, power/precision target, expected sample rate, and minimum duration;
- ramp strategy, analysis population, stopping rule, and multiplicity plan;
- interference, carryover, novelty, seasonality, cross-device/account, and network risks.

Use the smallest randomization unit that preserves treatment independence and matches the decision. If household, account, team, marketplace, geographic, or network effects create interference, use an appropriate cluster or switchback design or explicitly narrow the causal claim.

Validate assignment and telemetry before trusting outcomes. Check that assignment is deterministic where required, exposure is logged independently from outcome, variants are actually behaviorally different, metric definitions are stable, and guardrail/rollback signals are observable during the ramp.

## During the experiment

Treat sample-ratio mismatch, missing assignments, broken exposure logging, variant leakage, metric pipeline drift, severe invariant imbalance, or treatment-specific data loss as trust failures to diagnose before reading the treatment effect. A statistically significant outcome does not rescue a broken experiment.

Do not repeatedly peek at a fixed-horizon p-value and stop when it crosses a threshold. Either honor the predeclared fixed horizon or use a sequential design whose error properties match the monitoring plan. Operational safety guardrails may justify stopping early for harm even when the efficacy analysis is fixed-horizon.

## Analysis

Preserve random assignment in the primary analysis. Prefer intention-to-treat for the assignment effect unless the requested estimand and identification assumptions justify another analysis. Do not casually drop noncompliers, unexposed assigned users, or users with missing downstream events when treatment can affect those states.

Report baseline and absolute effect alongside relative lift, uncertainty intervals, sample/effective sample size, and practical significance. Check sample-ratio mismatch, balance or invariants, missingness, exposure integrity, novelty/seasonality, repeated measures, and interference before interpreting the effect.

Handle multiple outcomes, repeated looks, and subgroup analysis explicitly. Predeclared slices can diagnose heterogeneity; post-hoc slices are exploratory unless independently validated. Do not select only favorable metrics or segments after seeing results.

## Decision handoff

State what the experiment supports, what it does not identify, the guardrail result, material diagnostics, and any data-quality limitation. Distinguish a valid null/inconclusive result from an underpowered or compromised experiment. If the decision requires another experiment, specify the smallest design change that resolves the uncertainty.

## Boundaries

- `statistical-inference` and `experimental-analysis` own broader statistical or non-product experimental analysis when no A/B/product-experiment design is requested.
- `product-analytics` owns descriptive instrumentation, funnel/cohort analysis, and nonexperimental product evidence.
- `growth-engineering` owns implementation of growth loops and acquisition/activation mechanics.
- `product-management` owns prioritization and the product decision; this skill provides experimental evidence and experiment-specific go/no-go constraints.
- `pricing-monetization` owns pricing/packaging strategy; this skill owns the controlled experiment used to test one.

Compose when both outputs are requested, but keep assignment, analysis, product decision, and implementation evidence separate.

## Failure boundaries

Do not claim causality from a merely pre/post or observational comparison, stop repeatedly on nominal significance, hide an SRM, change the primary metric after seeing outcomes, exclude post-assignment states without an identification argument, run user-level randomization when strong network interference dominates, or report relative lift without baseline/absolute effect.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.
