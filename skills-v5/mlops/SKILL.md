---
name: mlops
description: Engineer reproducible ML pipelines, model lineage, promotion, serving parity, monitoring, and rollback. Use when changing model registries, deployment automation, feature serving, or drift-driven operations; use fine-tuning-training for weight updates and cicd-engineering for generic software delivery.
---

# MLOps

Treat production ML as a lineage graph, not a model file. A deployable revision must be traceable to code, data, feature definitions, environment, training run, model artifact/signature, evaluation, approval, serving configuration and rollback state.

## Workflow

1. **Define lifecycle identities.** Distinguish source revision, dataset snapshot, feature-definition/view revision, training run, model artifact/digest, registry version/alias, evaluation report, endpoint/deployment revision and runtime configuration. Do not collapse “model version” and “what production serves” into one mutable name.
2. **Make inputs reproducible.** Record immutable or content-addressed data manifests, schemas, feature logic, training/eval partitions, dependency/runtime images and seeds/configuration. A notebook path or registry entry without reconstructable inputs is not reproducibility evidence.
3. **Enforce point-in-time feature correctness.** Offline training features must reflect information available at each event timestamp. Online serving must use equivalent entity keys, transforms, definitions, null/default semantics and freshness policies. Test historical/offline joins separately from latest-value online serving.
4. **Package an explicit inference contract.** Record input/output schemas, preprocessing/postprocessing, model dependencies, tokenizer/encoder/category maps when applicable, hardware/runtime requirements and model signature. Validate loading in a clean runtime, not only in the training environment.
5. **Separate build from promotion.** Produce immutable candidate artifacts first. Run deterministic validation/evaluation, security/governance checks where required, then promote an alias/deployment reference to an already-qualified artifact. Avoid rebuilding or mutating weights during promotion.
6. **Gate on evaluation evidence.** A registry status is metadata, not proof of quality. Tie promotion to the exact evaluation report and slices that were run on the exact artifact/configuration. Keep final decision data outside training and automated hyperparameter/checkpoint selection.
7. **Verify train-serving parity.** Compare representative offline and online features, schemas, preprocessing and model outputs. Exercise missing entities, nulls/defaults, stale data, categorical/schema changes and dependency/version skew before canary traffic.
8. **Deploy reversibly.** Use shadow, canary or staged traffic when appropriate. Pin endpoint configuration, model artifact, feature view/store revision and resource settings. Define health/quality gates and a rollback that restores a known-good deployment without retraining.
9. **Monitor service and model behavior separately.** Track request/error/latency/resource health plus schema violations, feature freshness, missingness, distribution shifts, prediction distribution and delayed outcome quality. A service can be healthy while model quality degrades, and vice versa.
10. **Treat drift as evidence, not an automatic retraining command.** Define baseline/window/sample requirements and action thresholds. Diagnose pipeline/schema/product changes before retraining. New training data must pass provenance, leakage and evaluation gates just like the original release.
11. **Design retraining idempotently.** Scheduled/event-triggered jobs need bounded concurrency, immutable run inputs, deduplicated triggers, resumable/idempotent stages and explicit failure state. A failed retrain must not replace the currently serving model.
12. **Preserve delayed-label semantics.** If outcome labels arrive later, monitor proxy signals separately from actual quality and align evaluation windows with label maturity. Do not declare drift or recovery from incomplete labels without stating the limitation.
13. **Audit registry and feature-store product semantics.** Verify current platform version, alias/stage behavior, online-store null/freshness semantics, sync state and deprecations before encoding operational assumptions. Do not infer semantics from old examples.
14. **Close the lineage loop.** Persist deployment decisions, artifacts, hashes, evaluation evidence, monitoring incidents and rollback results so any production prediction can be mapped back to the serving model/configuration and its qualification record.

## Boundaries

Represent promotion as a conjunction of explicit lineage, artifact trust, approval, feature parity and canary gates. A missing gate is not a pass and healthy service metrics do not establish model compatibility. Keep candidate pipeline state separate from serving state so production rollback remains possible while training is incomplete. Deduplicate triggers by immutable input identity and resume from the failed stage without replaying already committed stages. Preserve the gate observations and recovery results with the deployment record.

- `fine-tuning-training` owns how model/adapter weights are changed and checkpointed. `mlops` owns reproducible orchestration, packaging, qualification, registry, deployment and operations of the resulting artifact.
- `ml-evaluation` owns general evaluation design and statistics. `mlops` owns binding an approved evaluation to an immutable artifact and enforcing it as a release gate.
- `cicd-engineering` owns generic software build/test/release automation. `mlops` adds ML-specific data/feature/model lineage, offline-online parity, model qualification and retraining lifecycle.
- `release-planning` owns release sequencing/stakeholder rollout strategy. `mlops` owns model-serving revisions, canary/shadow evidence and technical rollback contracts.
- `observability-sre` owns broad service telemetry/reliability. `mlops` owns ML-specific feature/schema/prediction/outcome monitoring and model-quality actions.
- Model architecture selection, pure data-science experimentation, ANN tuning or application behavior do not activate this skill unless lifecycle/serving/registry/feature-store operations are part of the current task.

Use [the maintained source map](references/sources.md) before relying on platform-specific registry, feature-store, pipeline or serving behavior.
