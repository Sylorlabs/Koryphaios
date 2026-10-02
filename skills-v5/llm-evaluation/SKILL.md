---
name: llm-evaluation
description: Evaluate LLM and agent behavior using held-out tasks, matched baselines, independent graders, uncertainty, and regression evidence. Use when measuring or comparing generative behavior rather than implementing it; use ml-evaluation for predictive models and ai-safety-evaluation for dedicated safety or red-team measurement.
---

# LLM Evaluation

An eval is a measurement instrument. Make the decision, population, experimental conditions, grader validity and uncertainty explicit before interpreting a score.

## Workflow

1. **State the decision and evaluation unit.** Name the candidate, baseline, release/no-release or selection decision, target task distribution, primary metrics and required slices. Decide whether a unit is one prompt/answer, an entire tool-using trajectory, a conversation, or a completed environment state. Do not let one easy aggregate stand in for the actual product decision.
2. **Version the dataset before optimizing.** Track case IDs, source/provenance, annotations, creation method, difficulty/slice labels and dataset revision. Separate development/calibration data from an immutable decision holdout. Mine production failures and expert cases where appropriate, but remove sensitive data and document sampling bias. Keep synthetic cases labeled as synthetic.
3. **Control contamination and adaptive overfitting.** Do not put held-out answers, grader labels or hidden cases in prompts, examples, retrieval corpora, optimization traces or fine-tuning data. If the team repeatedly inspects a holdout while tuning, retire or quarantine it as development data and create a fresh decision set.
4. **Normalize candidate and baseline conditions.** Record model/provider snapshot, prompt/template revision, tool schemas/permissions, retrieval/corpus revision, context, decoding settings, max tokens, timeout/retry policy, sandbox/environment image and other infrastructure that can change outcomes. Compare candidates on the same cases and equivalent resources unless the resource difference is itself the experimental variable.
5. **Prefer direct outcome checks.** Use exact/schema/code/unit-test/environment-state/tool-argument or other deterministic graders wherever they faithfully measure success. For agents, grade the final external state separately from trajectory quality; a plausible final message is not evidence that the tool action succeeded.
6. **Use model judges only for irreducibly semantic criteria.** Give each judge a narrow rubric, sufficient reference evidence and an explicit unknown/insufficient-evidence path. Prefer pairwise or discrete criterion judgments when they are more reliable than unconstrained numeric scores. Blind candidate identity/order when feasible and avoid letting the authoring model grade its own intended answer without independent calibration.
7. **Calibrate every consequential automated grader.** Build a calibration set with blind expert/human labels spanning clear passes, clear failures and hard boundary disagreements. Measure agreement/confusion by criterion, inspect false accepts and false rejects, and revise or reject graders that do not meet the predeclared agreement threshold. Periodically recheck calibration when the judge model, rubric or task distribution changes.
8. **Measure stochasticity instead of hiding it.** When outputs are nondeterministic, run enough independent trials to estimate the metric at the task level, preserve all attempts, and report uncertainty or paired resampling/intervals appropriate to the decision. Do not compare a candidate's best attempt against a baseline's first attempt.
9. **Classify failures against the declared boundary.** Broken fixtures, corrupt references, and grader failures can invalidate a measurement. Product/provider errors, unavailable tools, or timeouts remain scored failures when availability or deadline compliance is part of the evaluated system. Predeclare attribution, retry, and exclusion rules; preserve all attempts and invalid counts symmetrically. Do not excuse real product failures as harness noise or score broken infrastructure as model incapability.
10. **Inspect slices and disagreements.** Report the primary aggregate together with predeclared slices, worst regressions, grader disagreement and representative traces/artifacts. Preserve every genuine production/eval failure as a regression case unless privacy, leakage or duplication rules require a sanitized equivalent.
11. **Blind the final comparison.** For consequential quality claims, randomize candidate labels/order for an independent evaluator and separate implementation authorship from final adjudication. A superiority claim requires comparable conditions, a valid held-out population, calibrated graders and uncertainty consistent with the claimed margin.

## Boundaries

- `ml-evaluation` owns evaluation methodology for non-generative predictive/statistical ML systems. Both disciplines inherit shared testing and data-analysis principles; a generative evaluation need not load predictive-only calibration or classification procedures.
- `ai-safety-evaluation` owns dedicated harmful-capability, misuse, policy, jailbreak and red-team risk evaluation. This skill can supply general experimental rigor without replacing that specialty.
- `agentic-systems` owns agent planning, tools, memory, delegation and authorization. This skill evaluates those behaviors and trajectories but does not design the orchestration architecture.
- `prompt-context-engineering`, `rag-retrieval-systems`, `fine-tuning-training` and `llm-application-engineering` own candidate changes in their respective systems. Keep the decision holdout independent of the optimization loop.
- `verification` proves a particular implementation or artifact meets its contract. `llm-evaluation` owns comparative/representative measurement across variable model behavior.

Use [the maintained source map](references/sources.md) for provider evaluation surfaces. Platform APIs change quickly; the measurement contract above should remain portable when a provider retires an eval product.
