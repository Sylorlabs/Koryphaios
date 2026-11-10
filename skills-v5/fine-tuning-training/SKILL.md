---
name: fine-tuning-training
description: Train and validate model weight or adapter changes with governed data, clean splits, reproducibility, and rollback. Use when fine tuning, preference optimization, distillation, or training improves a measured behavior; not for prompt changes, retrieval configuration, or evaluation only.
---

# Fine-Tuning and Training

Training is an optimization intervention, not a default answer to poor model behavior. Start from a measured base model failure and prove that changing weights is justified relative to prompting, retrieval, tools, product logic, or a different base model.

## Operating contract

Before a run, write a short contract that names:

- the behavior, population, and failure slices to improve;
- the proposed intervention and why fixed weight alternatives are insufficient;
- the exact base-model revision, tokenizer, template, runtime, and data revision;
- the primary metric, bounds for regressions, safety slices, serving budgets, and promotion/rejection rule;
- the artifact that will be promoted, its rollback target, and the evidence required for each claim.

If a field is unknown, label it `unavailable`, `inferred`, `stale`, `simulated`, or `unresolved`. A plan, provider documentation example, synthetic fixture, training curve, or evaluator registration is not evidence that a real job trained, an artifact reloads, or a deployment is viable.

## Workflow

1. **Resolve the training surface before designing the run.** Identify provider/runtime, exact base model or commit, tokenizer/chat template, supported fine-tuning methods, context/example limits, account/model eligibility, serving lifetime, licenses and current deprecations. For managed providers, verify availability from current documentation and the account/API rather than assuming an API still accepts new training jobs.
2. **Require a reason to train backed by evaluation.** Record the base model baseline, task distribution, failure slices, uncertainty and decision threshold. Try the cheaper/control alternatives appropriate to the problem: prompt/context changes for instruction behavior, RAG for changing/private knowledge, tools or deterministic code for precise actions, or another model for capability gaps. Train only when the remaining gap is repeatable and relevant to the decision.
3. **Choose an objective that matches the signal.** Use supervised fine-tuning when high quality demonstrations encode the desired output/task behavior. Use preference optimization only when chosen/rejected pairs represent a coherent, independently checked preference and the provider's format matches the run. Use reinforcement fine-tuning only when outputs can be graded robustly, the grader has a meaningful score range, and the base model already succeeds often enough to provide a learning signal. Use LoRA/PEFT when local/open weight adaptation and resource, portability, or serving constraints justify training only a small parameter subset.
4. **Govern labels and provenance before splitting.** Record source, license/consent, privacy/PII handling, collection time, annotation instructions, labeler identity/quality where appropriate, source/entity IDs, and every transformation. Treat reference answers, preference labels, reward/grader outputs, post outcome fields, and teacher prompts as protected targets. Remove features derived from those targets, unauthorized examples, and examples whose source cannot be traced. Keep synthetic/distilled examples labeled and traceable to the teacher/model/revision/prompt and filter criteria that produced them.
5. **Split by the real independence unit before optimization.** Freeze train, validation/development and final decision holdout manifests before prompt/data rewriting or hyperparameter tuning. Group or split by customer, user, conversation, document, repository, author, device, or other shared source; hash exact and normalized text and audit semantic near duplicates across partitions. Do not let a source entity, duplicate family, future event, benchmark answer, hidden test, grader calibration item, or teacher output cross the decision boundary. Validation selects checkpoints/hyperparameters; the final holdout does not.
6. **Preflight the exact serialized examples and target masks.** Validate message/schema format, role ordering, chosen/rejected pairing, labels, weights/masks, tokenizer version, token counts, truncation, and the inference template. Confirm that the desired target is not silently copied into the input, metadata, tool schema, retrieval context, or grader prompt. Preserve any prompt/instructions the model still needs at inference. A silently truncated target or tail, malformed pair, or feature derived from a target is a corrupt training example, not a harmless optimization detail.
7. **Pilot cheaply before scaling.** Start with a small representative run and conservative/default hyperparameters. Record seed, batch, learning rate/multiplier, epochs/steps, parameters specific to the objective, trainable parameter count, data cardinalities by slice, and hardware/runtime. Inspect training and validation curves plus representative generations, not just one loss/reward number. Abort when the provider rejects data, the run is not reproducible, or the evidence needed by the contract cannot be collected.
8. **Treat the objective and evaluator as attackable.** For preference/reward training, test annotator consistency and grader calibration before the run. Probe format, length, refusal, verbosity, citation, and other shortcut strategies; compare grader scores with independent task checks or blind experts where consequential. During training, inspect reward hacking, label imbalance, memorization, collapsed diversity, and ways the model can maximize the signal without improving the real task. A grader that sees protected answers or the candidate's training metadata is not independent evidence.
9. **Select checkpoints without touching the final test.** Compare checkpoints on validation performance, target slices and regressions. Keep a decision log of every checkpoint/hyperparameter choice. If a holdout case, answer, label, or aggregate is inspected, mark that holdout contaminated, stop using it for the final claim, and quarantine or replace it. Watch for widening train/validation gaps, catastrophic forgetting, style or refusal collapse, and capability tradeoffs. More epochs are not inherently better.
10. **Run the final base and adapted evaluation within a fixed boundary.** Use the same untouched holdout, prompt/template, context, retrieval/tool permissions, decoding policy, retries, model serving region and measurement procedure for the base model and selected checkpoint. Measure target gains, slice uncertainty, general regressions, and use case safety slices. If prompt, retrieval, tools, data, evaluator, or runtime changed too, report a combined intervention or run a factorial comparison; do not attribute the result to weights alone.
11. **Prove artifact identity and fresh process reloadability.** Persist dataset and split manifest hashes/revisions, code/library/container versions, base model revision, tokenizer/template, objective, hyperparameters, seeds, checkpoints, evaluation linkage, and label/grader versions. For PEFT, preserve both the base model identity and adapter config/weights, including target modules and trainable parameter audit; an adapter alone is not a complete model identity. Load the artifact in a clean process and verify outputs or documented compatibility, rather than relying on the training process's in memory state.
12. **Validate deployment and rollback with real receipts.** Measure actual inference latency, memory, throughput and cost for base, adapter enabled, and merged variants where relevant. Verify provider/model lifetime, adapter/base compatibility, packaging, concurrency behavior and failure handling. Exercise rollback to the previous base/checkpoint or by disabling the adapter, and retain the readback showing the old artifact serves. Do not promote a training win that cannot be served or recovered safely.

## Leakage and evaluation boundaries

- **Training boundary:** only authorized, revisioned examples and their permitted targets enter optimization. Keep labels and references in the target side; never add them to prompts, features, metadata, retrieval indexes, tool arguments, or grader instructions merely to make scoring easier.
- **Selection boundary:** development/validation data may guide data cleanup, hyperparameters and checkpoint choice. The final holdout is immutable, access logged, and scored only after the artifact and comparison protocol are frozen. A contaminated holdout is not repaired by deleting the one example that was noticed.
- **Claim boundary:** a synthetic contract, evaluator registration, or provider safety check can validate a narrow property only. It cannot establish that a real model trained, that a tokenizer/runtime handled the serialized data, that an adapter reloads, or that serving and rollback work. Keep those gaps in the final report.
- **Ownership boundary:** `llm-evaluation` or `ml-evaluation` owns general evaluation methodology and grader validity; this skill owns training data separation, objective/configuration, checkpoint identity, and keeping its artifacts out of the decision holdout. Compose rather than silently absorb the neighboring responsibility.

## Promotion gate

Promote only when the contract has observed evidence for all of these: authorized and data audited for leakage; clean split manifests; a justified objective and reproducible pilot; artifact selected on validation; untouched base and adapted target, regression and safety results; fresh process reload; serving budget measurements; and an exercised rollback. Otherwise report `not promotion-ready` and list the missing or unresolved receipts. Do not fill a real training/runtime gap with a simulated success.

## Boundaries

- `prompt-context-engineering` owns prompt/template/context changes when model weights remain fixed.
- `rag-retrieval-systems` owns changing/private knowledge retrieval; do not fine-tune weights merely to memorize facts that must stay fresh or access controlled.
- `llm-evaluation` and `ml-evaluation` own evaluation methodology, grader calibration and statistical interpretation. This skill consumes a valid baseline/holdout and owns keeping training data, labels, checkpoint selection and training artifacts separate from it.
- `embedding-systems` owns embedding representation choice and evaluation when only the embedding model/vector representation is changing.
- `computer-vision` owns image specific task, annotation and augmentation semantics; compose it with this skill when training a vision model.
- `mlops` owns production training orchestration, registries, deployment pipelines and monitoring. This skill owns the adaptation objective, training data/config/checkpoint contract and verification specific to training.
- `ai-safety-evaluation` owns dedicated safety and red team measurement. Provider safety checks do not replace safety evaluation specific to the use case.

Use [the maintained source map](references/sources.md) for current provider, evaluator and PEFT behavior. Refresh managed fine-tuning availability, model shutdown dates and evaluator migration status immediately before planning a hosted training run.
