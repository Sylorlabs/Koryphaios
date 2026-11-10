# Source map

`ml-evaluation` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. The statistical design must follow the deployment population and data dependence; library defaults are implementation conveniences, not substitutes for a justified evaluation protocol.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis, testing-engineering; narrower children computer-vision, embedding-systems, fine-tuning-training, llm-evaluation, recommendation-ranking, speech-audio-ai.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **scikit-learn cross-validation**: https://scikit-learn.org/stable/modules/cross_validation.html
  - Scope: scikit-learn 1.9.0 stable documentation as available 2026-09-05.
  - Use: held out final testing, cross-validation, stratified/group/time-aware splitting concerns, retained split indices and caveats around time ordering and generalization estimates.
  - Verified: 2026-09-05; refresh after 90 days.
- **scikit-learn common pitfalls**: https://scikit-learn.org/stable/common_pitfalls.html
  - Scope: scikit-learn 1.9.0 stable documentation as available 2026-09-05.
  - Use: train/test leakage, preprocessing fit boundaries, pipelines, estimator/splitter randomness and comparable model-selection procedures.
  - Verified: 2026-09-05; refresh after 90 days.
- **scikit-learn metrics and scoring**: https://scikit-learn.org/stable/modules/model_evaluation.html
  - Scope: scikit-learn 1.9.0 stable documentation as available 2026-09-05.
  - Use: classification, probability, ranking, regression and multi-metric evaluation semantics. Choose from these metrics only after defining deployment costs and target behavior.
  - Verified: 2026-09-05; refresh after 90 days.
- **scikit-learn probability calibration**: https://scikit-learn.org/stable/modules/calibration.html
  - Scope: scikit-learn 1.9.0 stable documentation as available 2026-09-05.
  - Use: reliability diagrams, proper scoring-rule interpretation and calibration fitting on data separate from base-estimator fitting.
  - Verified: 2026-09-05; refresh after 90 days.
- **NIST/SEMATECH e-Handbook of Statistical Methods**: https://www.itl.nist.gov/div898/handbook/
  - Scope: NIST statistical handbook as available 2026-09-05.
  - Use: measurement, uncertainty, experimental design, diagnostics and statistical reasoning when a model-comparison claim needs more than point estimates.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
  - Scope: NIST AI RMF materials as available 2026-09-05.
  - Use: deployment-context, measurement, monitoring and lifecycle-risk framing beyond one offline score.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Split according to how observations depend on one another in production. Random k-fold is not a universal default for repeated entities, time series, grouped sources or near-duplicates.
- Any learned preprocessing, feature selection, calibration or threshold optimization must stay inside training/development data. The final decision test cannot also be an optimization surface.
- Match metrics to the error costs, class prevalence and action. Accuracy can be actively misleading under imbalance; ROC-AUC does not establish probability calibration or threshold utility.
- Compare candidate and baseline on paired examples/splits and preserve per-example predictions so uncertainty and regression analysis can be reproduced.
- Separate confirmatory gates from exploratory slice mining, and keep low-support slices visibly uncertain rather than overinterpreting them.
- Report invalid labels/rows/scoring failures explicitly; do not improve a metric by silently excluding difficult examples.
