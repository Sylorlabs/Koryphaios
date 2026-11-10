# Source map

`mlops` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. MLOps platform semantics are especially version-sensitive: registry aliases/stages, model signatures, feature-store serving behavior, sync/freshness rules, pipeline orchestration and product deprecations must be checked against the actual platform/version before encoding them as operational invariants.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader release-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google Cloud: MLOps continuous delivery and automation pipelines**: https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning
  - Scope: Google Cloud MLOps architecture guidance as available 2026-10-04.
  - Use: separation of ML experimentation/CI/CD/continuous training, automated validation, serving and production monitoring across the ML lifecycle.
  - Verified: 2026-11-03; refresh after 30 days.
- **MLflow Model Registry**: https://mlflow.org/docs/latest/ml/model-registry
  - Scope: MLflow latest documentation as available 2026-10-16.
  - Use: registered models, versions, lineage, model signatures, aliases/tags and controlled lifecycle workflows. A registry alias is a mutable reference and should identify, not replace, immutable qualification evidence.
  - Verified: 2026-10-16; refresh after 14 days.
- **Google Cloud Feature Store online serving types**: https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/featurestore/latest/online-serving-types
  - Scope: online-serving documentation as available 2026-10-16.
  - Use: current online store modes, sync behavior and deprecation-sensitive serving choices. Current documentation marks Optimized online serving deprecated and should be refreshed before implementation.
  - Verified: 2026-10-16; refresh after 14 days.
- **Google Cloud Feature Store: serve feature values**: https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/featurestore/latest/serve-feature-values
  - Scope: feature-value serving documentation as available 2026-10-16.
  - Use: current entity-ID, feature timestamp, latest-value and sync requirements; verify exact null/latest semantics for the selected configuration.
  - Verified: 2026-10-16; refresh after 14 days.
- **NIST AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
  - Scope: NIST AI RMF materials as available 2026-09-05.
  - Use: lifecycle governance, measurement, monitoring, traceability and risk response for production ML systems.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Model lifecycle identity is multi-part: code, data, feature definitions, run, model artifact/digest/signature, evaluation, registry reference, deployment revision and serving configuration. A mutable alias is not sufficient provenance.
- Build immutable candidates, then validate and promote them. Promotion must not rebuild or mutate the artifact that was evaluated.
- Reproduce the inference package in a clean runtime and verify schemas/preprocessing/dependencies before serving. Training-environment success is not deployment proof.
- Offline and online feature parity requires point-in-time-correct historical values for training/evaluation plus the selected online store's entity/null/freshness/sync semantics. Test actual values and timestamps, not only feature names.
- Separate service health from model quality. Monitor errors/latency/resources alongside schema, missingness/freshness, distribution/prediction shift and mature outcomes.
- Drift is a diagnostic signal. Do not automatically retrain or promote without determining cause, constructing immutable inputs and re-running the full qualification gates.
- Retraining automation must be bounded, deduplicated/idempotent and failure-safe. A failed candidate or pipeline run must leave production on the last known-good revision.
- Verify current product/version/deprecation behavior immediately before platform-specific changes; feature stores and registries can change serving, alias and lifecycle semantics independently of model code.
