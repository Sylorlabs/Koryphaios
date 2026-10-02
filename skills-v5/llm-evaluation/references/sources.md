# Source map

`llm-evaluation` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Provider eval products, grader APIs and recommended judge models change quickly; keep the measurement design portable and refresh provider-specific surfaces before implementation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis, testing-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI evaluation best practices**: https://developers.openai.com/api/docs/guides/evaluation-best-practices
  - Scope: rolling OpenAI evaluation guidance inspected 2026-09-06.
  - Use: task-specific representative evals, edge/adversarial cases, automated grading, human calibration, continuous evaluation and LLM-judge design. This source supports measurement design; verify product lifecycle separately rather than inferring a platform retirement timeline from it.
  - Verified: 2026-09-06; refresh after 14 days.
- **OpenAI graders**: https://developers.openai.com/api/docs/guides/graders
  - Scope: rolling OpenAI grader documentation as available 2026-09-19.
  - Use: current deterministic/text/model grader categories, grader-eval iteration, semantic grader constraints and grader/reward-hacking warnings.
  - Verified: 2026-09-19; refresh after 14 days.
- **OpenAI agent evals**: https://developers.openai.com/api/docs/guides/agent-evals
  - Scope: rolling OpenAI agent-evaluation guidance as available 2026-09-19.
  - Use: traces, workflow-level grading, datasets and repeatable eval runs for tool-using agents.
  - Verified: 2026-09-19; refresh after 14 days.
- **Claude: define success criteria and build evaluations**: https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
  - Scope: rolling Claude Platform evaluation documentation as available 2026-09-05.
  - Use: task-distribution fidelity, edge cases and code/exact/semantic/model-based grading patterns.
  - Verified: 2026-09-05; refresh after 30 days.
- **Anthropic: Demystifying evals for AI agents**: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - Scope: Anthropic engineering guidance published 2026-01-09.
  - Use: task/grader/harness separation, deterministic outcome graders, calibrated LLM judges, multi-trial agent evaluation, transcript inspection and infrastructure-failure diagnosis.
  - Verified: 2026-09-06; refresh after 90 days.
- **NIST AI 600-1 Generative AI Profile**: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
  - Scope: NIST Generative AI Profile, July 2024.
  - Use: lifecycle measurement, internal/external evaluation, assurance thresholds and continual improvement of generative-AI risk measurement.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Define the decision, target distribution and unit of analysis before choosing metrics or graders.
- Keep development/calibration data separate from a decision holdout. A repeatedly inspected "holdout" becomes development data; do not preserve the label while continuing to optimize against it.
- Prefer deterministic evidence that directly reflects task success. Use semantic judges only for criteria that cannot be faithfully automated, and calibrate them against independent labels before trusting scale.
- Normalize candidate/baseline prompts, context, tools, retrieval, environment, budgets, retry policy and other infrastructure unless the difference is the explicit experimental variable.
- Preserve repeated stochastic attempts, invalid infrastructure attempts, grader disagreements and task-level slices. Do not hide these behind one aggregate percentage.
- Adopt Anthropic's separation of task, agent harness, evaluation harness, and observed outcome. Adapt failure attribution to the declared product boundary; reject automatically excluding every timeout or provider error. This attribution policy is an engineering application of the source, not a provider-prescribed scoring formula.
- Blind consequential comparisons and keep the implementation author separate from final adjudication where practical. A claimed improvement must fit the uncertainty, contamination status and grader validity of the experiment.
