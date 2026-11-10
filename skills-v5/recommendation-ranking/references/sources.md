# Source map

`recommendation-ranking` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Recommender implementation details and serving APIs change, but the most important evidence boundary is policy/data semantics: candidate eligibility, exposure, event timing, features, ranking objective and online assignment must be reconstructed from the actual system rather than inferred from a tutorial.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **TensorFlow Recommenders overview**: https://www.tensorflow.org/recommenders
  - Scope: TensorFlow Recommenders documentation as available 2026-11-07.
  - Use: current retrieval/ranking modeling library and production-oriented recommender patterns.
  - Verified: 2026-11-07; refresh after 30 days.
- **TensorFlow Recommenders basic retrieval**: https://www.tensorflow.org/recommenders/examples/basic_retrieval
  - Scope: current TFRS retrieval tutorial as available 2026-11-07.
  - Use: two-stage recommender decomposition, query/candidate retrieval models, candidate evaluation and the explicit production guidance that temporal splits are generally preferable to the tutorial's simple random demonstration split.
  - Verified: 2026-11-07; refresh after 30 days.
- **TensorFlow Recommenders basic ranking**: https://www.tensorflow.org/recommenders/examples/basic_ranking
  - Scope: current TFRS ranking tutorial as available 2026-11-07.
  - Use: ranking-stage supervised scoring patterns and separation from retrieval. Treat tutorial labels as examples, not evidence that production exposure data is unbiased.
  - Verified: 2026-11-07; refresh after 30 days.
- **TensorFlow Recommenders multitask recommenders**: https://www.tensorflow.org/recommenders/examples/multitask
  - Scope: current TFRS multitask tutorial as available 2026-11-07.
  - Use: multi-objective recommender modeling and explicit tradeoffs between related objectives.
  - Verified: 2026-11-07; refresh after 30 days.
- **NIST AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
  - Scope: NIST AI RMF materials as available 2026-11-07.
  - Use: lifecycle measurement, representative evaluation, transparency and governance when recommendation effects are consequential.
  - Verified: 2026-11-07; refresh after 180 days.

## Interpretation rules

- Separate candidate generation from ranking. Measure candidate coverage/relevance before interpreting ranking metrics; the ranker cannot recover an item absent from its candidate set.
- Build labels from explicit event semantics and exposure opportunity. Unexposed items are not ordinary negatives, and displayed position/policy version may affect observed feedback.
- Enforce point-in-time correctness. Features, eligibility, inventory and aggregates must reflect what the serving system knew at the recommendation event, and delayed outcomes must not leak into predictors.
- Prefer deployment-faithful temporal/backtest splits for changing users/items/catalogs. Random tutorial splits are illustrative, not a production default.
- Use ranking/retrieval metrics at product-relevant depths and report cold-start, long-tail, locale/market and other material slices plus diversity/novelty/coverage or marketplace guardrails where they affect product quality.
- Logged-policy outcomes are observational unless the data and estimator support a defensible counterfactual analysis. For causal launch claims, prefer a controlled randomized online experiment when feasible and authorized.
- Exploration must be deliberate: define eligible traffic/risk limits, log action propensities and policy versions, and preserve those fields in downstream learning/evaluation.
- Verify train-serving parity for candidate filters, IDs, feature definitions/values/freshness/defaults, model/reranker versions and fallbacks. Preserve prior policies and failed slices for rollback/regression testing.
