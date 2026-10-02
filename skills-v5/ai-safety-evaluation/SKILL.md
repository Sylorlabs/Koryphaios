---
name: ai-safety-evaluation
description: Evaluate AI safety claims using bounded adversarial scenarios and benign utility controls. Use when assessing AI red teaming, prompt injection, tool abuse, harmful capability, or safeguard robustness; not for ordinary application vulnerabilities or general model quality benchmarks.
---

# AI Safety Evaluation

Evaluate the deployed AI **system**, not an isolated prompt. Treat the model, system/developer instructions, tools, memory, retrieved content, permissions, surrounding controls, retries, budgets, and human approval points as part of the tested configuration whenever they can change the safety claim.

## Workflow

1. **State the claim and boundary.** Name the harm or safety property being tested, the affected actor or asset, the exact tested system/configuration, and whether the claim concerns dangerous capability, safeguard robustness, or deployment behavior. Record attacker access, knowledge, attempts, budget, and prerequisites rather than assuming an omnipotent attacker.
2. **Build a risk-to-scenario matrix.** Select scenarios from the actual threat model: harmful or prohibited assistance, direct/indirect prompt injection, tool or authority abuse, data exfiltration, unsafe delegation/autonomy, deceptive or misleading behavior, unsafe recovery, or another concrete system-specific harm. Include realistic multi-step paths when the product is agentic.
3. **Pair adversarial cases with controls.** For every safety slice, include benign tasks that should continue to work. Where possible use canary data, synthetic accounts, reversible side effects, and explicit allow/deny ground truth so a mitigation cannot “pass” merely by refusing everything.
4. **Define oracles before running.** Prefer deterministic state and policy checks for authorization, secret disclosure, tool effects, and task completion. Calibrate semantic/model graders against labeled examples; never make refusal rate or an uncalibrated model judge the sole safety oracle.
5. **Run under a defensible harness.** Match the harness and elicitation strength to the claim. Preserve model/revision, prompts, safeguards, tools, seeds where supported, attempt count, token/time/cost budget, traces, scorer versions, and environment state. For safeguard claims, exercise the strongest credible attack within the declared adversary budget rather than only obvious one-shot prompts.
6. **Analyze validity and severity.** Report attack success and benign utility separately, slice by risk/prerequisite, and check for broken tasks, contamination, evaluator leakage, reward/scorer hacking, refusal artifacts, and evaluation awareness when relevant. Describe severity and exploit prerequisites; do not collapse distinct risks into one “safety score.”
7. **Compare one deliberate intervention.** Bind both arms to the same model, prompts, tools, harness, scorer, data, attempt allowance and resource budget except for the declared mitigation. Compare configuration values structurally: object key order is not drift, but missing fields or changed budgets are. Exclude incompatible pairs from improvement estimates and explain why. Compute attack success on eligible adversarial cases and utility or false refusal on eligible benign cases separately, retaining denominators and exclusions. Never offset a safety failure with utility gain.
8. **Verify mitigations as regressions.** Run the same adversarial and benign controls after relevant changes. Preserve confirmed failures and paired trace artifacts. Report calibration disagreements against labeled examples, agreement by risk slice, residual risk, unavailable checks, and differences between the harness and production.

Deliver the risk and claim matrix, attacker access and attempt budget, scenario table with expected outcomes, configuration comparison, oracle versions, calibration evidence and both arms of each claimed comparison. A scorer implementation or aggregate alone does not establish that the evaluation was run. Review leakage, contamination, selection effects and evaluator awareness before interpreting gains. Label design only, simulated and unavailable evidence in the deliverable itself.

## Boundaries and stop conditions

- Use `llm-evaluation` for general capability/quality benchmarks whose target is not a safety or harm claim.
- Use application/security verification skills for ordinary authentication, authorization, injection, or isolation defects when AI behavior is incidental rather than the object of evaluation.
- Use `privacy-engineering` for data collection, purpose, retention, consent, and deletion work; compose it here only when privacy harm is being measured as an AI-system safety outcome.
- Do not infer authorization from an evaluation prompt. Keep adversarial testing inside the approved environment and use synthetic/canary targets where practical.
- Do not publish operationally sensitive attack material beyond the authorized audience. If realistic execution would create material harm or unauthorized access, stop at a safe simulation and label the evidence as simulated.

Use [the maintained source map](references/sources.md) for current risk taxonomies, evaluation-validity guidance, red-team methodology, and benchmark patterns.
