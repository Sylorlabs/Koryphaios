# Fine-tuning training: local evidence boundary

Run from the repository root with the locked Bun toolchain:

```sh
bun test skills-v5/fine-tuning-training/evals/fixture-integrity.test.ts
```

This offline check validates the package, source-map freshness, authored routing cases through the real resolver, and the two registered synthetic model-data scorers. It does not submit a training job, access a provider account, tokenize a real corpus, calibrate a live grader, run a GPU/runtime, reload a real adapter, measure production serving, or exercise rollback. Those are promotion prerequisites and must remain reported as unavailable until observed.

The synthetic scorer checks are negative controls for the contract: an incomplete candidate must fail without being treated as evaluator tampering, and changing fixed evaluator inputs must fail closed as an integrity error. They do not establish model uplift, data cleanliness in an external corpus, or qualification evidence.

## Evidence to retain when real execution is available

- Training contract: measured base failure, alternative-intervention decision, objective, metric, non-regression bounds, safety slices, serving budgets, promotion rule, and rollback target.
- Data audit: authorization/license/PII decision, source and entity IDs, label and teacher provenance, exact/normalized/semantic deduplication, split manifests, contamination findings, and tokenizer/serialization receipts.
- Run identity: provider/account eligibility, base revision, tokenizer/template, code/container/runtime, seed, hyperparameters, trainable-parameter audit, checkpoint and validation selection record.
- Final comparison: untouched holdout, normalized base-versus-adapted settings, raw outputs, slice metrics and uncertainty, fresh-process reload, serving measurements, and an exercised rollback receipt.

Keep simulated, unavailable, stale, inferred, and unresolved evidence distinct from executed receipts. Paired same-model runs and independent blind review remain part of the official evaluation process; this local check does not grant promotion.
