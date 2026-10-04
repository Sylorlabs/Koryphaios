# Source map

`fine-tuning-training` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Managed fine-tuning availability and supported base models are highly volatile; refresh provider eligibility and deprecation pages immediately before proposing or executing a hosted training run.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI fine-tuning best practices**: https://developers.openai.com/api/docs/guides/fine-tuning-best-practices
  - Scope: rolling OpenAI fine-tuning guidance as available 2026-09-17.
  - Use: current platform wind-down notice, data quality/quantity, train/test separation, prompt inclusion, hyperparameter iteration and training-example token limits/truncation.
  - Verified: 2026-09-17; refresh after 7 days.
- **OpenAI supervised fine-tuning**: https://developers.openai.com/api/docs/guides/supervised-fine-tuning
  - Scope: rolling OpenAI SFT documentation as available 2026-09-17.
  - Use: eval-first workflow, representative datasets, base-model comparison, checkpoint use, overfitting and provider safety-check behavior.
  - Verified: 2026-09-17; refresh after 7 days.
- **OpenAI Direct Preference Optimization**: https://developers.openai.com/api/docs/guides/direct-preference-optimization
  - Scope: rolling OpenAI DPO documentation as available 2026-09-17.
  - Use: current chosen/rejected preference format and constraints, DPO beta, SFT-before-DPO guidance and provider safety checks.
  - Verified: 2026-09-17; refresh after 7 days.
- **OpenAI reinforcement fine-tuning use cases**: https://developers.openai.com/api/docs/guides/rft-use-cases
  - Scope: rolling OpenAI RFT documentation as available 2026-09-17.
  - Use: RFT task suitability, eval-first/base-signal requirements, grader robustness and reward-hacking concerns.
  - Verified: 2026-09-17; refresh after 7 days.
- **OpenAI deprecations**: https://developers.openai.com/api/docs/deprecations
  - Scope: OpenAI deprecation page retrieved 2026-10-02; the self-serve fine-tuning and underlying-model lifetime sections were inspected.
  - Use: authoritative self-serve fine-tuning wind-down. The retrieved page still states new training became unavailable to never-before-fine-tuning organizations on 2026-05-07, further eligibility narrowed on 2026-07-02, and active existing customers lose new-job creation on 2027-01-06; inference remains tied to base-model lifetime. Recheck before every plan.
  - Verified: 2026-10-02; refresh after 3 days. This retrieval does not verify any account's eligibility or a live training run. Other entries retain their own verification dates; this is not a blanket source refresh.
- **Hugging Face Transformers PEFT integration**: https://huggingface.co/docs/transformers/en/peft
  - Scope: rolling Transformers PEFT documentation as available 2026-09-05.
  - Use: adapter-only training/checkpoint behavior, resume/distributed mechanics, base-model resolution and current adapter serving/hotswap semantics.
  - Verified: 2026-09-05; refresh after 30 days.
- **Hugging Face PEFT checkpoint format**: https://huggingface.co/docs/peft/en/developer_guides/checkpoint
  - Scope: rolling PEFT checkpoint documentation as available 2026-09-05.
  - Use: adapter weights/config, base-model identity, safetensors and portable reload requirements.
  - Verified: 2026-09-05; refresh after 30 days.

## Interpretation rules

- Verify the actual provider/account/base-model training eligibility and serving lifetime before designing hosted experiments. A historical fine-tuning example is not evidence that new jobs can still be created.
- Require a measured base-model gap and an evaluation before training. Prefer prompting, retrieval, tools, product logic or a different base model when those solve the problem without changing weights.
- SFT, DPO and RFT optimize different signals. Match the objective to demonstrations, preference pairs or a robust measurable reward rather than selecting an algorithm because it is available.
- Split and deduplicate before optimization, keep the decision holdout out of training/checkpoint selection, and preflight the exact tokenized/serialized examples for silent truncation.
- Training loss or reward is not the release metric. Select checkpoints on validation and compare the chosen artifact against the untouched base on target, regression and appropriate safety slices.
- A PEFT adapter is inseparable from its base-model/tokenizer/config identity. Preserve both, prove fresh-process reload, and test merged serving variants rather than assuming equivalence.
- Persist enough data/code/config/checkpoint/runtime provenance to reproduce the model and define an executable rollback that does not depend on retraining.
