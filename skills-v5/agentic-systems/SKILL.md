---
name: agentic-systems
description: Engineer AI agents with bounded authority, state, delegation, recovery, and independent completion evidence. Use when the model chooses the next action in a tool loop; use llm-application-engineering for fixed inference flows and prompt-context-engineering for prompt construction.
---

# Agentic Systems

Use an agent only when the task benefits from runtime decisions that cannot be represented more safely and predictably as a fixed workflow. The agent may propose the next step, but deterministic code must still own authority, budgets, durable state, side-effect policy, and the definition of acceptable completion.

## Agent workflow

1. **Define the goal and terminal conditions.** State the user-visible objective, explicit non-goals, required evidence, success/failure/blocked states, and what must be true in the external system before the run can finish. Do not let the same agent both mutate consequential state and self-certify success from its own prose.
2. **Choose orchestration intentionally.** Prefer code-driven sequencing when the path is known and predictability matters. Use LLM-directed planning when the task is genuinely open-ended. For multi-agent work, distinguish manager-style specialists from handoffs and make ownership of the final answer/state explicit.
3. **Bound authority outside prompts.** Every tool gets a typed contract, scope, permission decision, and side-effect classification. The agent cannot create new authority by asking for it in text. Require human confirmation/approval immediately before consequential actions when the product contract says humans retain that decision.
4. **Budget the loop.** Set maximum steps/tool calls, wall-clock/cost/token budgets, recursion/delegation depth, and per-tool rate limits. Define what evidence counts as progress so a repeated plan/tool-error cycle terminates rather than burning budget indefinitely.
5. **Reconcile uncertain effects.** Classify each action by whether it reads, repeats safely, requires a precondition, or can duplicate an effect. Persist an operation identity before dispatch. A timeout enters an explicit unknown state, not success or failure. Block redispatch until authoritative readback reconciles the effect; reuse the same operation identity for any permitted retry. If readback is unavailable, retain unknown status and stop that branch.
6. **Treat observations as time-bounded evidence.** Tool results can become stale while the agent reasons. Before mutation, re-read any state whose change would invalidate the action. Preserve provenance and timestamps for observations material to the final decision.
7. **Separate memory classes.** Keep transient working context, durable run state, user/profile memory and external source-of-truth data distinct. Persistent memory needs ownership, provenance, freshness/expiry and deletion rules; model summaries are not a replacement for authoritative state.
8. **Delegate with contracts, not vibes.** A delegated task should specify objective, scope, allowed tools/authority, budget, input evidence, expected artifact, completion test and return format. Specialists do not automatically inherit the manager's external permissions or right to contact users/third parties.
9. **Trace decisions and effects.** Correlate model turn, plan/decision, selected tool/agent, arguments, permission result, external result, retries, handoffs, budget use and final evidence. Keep sensitive data out of traces unless required and appropriately protected.
10. **Verify the world, then stop.** Completion depends on independent observation of required final state, not a final assistant sentence. When evidence is unavailable, return blocked/partial/unverified with the missing proof rather than manufacturing completion.

## Boundaries

For an orchestration deliverable, include the chosen hierarchy and why each specialist changes the decision. Record delegated authority and remaining shared budget so parallel children cannot each spend the whole parent allowance. Bind approvals to the concrete action and revision; reject stale approvals and stale specialist evidence. Demonstrate normal completion, denial, timeout reconciliation, duplicate delivery, exhausted budget, and unavailable evidence through executable cases or explicitly labeled specifications when execution is unavailable. The final handoff must distinguish implemented controls from observed external effects.

For implementation work, persist a compact evidence artifact or trace that records the chosen hierarchy, each delegated scope and authority, the shared budget, stale or timeout reconciliation, memory provenance when memory is used, and the independent completion oracle. Code structure alone does not prove those controls were exercised. If the task does not permit exercising a required control, record that limitation explicitly instead of presenting the implementation as verified.

- `llm-application-engineering` owns bounded inference/tool contracts and deterministic product behavior. This skill begins where the model chooses among multiple future actions or agents over an evolving run.
- `prompt-context-engineering` owns prompt/context construction and optimization; this skill owns loop, state, authority, delegation, budgets and completion.
- `authorization-security` owns deeper authorization-policy analysis; this skill must enforce the resulting permissions at every action boundary.
- `llm-evaluation` / `ml-evaluation` own benchmark and judge methodology; this skill owns scenario-level agent behavior and uses those evals as release evidence.
- `ai-safety-evaluation` owns dedicated safety/red-team assessment; this skill owns operational control surfaces such as approvals, tool scope and termination.

Use [the maintained source map](references/sources.md) for current orchestration/runtime patterns. Provider SDK primitives are examples, not universal contracts; preserve these invariants even when the runtime changes.
