# Source map

`prompt-context-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Prompting guidance and context-window behavior are model/provider-sensitive; refresh rolling provider documentation before applying any message-role, model-specific prompting, prompt-management or context-limit claim to a live integration.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader llm-application-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI prompt engineering**: https://developers.openai.com/api/docs/guides/prompt-engineering
  - Scope: rolling OpenAI API prompt-engineering documentation inspected 2026-10-25.
  - Use: current message-role/instruction-priority behavior, prompt structuring, examples, context-window planning and code-managed prompt versioning.
  - Verified: 2026-11-08; refresh after 14 days.
- **OpenAI prompting**: https://developers.openai.com/api/docs/guides/prompting
  - Scope: rolling OpenAI API prompting documentation inspected 2026-10-25.
  - Use: production prompt-as-code, typed dynamic inputs, prompt testing and release/change-management guidance.
  - Verified: 2026-11-08; refresh after 14 days.
- **OpenAI Model Spec 2026-08-18**: https://model-spec.openai.com/2026-08-18.html
  - Scope: versioned OpenAI Model Spec dated 2026-08-18.
  - Use: OpenAI-specific chain of command and the distinction between authoritative instructions and quoted/untrusted/tool content. Do not assume another provider implements the same hierarchy.
  - Verified: 2026-09-05; refresh after 90 days or when a newer applicable spec is selected.
- **Claude prompting best practices**: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
  - Scope: rolling Claude Platform guidance for current Claude models inspected 2026-10-25.
  - Use: current model-specific versus general prompting guidance, clarity, examples, structural tags and long-context placement patterns.
  - Verified: 2026-11-08; refresh after 14 days.
- **Claude context windows**: https://platform.claude.com/docs/en/build-with-claude/context-windows
  - Scope: rolling Claude Platform context-window documentation inspected 2026-10-25.
  - Use: what contributes to request context, token accounting, context-limit outcomes and current provider compaction/context-awareness behavior.
  - Verified: 2026-11-08; refresh after 14 days.
- **Claude prompting tools: templates and variables**: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-tools
  - Scope: rolling Claude Platform prompt tooling documentation as available 2026-10-04.
  - Use: fixed versus variable prompt content, reusable templates, variable separation, testability and version-control rationale.
  - Verified: 2026-11-03; refresh after 30 days.

## Interpretation rules

- Resolve the provider, model/snapshot, API surface and message-role semantics before applying provider-specific prompt advice.
- Treat dynamic user/retrieved/tool content as data unless the host contract explicitly grants it authority; delimiters improve structure but are not an authorization boundary by themselves.
- Context-window size is a capacity constraint, not a quality guarantee. Preserve output headroom and test the actual long-context/truncation behavior of the selected model and application.
- Prompt examples are behavioral demonstrations, not benchmark evidence. Keep held out evaluation fixtures out of the prompt and record example provenance when contamination is plausible.
- Prefer the smallest prompt change that fixes a measured failure, and preserve the failure as a regression case across later model or prompt revisions.
