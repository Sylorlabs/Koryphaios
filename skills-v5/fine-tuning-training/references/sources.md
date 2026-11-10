# Source map

`fine-tuning-training` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Managed fine-tuning availability and supported base models are highly volatile; refresh provider eligibility and deprecation pages immediately before proposing or executing a hosted training run.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Evidence boundary

The package-local checks validate metadata, source-map freshness, routing, task-contract shape, and the registered synthetic concept scorers. They do not run a provider training job, exercise a real GPU/tokenizer/runtime, prove label or benchmark contamination absence in an external corpus, calibrate a live grader, reload a real adapter, measure production serving, or exercise rollback. Those receipts remain explicit prerequisites for promotion.

## Maintained sources

- **OpenAI fine-tuning best practices**: https://developers.openai.com/api/docs/guides/fine-tuning-best-practices
  - Scope: rolling OpenAI fine-tuning guidance reviewed 2026-11-07.
  - Use: current platform wind-down notice, data quality/quantity, train/test separation, prompt inclusion, hyperparameter iteration and training-example token limits/truncation.
  - Verified: 2026-11-08; refresh after 7 days.
- **OpenAI supervised fine-tuning**: https://developers.openai.com/api/docs/guides/supervised-fine-tuning
  - Scope: rolling OpenAI SFT documentation reviewed 2026-11-07.
  - Use: eval-first workflow, representative datasets, base-model comparison, checkpoint use, overfitting and provider safety-check behavior.
  - Verified: 2026-11-08; refresh after 7 days.
- **OpenAI Direct Preference Optimization**: https://developers.openai.com/api/docs/guides/direct-preference-optimization
  - Scope: rolling OpenAI DPO documentation reviewed 2026-11-07.
  - Use: current chosen/rejected preference format and constraints, DPO beta, SFT-before-DPO guidance and provider safety checks.
  - Verified: 2026-11-08; refresh after 7 days.
- **OpenAI Fine Tuning API reference**: https://developers.openai.com/api/reference/resources/fine_tuning
  - Scope: OpenAI Fine Tuning API reference inspected 2026-11-08; the former RFT use-case guide now redirects here, so RFT suitability guidance is treated as retired rather than re-verified.
  - Use: current fine-tuning job, grader and reinforcement-method API surfaces. The reference does not establish RFT task suitability; that judgment must come from the task's own measurable reward.
  - Verified: 2026-11-08; refresh after 7 days.
- **OpenAI model optimization**: https://developers.openai.com/api/docs/guides/model-optimization
  - Scope: rolling OpenAI model-optimization documentation reviewed 2026-11-07.
  - Use: baseline/eval/prompt/fine-tuning decision loop, method boundaries, current fine-tuning transition status and the need to measure representative inputs.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI evals**: https://developers.openai.com/api/docs/guides/evals
  - Scope: rolling OpenAI Evals documentation reviewed 2026-11-07.
  - Use: explicit test-data schemas, reference-label separation, grader-backed runs and the current read-only/shutdown transition for the hosted Evals surface.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI graders**: https://developers.openai.com/api/docs/guides/graders
  - Scope: rolling OpenAI grader documentation reviewed 2026-11-07.
  - Use: item/sample namespaces, deterministic versus model graders, score ranges, grader calibration and reward-hacking controls; the documented transition status is not treated as runtime availability.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI deprecations**: https://developers.openai.com/api/docs/deprecations
  - Scope: OpenAI deprecation page reviewed 2026-11-07; the current 2026-10-14 GPT-4-series notice, 2026-10-01 model notices, 2026-08-26 transcription notice, 2027-01-14 GPT-4-series shutdown and underlying-base-model inference lifetime were checked.
  - Use: authoritative self-serve fine-tuning wind-down and model shutdown schedule. The retrieved page states new training became unavailable to never-before-fine-tuning organizations on 2026-05-07, further eligibility narrowed on 2026-07-02, active existing customers lose new-job creation on 2027-01-06, and fine-tuned GPT-4-series models follow their base-model shutdown; recheck before every plan.
  - Verified: 2026-11-07; refresh after 3 days. This review does not verify any account's eligibility or a live training run. Other entries retain their own verification dates; this is not a blanket source refresh.
- **Hugging Face Transformers PEFT integration**: https://huggingface.co/docs/transformers/en/peft
  - Scope: rolling Transformers PEFT documentation reviewed 2026-11-07.
  - Use: adapter-only training/checkpoint behavior, resume/distributed mechanics, base-model resolution and current adapter serving/hotswap semantics.
  - Verified: 2026-11-07; refresh after 30 days.
- **Hugging Face PEFT checkpoint format**: https://huggingface.co/docs/peft/en/developer_guides/checkpoint
  - Scope: rolling PEFT checkpoint documentation reviewed 2026-11-07.
  - Use: adapter weights/config, base-model identity, safetensors and portable reload requirements.
  - Verified: 2026-11-07; refresh after 30 days.

## Interpretation rules

- Verify the actual provider/account/base-model training eligibility and serving lifetime before designing hosted experiments. A historical fine-tuning example is not evidence that new jobs can still be created.
- Require a measured base-model gap and an evaluation before training. Prefer prompting, retrieval, tools, product logic or a different base model when those solve the problem without changing weights.
- SFT, DPO and RFT optimize different signals. Match the objective to demonstrations, preference pairs or a robust measurable reward rather than selecting an algorithm because it is available.
- Split and deduplicate before optimization, keep the decision holdout out of training/checkpoint selection, and preflight the exact tokenized/serialized examples for silent truncation.
- Audit label leakage separately from duplicate leakage: target labels, references, reward/grader outputs, post-outcome fields and teacher prompts must not become input features or evaluator instructions. Quarantine a contaminated holdout instead of silently deleting observed cases.
- Training loss or reward is not the release metric. Select checkpoints on validation and compare the chosen artifact against the untouched base on target, regression and appropriate safety slices.
- A PEFT adapter is inseparable from its base-model/tokenizer/config identity. Preserve both, prove fresh-process reload, and test merged serving variants rather than assuming equivalence.
- Persist enough data/code/config/checkpoint/runtime provenance to reproduce the model and define an executable rollback that does not depend on retraining.
- Treat hosted evaluator/training surfaces as volatile dependencies. A current documentation page supports planning only; account eligibility, successful training, grader execution, serving, and rollback each need their own receipt.
