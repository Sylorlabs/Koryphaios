---
name: ml-evaluation
description: Evaluate predictive models with leakage-safe splits, deployment-aligned metrics, baselines, calibration, and uncertainty. Use when comparing non-generative predictions under real failure costs; use llm-evaluation for generative or agent behavior and data-analysis for analysis without a model-performance decision.
---

# ML Evaluation

Start from the deployment decision and data-generating process, not from whichever metric a library exposes by default. Evaluation is invalid when the test population, split logic, preprocessing or operating threshold leaks information the deployed model would not have.

## Workflow

1. **Define the deployment contract.** Name the prediction target, prediction time, population, unit of observation, available features at prediction time, current/dummy baseline, decision the score supports, material error types and their relative costs. Separate discrimination/ranking quality from probability quality and downstream decision utility.
2. **Choose a split that respects dependence.** Split before learned preprocessing. Use stratification only when independence assumptions permit it; use grouped splits for repeated entities, temporal/backtest splits for time-dependent deployment, and other structure-aware partitions when records share sources, sessions, locations or near-duplicates. Document why the split represents future use.
3. **Keep model selection away from the final test.** Fit preprocessing, feature selection, calibration and hyperparameters on training/development data only. Use cross-validation or a validation set for selection and thresholding, then reserve an untouched test/decision set for the final estimate. Repeatedly inspecting test errors turns the test into development data.
4. **Select metrics from failure costs and prevalence.** For classification, inspect the confusion matrix and class-wise metrics rather than relying on accuracy when imbalance or asymmetric cost matters. Use precision/recall/F-beta, PR/ROC curves, ranking metrics or cost/utility as the use case requires. For probabilistic outputs, use proper scoring rules and reliability/calibration diagnostics. For regression, choose errors and quantiles that match operational loss, not a universal favorite metric.
5. **Choose operating thresholds on development data.** Translate scores/probabilities into actions using an explicit cost, capacity or quality target. Do not optimize the threshold on the final test. If the product supports abstention/manual review, evaluate coverage versus error/utility and define what happens below confidence.
6. **Evaluate calibration separately.** Reliability diagrams and proper scores can reveal probability problems that rank metrics hide. Calibrate using data not used to fit the base model and verify that calibration improves the decision-relevant property; do not infer good calibration from ROC-AUC or accuracy alone.
7. **Compare paired outcomes with uncertainty.** Evaluate candidate and baseline on the same examples/splits. Preserve per-example predictions, use a paired resampling/interval or other justified inferential method, and report both effect size and uncertainty. For cross-validation, keep comparable folds and summarize fold variability without pretending correlated folds are independent observations.
8. **Slice before celebrating an average.** Predeclare high-value segments such as rare classes, geography/device/source, entity frequency, time periods, input-quality bands or operational regimes. Investigate worst regressions and low-support slices; label exploratory slice mining separately from confirmatory gates.
9. **Test drift and robustness that deployment can plausibly encounter.** Compare temporal/cohort distributions, missingness, label delay, class prevalence and representative perturbations. Prefer natural shift/backtests over arbitrary noise. Distinguish covariate shift, label shift, target/concept change and data-pipeline breakage where evidence permits.
10. **Keep invalid runs visible.** Missing labels, corrupt records, failed preprocessing, unsupported classes and scoring exceptions need explicit accounting. Do not silently drop hard rows or map fit/scoring failures to favorable values.
11. **Persist a reproducible decision artifact.** Record dataset/split revision, preprocessing/model/calibration/threshold versions, seeds/split indices, baseline, metrics, intervals, slices, exclusions and raw predictions needed to reproduce the result. Preserve genuine failures as regression cases.

## Boundaries

- `llm-evaluation` owns generative-language and agent behavior, semantic judges, trajectories and stochastic free-form outputs. These are sibling evaluation disciplines; engineering a model is a separate responsibility that may require either discipline's evidence.
- `data-analysis` owns descriptive/diagnostic analysis when no model-quality or deployment decision is being estimated.
- `statistical-inference` owns deeper causal/hypothesis/modeling questions beyond the performance comparison needed here; compose it when inference assumptions are themselves central.
- `fine-tuning-training` and other training skills own candidate creation and hyperparameter/training procedures. Keep final evaluation data outside those optimization loops.
- `recommendation-ranking` owns recommender/search ranking architecture and product objectives; this skill can supply generic split, uncertainty and calibration discipline when evaluating a predictive component.

Use [the maintained source map](references/sources.md) for metric and implementation details. Treat library defaults as tools, not as evidence that a split or metric is appropriate for the deployment problem.
