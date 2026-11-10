# Source map

`llm-application-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Provider APIs, model identifiers and structured-output/tool behavior change quickly, so any provider-specific contract used by an application must be refreshed against the exact target API before implementation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation; narrower children agentic-systems, prompt-context-engineering, rag-retrieval-systems.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI structured outputs**: https://developers.openai.com/api/docs/guides/structured-outputs
  - Scope: rolling OpenAI API structured-output documentation inspected 2026-10-25.
  - Use: schema-constrained model output, supported schema subset, refusal/streaming/output handling and provider-specific structured-response mechanics.
  - Verified: 2026-11-08; refresh after 14 days.
- **OpenAI function calling**: https://developers.openai.com/api/docs/guides/function-calling
  - Scope: rolling OpenAI API function/tool-calling documentation inspected 2026-10-25.
  - Use: JSON-Schema function definitions and current strict-mode behavior; strict mode requires schema constraints and current API defaults must be rechecked rather than assumed.
  - Verified: 2026-11-08; refresh after 14 days.
- **Claude tool use**: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
  - Scope: rolling Claude Platform tool-use documentation inspected 2026-10-25.
  - Use: client-tool `input_schema`, `tool_use` / `tool_result` round trip, and distinction between client-executed and server-executed tools.
  - Verified: 2026-11-08; refresh after 14 days.
- **Claude prompt caching**: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  - Scope: rolling Claude Platform prompt-caching documentation inspected 2026-10-25.
  - Use: provider-specific evidence that prompt caching is a latency/cost optimization over stable prefixes, with current default 5-minute and optional 1-hour cache lifetimes; it is not durable application memory.
  - Verified: 2026-11-08; refresh after 14 days.
- **NIST AI RMF Generative AI Profile (NIST AI 600-1)**: https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
  - Scope: NIST AI 600-1, published 2024-07-26 and NIST page updated 2026-04-08.
  - Use: cross-sector generative-AI risk identification and lifecycle govern/map/measure/manage framing for application risk and evaluation evidence.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Resolve the exact provider/API/model and feature mode before encoding structured-output, tool, caching or state assumptions.
- Keep provider-specific mechanics behind an application contract; do not pretend OpenAI and Claude tool/structured-output semantics are identical because both accept schemas.
- Model output and tool arguments remain untrusted application input even when a provider offers schema-constrained or strict modes; validate authorization/current state at the action boundary.
- Prompt caching is performance/cost behavior, not durable memory, freshness proof or authorization state.
- Preserve failures across provider/model changes and re-run the product's persisted regression suite whenever a material model/API dependency changes.
