---
name: fine-tuning-training
description: Train and validate model weight or adapter changes with governed data, clean splits, reproducibility, and rollback. Use when fine tuning, preference optimization, distillation, or training improves a measured behavior; not for prompt changes, retrieval configuration, or evaluation only.
---

# Fine-Tuning and Training

Training is an optimization intervention, not a default answer to poor model behavior. Start from a measured base-model failure and prove that changing weights is justified relative to prompting, retrieval, tools, product logic, or a different base model.

## Workflow

1. **Resolve the training surface before designing the run.** Identify provider/runtime, exact base model or commit, tokenizer/chat template, supported fine-tuning methods, context/example limits, account/model eligibility, serving lifetime, licenses and current deprecations. For managed providers, verify availability from current documentation rather than assuming an API still accepts new training jobs.
2. **Require an eval-backed reason to train.** Record the base-model baseline and the failure distribution. Try the cheaper/control alternatives appropriate to the problem: prompt/context changes for instruction behavior, RAG for changing/private knowledge, tools or deterministic code for precise actions, or another model for capability gaps. Train only when the remaining gap is repeatable and decision-relevant.
3. **Choose an objective that matches the signal.** Use supervised fine-tuning when high-quality demonstrations encode the desired output/task behavior. Use preference optimization only when annotators can make consistent pairwise choices. Use reinforcement fine-tuning only when outputs can be graded robustly and the base model already succeeds often enough to provide a learning signal. Use LoRA/PEFT when local/open-weight adaptation and resource, portability, or serving constraints justify training only a small parameter subset.
4. **Govern the dataset.** Record provenance, license/consent, privacy/PII handling, collection time, annotation instructions, labeler identity/quality where appropriate, source/entity IDs and deduplication. Remove training examples whose use is not authorized. Keep synthetic/distilled examples labeled and traceable to the teacher/model/prompt that produced them.
5. **Split before optimization.** Separate train, validation/development and final decision holdout before prompt/data rewriting or hyperparameter tuning. Group or time-split correlated examples, remove near-duplicates across partitions, and keep eval answers, grader labels and hidden benchmark cases out of training data. Validation selects checkpoints/hyperparameters; the final holdout does not.
6. **Preflight the exact serialized examples.** Validate message/schema format, role ordering, weights/masks, token counts and truncation behavior with the selected tokenizer/provider. Preserve any prompt/instructions the model still needs at inference. A silently truncated target or tail is a corrupt training example, not a harmless optimization detail.
7. **Pilot cheaply before scaling.** Start with a small representative run and conservative/default hyperparameters. Record seed, batch, learning rate/multiplier, epochs/steps, objective-specific parameters, trainable parameter count and hardware/runtime. Inspect training and validation curves plus representative generations, not just one loss/reward number.
8. **Treat the objective as attackable.** For preference/reward training, test annotator consistency and grader calibration before the run. During training, inspect outputs for reward hacking, verbosity/format shortcuts, collapsed diversity and other ways the model can maximize the training signal without improving the real task.
9. **Select checkpoints without touching the final test.** Compare checkpoints on validation performance, target slices and regressions. Watch for memorization, widening train/validation gaps, catastrophic forgetting, style collapse and capability tradeoffs. More epochs are not inherently better.
10. **Run the final base-versus-adapted evaluation.** Use the same untouched holdout, prompt/context and serving settings for the base model and selected checkpoint. Measure target gains plus general-regression and safety slices appropriate to the deployment. Do not generalize a narrow task improvement into a broad capability claim.
11. **Prove artifact identity and reloadability.** Persist dataset hashes/revisions, code/library versions, base model revision, tokenizer/template, objective, hyperparameters, seeds, checkpoints and evaluation linkage. For PEFT, preserve both the base-model identity and adapter config/weights; an adapter alone is not a complete model identity.
12. **Validate deployment and rollback.** Measure actual inference latency, memory and cost, verify provider/model lifetime and adapter/base compatibility, and define an executable rollback to the previous base/checkpoint or by disabling the adapter. Do not promote a training win that cannot be served or recovered safely.

## Boundaries

- `prompt-context-engineering` owns prompt/template/context changes when model weights remain fixed.
- `rag-retrieval-systems` owns changing/private knowledge retrieval; do not fine-tune weights merely to memorize facts that must stay fresh or access-controlled.
- `llm-evaluation` and `ml-evaluation` own evaluation methodology. This skill consumes a valid baseline/holdout and owns keeping training separate from it.
- `embedding-systems` owns embedding representation choice and evaluation when only the embedding model/vector representation is changing.
- `computer-vision` owns image-specific task, annotation and augmentation semantics; compose it with this skill when training a vision model.
- `mlops` owns production training orchestration, registries, deployment pipelines and monitoring. This skill owns the adaptation objective, training data/config/checkpoint contract and training-specific verification.
- `ai-safety-evaluation` owns dedicated safety/red-team measurement. Provider safety checks do not replace use-case-specific safety evaluation.

Use [the maintained source map](references/sources.md) for current provider and PEFT behavior. Refresh managed fine-tuning availability immediately before planning a hosted training run.
