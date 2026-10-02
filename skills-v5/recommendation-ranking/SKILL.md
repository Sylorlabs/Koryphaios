---
name: recommendation-ranking
description: Engineer recommenders with explicit objectives, feedback bias, candidates, ranking, and serving evidence. Use when personalized recommendations, feed ranking, or recommendation policy changes; use embedding-systems for representations and vector-search-systems for index mechanics.
---

# Recommendation and Ranking

A recommender learns from what the previous policy exposed, not from an unbiased sample of user preference. Treat candidate eligibility, exposure, feedback semantics, ranking objective, exploration, serving state and evaluation as one contract.

## Workflow

1. **Define the product decision and utility.** State what is being ranked, for whom, at what moment, and which user/product outcome matters. Separate immediate engagement from long-term value, satisfaction, retention, revenue, safety, marketplace health or other guardrails. Do not optimize click-through simply because it is easy to log.
2. **Separate retrieval, ranking and policy stages.** Document candidate sources, eligibility filters, retrieval limits, scoring/ranking stages, reranking/business constraints and final slate construction. A ranking model cannot recover relevant items that candidate generation never supplies.
3. **Model exposure before feedback.** Distinguish impressions/exposure from clicks, dwell, saves, purchases, hides, reports and other events. An item not clicked is not automatically a negative if it was never shown or was effectively invisible because of position. Preserve request/session/user/item IDs and displayed position.
4. **Use point-in-time-correct features.** Build examples from feature values available at the ranking decision time. Prevent future catalog state, post-impression aggregates, label-derived statistics or delayed outcomes from leaking backward. Version feature definitions and joins.
5. **Split on deployment time and dependency.** Prefer temporal/backtest splits when the production task predicts future behavior. Keep repeated sessions, near-duplicate events and derived labels from contaminating validation/final sets. Include seasonality or catalog-change windows when material.
6. **Evaluate candidate generation separately.** Measure whether relevant/eligible items enter the candidate set with Recall@K, hit rate, coverage or task-appropriate retrieval metrics. Slice by new users/items, long tail, locale/market and sparse-history cases. Keep ANN implementation details in `vector-search-systems` when the representation is fixed.
7. **Evaluate ordering at the decision depth.** Use NDCG, MRR, MAP, precision/recall or other ranking metrics whose gain/position semantics match the product. Report metrics at the actual slate depth and important segments. Do not claim online impact from a small offline rank-metric delta alone.
8. **Track slate and ecosystem quality.** Measure diversity, novelty, catalog/provider coverage, duplication, freshness and constraint satisfaction when relevant. Popularity-biased accuracy can improve while cold-start users, long-tail items or marketplace suppliers become worse off.
9. **Treat logged-policy data as biased.** Position, selection and exposure bias make observational comparisons non-causal. If propensities are reliably logged and the estimator assumptions hold, use appropriate counterfactual estimators with diagnostics; otherwise describe the result as offline/observational and require a controlled online experiment for causal launch claims.
10. **Make exploration explicit.** Define exploration eligibility, risk budget, probability/propensity logging, exclusions and user/product guardrails. Never mix exploratory traffic into training or evaluation without preserving the action probability and policy version needed to interpret it.
11. **Validate online changes causally.** When authorized, specify randomization unit, assignment persistence, primary metric, guardrails, ramp criteria, minimum exposure/duration logic and rollback. Watch for interference, carryover, novelty effects and delayed outcomes where they invalidate a naive A/B read.
12. **Preserve train-serving parity.** Verify online candidate filters, feature freshness/defaults, entity IDs, normalization and model/reranker versions against offline construction. Test cold-start and missing-feature fallbacks, inventory/eligibility changes and stale-cache behavior.
13. **Audit feedback loops and abuse.** Check whether ranking amplifies popularity, spam, strategic supplier behavior, bots, clickbait or position artifacts. Prefer debiased or exploration-informed evidence over recursively treating prior exposure as ground truth preference.
14. **Promote with reversible evidence.** Persist dataset/log windows, policy/model/features, candidate-set definitions, offline metrics, online assignment/analysis and serving traces. Keep failed slices and experiment regressions, and preserve a fast fallback or prior policy for rollback.

## Boundaries

- `embedding-systems` owns embedding model/task/dimension/normalization identity. This skill owns how user/item signals and embeddings become recommendation candidates, scores and product policy.
- `vector-search-systems` owns ANN/vector-index algorithms, capacity, filtering execution and low-level search latency. This skill owns candidate relevance/coverage and downstream ranking objectives.
- `ml-evaluation` owns general statistical evaluation methodology. This skill owns recommender-specific exposure bias, ranking/retrieval metrics, feedback loops, cold-start/long-tail and online-policy semantics.
- `fine-tuning-training` owns changing model/adapter weights. This skill defines recommender labels, objectives, temporal data and release evidence that training must satisfy.
- Generic database sorting, search-index tuning, static editorial ordering or UI list layout do not activate this skill unless a recommendation/ranking policy is being changed or evaluated.

Use [the maintained source map](references/sources.md) before encoding framework-specific retrieval, ranking, sampling or evaluation behavior.
