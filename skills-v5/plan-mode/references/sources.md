# Plan-mode sources

Use these references when changing the Plan-mode operating contract, readiness behavior, or discovery requirements. They inform the workflow but do not grant execution authority.

## OpenAI plugin use-case planning

- Source: https://developers.openai.com/plugins/plan/use-case
- Verified: 2026-11-03
- Relevant pattern: define the user's goal, example requests, expected result, required context, capability boundary, safety boundary, and explicit build decisions before implementation.

## OpenAI Codex repository instructions

- Source: https://developers.openai.com/codex/guides/agents-md/
- Verified: 2026-11-03
- Relevant pattern: Codex loads global guidance first, then walks from the project root toward the current directory. It uses one applicable instruction file per directory, with closer guidance appearing later and taking precedence. A plan should reflect the guidance that actually governs the target files rather than generic repository assumptions.

## Agent Skills specification

- Source: https://agentskills.io/specification
- Verified: 2026-11-03
- Relevant contract: keep the entrypoint focused and move conditional or source-sensitive detail into references.

The `KORY_PLAN_READY` marker, Notes synchronization, and no-write Plan interaction behavior are Koryphaios host contracts and must be verified against the local runtime tests rather than inferred from these external sources.
