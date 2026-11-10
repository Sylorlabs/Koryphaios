# Source map

`agentic-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Agent runtimes and provider SDK primitives evolve quickly; orchestration details must be refreshed against the target runtime, while authority, idempotency, bounded loops, traceability and external completion evidence remain provider-independent requirements.

## Qualification requirements

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader llm-application-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

These are required checks, not a record of completed runs. See [local evaluation coverage](../evals/README.md) for the synthetic evaluator boundary and the runtime evidence still needed.

The two OpenAI Agents SDK entries below were rechecked on **2026-10-16**. They remain rolling documentation; confirm the source revision and target runtime behavior before making a freshness-dependent claim.

## Maintained sources

- **OpenAI Agents SDK**: https://openai.github.io/openai-agents-python/
  - Scope: rolling OpenAI Agents SDK documentation as available 2026-10-16.
  - Use: current runtime primitives for agents, function tools, guardrails, handoffs/agents-as-tools, sessions, human-in-the-loop and tracing.
  - Verified: 2026-10-16; refresh after 14 days.
- **OpenAI Agents SDK: Agent orchestration**: https://openai.github.io/openai-agents-python/multi_agent/
  - Scope: rolling orchestration guidance as available 2026-10-16.
  - Use: distinction between LLM-directed and code-directed orchestration and current manager-as-tool versus handoff patterns.
  - Verified: 2026-10-16; refresh after 14 days.
- **Anthropic: Trustworthy agents in practice**: https://www.anthropic.com/research/trustworthy-agents
  - Scope: Anthropic research article published 2026-04-09.
  - Use: current operational framing for autonomous plan/act/observe loops, human control, approval boundaries and layered prompt-injection/tool-scope defenses.
  - Verified: 2026-09-05; refresh after 90 days.
- **NIST AI RMF Generative AI Profile (NIST AI 600-1)**: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
  - Scope: NIST AI 600-1, published 2024-07-26; NIST page updated 2026-04-08.
  - Use: lifecycle risk mapping/measurement/management and evidence discipline for generative-AI systems.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Prefer code-driven orchestration when a fixed graph satisfies the product; autonomy should justify its additional failure/authority surface.
- Runtime guardrails, tool schemas and handoffs do not replace application-enforced permissions or human approval where required.
- On timeout/uncertain mutation outcome, reconcile external state before retrying; an agent's belief about whether a tool ran is not authoritative.
- Delegation is a scope/authority/budget contract. Specialist agents do not inherit manager permissions by default.
- Completion requires independent evidence from the external system or a declared blocked/unverified outcome, never only the agent's self-report.
