# Source map

`llm-evaluation` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Provider eval products, grader APIs and recommended judge models change quickly; keep the measurement design portable and refresh surfaces specific to each provider before implementation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis, testing-engineering.
- Routing: five positive, five negative cases for neighboring skills, three compound/ambiguous, and three adversarial cases reserved for routing tests through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, paired skill and baseline runs on the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI evaluation best practices**: https://developers.openai.com/api/docs/guides/evaluation-best-practices
  - Scope: rolling OpenAI evaluation guidance inspected 2026-11-07.
  - Use: representative evals for each task, edge/adversarial cases, automated grading, human calibration, continuous evaluation and model judge design. This source supports measurement design; verify product lifecycle separately rather than inferring a platform retirement timeline from it.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI graders**: https://developers.openai.com/api/docs/guides/graders
  - Scope: rolling OpenAI grader documentation as available 2026-11-07; grader examples belong to a legacy Evals transition surface.
  - Use: current deterministic/text/model grader categories, grader calibration iterations, semantic grader constraints and warnings about grader manipulation and reward hacking.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI agent evals**: https://developers.openai.com/api/docs/guides/agent-evals
  - Scope: rolling OpenAI evaluation guidance for agents as available 2026-11-07.
  - Use: traces, grading outcomes across a workflow, datasets and repeatable eval runs for agents that invoke tools.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI deprecations**: https://developers.openai.com/api/docs/deprecations
  - Scope: official OpenAI platform lifecycle table inspected 2026-11-07.
  - Use: legacy Evals platform is scheduled to prohibit writes on 2026-10-31; the Evals dashboard/API are scheduled to shut down 2026-11-30. Grader examples under legacy Evals are part of this transition. Confirm a supported replacement before building a new implementation around them.
  - Verified: 2026-11-07; refresh after 14 days.
- **OpenAI cookbook: Moving from OpenAI Evals to Promptfoo**: https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo
  - Scope: migration guide published 2026-06-03, inspected 2026-10-10.
  - Use: translate legacy eval prompts, cases and graders into a portable configuration. Validate recreated graders against known controls because different scoring implementations need not yield identical numeric results.
  - Verified: 2026-10-10; refresh after 90 days.
- **OpenAI/deepsense.ai cookbook:** `Harness-aware evaluation of plugins`: https://developers.openai.com/cookbook/examples/partners/harness_aware_plugin_evals/harness_aware_plugin_evals
  - Scope: cookbook published 2026-09-23, inspected 2026-10-10.
  - Use: run the same cases at standalone and actual application harness levels; preserve tool traces, permission context and final external state so a product integration failure is not hidden by a standalone model pass.
  - Verified: 2026-10-10; refresh after 90 days.
- **Claude: define success criteria and build evaluations**: https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
  - Scope: rolling Claude Platform evaluation documentation as available 2026-10-04.
  - Use: fidelity to the target task distribution, edge cases and graders for code checks, exact matches, semantic criteria and model judgments.
  - Verified: 2026-11-03; refresh after 30 days.
- **Anthropic: Demystifying evals for AI agents**: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - Scope: Anthropic engineering guidance published 2026-01-09.
  - Use: task/grader/harness separation, deterministic outcome graders, calibrated LLM judges, repeated trials in agent evaluation, transcript inspection and diagnosing infrastructure failures.
  - Verified: 2026-09-06; refresh after 90 days.
- **`NIST AI 600-1` Generative AI Profile**: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
  - Scope: NIST Generative AI Profile, July 2024.
  - Use: lifecycle measurement, internal/external evaluation, assurance thresholds and continual improvement of risk measurement for generative AI.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Define the decision, target distribution and unit of analysis before choosing metrics or graders.
- Keep development/calibration data separate from a decision holdout. A repeatedly inspected "holdout" becomes development data; do not preserve the label while continuing to optimize against it.
- Prefer deterministic evidence that directly reflects task success. Use semantic judges only for criteria that cannot be faithfully automated, and calibrate them against independent labels before trusting scale.
- Normalize candidate/baseline prompts, context, tools, retrieval, environment, budgets, retry policy and other infrastructure unless the difference is the explicit experimental variable.
- Preserve repeated stochastic attempts, invalid infrastructure attempts, grader disagreements and slices measured per task. Do not hide these behind one aggregate percentage.
- Adopt Anthropic's separation of task, agent harness, evaluation harness, and observed outcome. Adapt failure attribution to the declared product boundary; reject automatically excluding every timeout or provider error. This attribution policy is an engineering application of the source, not a scoring formula prescribed by the provider.
- Blind consequential comparisons and keep the implementation author separate from final adjudication where practical. A claimed improvement must fit the uncertainty, contamination status and grader validity of the experiment.
- For agent plugins, skill invocations and MCP products, test the actual shipping harness. Match tool schemas/permission boundary, case inputs, prompts and judge rubric when comparing skill and baseline or alternative models.
- Treat documentation for a deprecated execution surface as methodological background until its current lifecycle and migration path are verified. For OpenAI, select active Datasets or trace grading where they meet the evaluation contract; avoid assuming they reproduce every legacy Evals API feature.
