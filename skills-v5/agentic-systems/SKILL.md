---
name: agentic-systems
description: Engineer AI agents with bounded authority, state, delegation, recovery, and independent completion evidence. Use when the model chooses the next action in a tool loop; use llm-application-engineering for fixed inference flows and prompt-context-engineering for prompt construction.
---

# Agentic Systems

Use an agent only when the task benefits from runtime decisions that cannot be represented more safely and predictably as a fixed workflow. The agent may propose the next step, but deterministic code must still own authority, budgets, durable state, side effect policy, and the definition of acceptable completion.

When implementing a supplied executable evaluator or orchestration fixture, extract its actual input and output contract before designing the general system. Read the **exact field paths, types, absence semantics, rejection precedence, and terminal state rules** from the supplied interface and representative input cases. Map each required input field to the code that consumes it. Use the supplied names exactly: for example, `declaredScope` and `requestedScope` are distinct contract fields, and `specialist.scope` is not a valid substitute when the fixture declares `specialist.declaredScope`. An adjacent sounding property or inferred alias is not interchangeable with a declared field; a plausible algorithm reading the wrong field is incorrect. Test against the **provided** normal, negative and contradictory cases before relying on invented examples. If those cases cannot run, record that gap explicitly rather than treating self authored tests as proof of compatibility.

## Agent workflow

1. **Define the goal and terminal conditions.** State the objective visible to the user, explicit non goals, required evidence, success/failure/blocked states, and what must be true in the external system before the run can finish. Do not let the same agent both mutate consequential state and self certify success from its own prose.
2. **Choose orchestration and the next tool from current evidence.** Prefer code driven sequencing when the path is known. When the next action depends on observations, enumerate available tool contracts, map each unresolved goal predicate to a permitted read or action, check prerequisites, then choose the call with the least authority that reduces uncertainty or advances the goal. Discover a missing tool's actual schema before planning to call it; never invent capabilities. Replan when the observed state changes, not by repeating a failing tool with unchanged inputs. For multi agent work, distinguish manager style specialists from handoffs and keep ownership of the final answer/state explicit.
3. **Bound authority outside prompts.** Every tool gets a typed contract, scope, permission decision, and side effect classification. The agent cannot create new authority by asking for it in text. Require human confirmation/approval immediately before consequential actions when the product contract says humans retain that decision. Bind approval to action, resource, arguments and observed revision; a new target or revision requires a new decision.
4. **Budget the loop.** Set maximum steps/tool calls, wall clock/cost/token budgets, recursion/delegation depth, and rate limits per tool. Charge failed calls, retries, reconciliation reads and delegated work against the parent budget; reserve capacity for verification. Define what evidence counts as progress so a repeated plan or tool error cycle terminates rather than burning budget indefinitely.
5. **Reconcile uncertain effects.** Classify each action by whether it reads, repeats safely, requires a precondition, or can duplicate an effect. Persist the logical operation identity and expected revision _before_ dispatch, separate from attempt number. A timeout enters an explicit `unknown` state, not success or failure. Block redispatch until authoritative readback reconciles the effect; reuse the same operation identity for any permitted retry, subject to the tool's actual deduplication guarantee. If readback is unavailable or inconclusive, retain `unknown` and stop that branch.
6. **Treat observations as evidence bounded by time.** Tool results can become stale while the agent reasons or waits for approval. Immediately before mutation, read again any state whose change would invalidate the action; if the target revision changed, invalidate the plan and prior approval before choosing a new action. Where supported, pass the expected revision as an atomic write precondition; a read followed by an unconditional write still has a race. Record any remaining race when the tool cannot enforce that precondition. Preserve provenance and timestamps for observations material to the final decision.
7. **Separate memory classes.** Keep transient working context, durable run state, user/profile memory and external source of truth data distinct. Persistent memory needs ownership, provenance, freshness/expiry and deletion rules; model summaries are not a replacement for authoritative state.
8. **Delegate with contracts, not vibes.** A delegated task should specify objective, scope, allowed tools/authority, budget, input evidence, expected artifact, completion test and return format. Specialists do not automatically inherit the manager's external permissions or right to contact users/third parties. On resume, preserve valid completed work and revalidate partial/stale work; resolve conflicting child conclusions by inspecting cited primary evidence rather than letting the children vote.
9. **Trace decisions and effects.** Correlate model turn, plan/decision, selected tool/agent, arguments, permission result, external result, retries, handoffs, budget use and final evidence. Keep sensitive data out of traces unless required and appropriately protected.
10. **Verify the world, then stop.** Use an oracle that only reads, independent of the mutating tool or proposing specialist, check freshness and the intended revision, and evaluate every required terminal predicate. A write receipt or an agent's final sentence cannot substitute for that observation. When evidence is unavailable, inconsistent, stale or still `unknown`, return blocked/partial/unverified with the missing proof rather than manufacturing completion.

### Verification state is revision and mutation bound

Treat completion evidence as a replaceable record, not a historical flag. Keep the
current observed revision and an evidence generation that advances at every fresh
observation and every permitted mutation attempt. A prior healthy result is valid
only for that exact observed revision and generation.

- Only a fresh `observe` event may advance `latestObservedRevision`. A `verify`
  event is read only: it may never create, advance, or replace the observation
  that defines the current revision. A verify-only trace therefore cannot
  manufacture a current target or completion.
- A fresh verification is accepted only when it matches the current observed
  revision and current evidence generation. Replace the stored verification for
  that generation rather than combining it with historical health. A fresh
  `healthy: false` result clears any prior healthy state and keeps completion
  blocked until a later fresh healthy verification passes.
- A permitted mutation attempt and every fresh observation invalidate the prior
  completion verification before the next terminal decision. A mutation receipt
  does not restore it. Read again and independently verify after the new generation;
  do not reuse a healthy result from before the mutation or observation.
- A timeout remains `unknown` until a matching fresh verification clears the
  uncertainty. That verification may be unhealthy, in which case uncertainty is
  resolved but completion still fails. A mismatched, stale, or unavailable
  verification cannot clear either the stale evidence or completion gate.

### Reconcile JSON identifiers by value

Action and revision identifiers often arrive through separate JSON parses. Treat
them as JSON values, not JavaScript object references: compare primitives by
value, compare arrays recursively in order, and compare objects recursively with
key order ignored. Preserve the distinction between a missing field and an
explicit `null`. The same structural comparison must be used when correlating a
request with a result, an approval with an action, or evidence with a revision;
  `===` is not a valid equality rule for object-valued JSON identifiers.

### Label the evidence boundary and retain scenario traces

The registered individual exercises provide a pure `solve(input)` contract, not
live authority or a running agent. When that is the available environment, label
each unexecuted obligation explicitly as `unverified`, including **live
authority**, **recovery**, **tool integration**, and the **external completion
oracle**. Assign an owner and name the missing proof. A synthetic input, source
example, scorer result, or agent prose must not be relabeled as a live receipt.

For every required negative or recovery path, retain one trace row with the
event sequence, current revision/evidence generation, approval or scope
decision, operation identity when relevant, budget charge, state transition,
  terminal decision, observed result, and missing evidence field. Use
`observedResult: null` and `executionStatus: unverified` when the runtime was not
  executed. The package local trace fixture at
[`evals/fixtures/trace-evidence.json`](evals/fixtures/trace-evidence.json)
defines this boundary for denied approval, deployment races, timeout recovery,
  no progress termination, unavailable oracles, events that only verify, invalidated
health, delegation rejection, resume, stale memory, and conflicting evidence.

For the registered pure execution state exercise, the deliverable must include
an evidence artifact with these top level fields: `executionStatus`,
`observedResult`, `evidenceBoundary.unverifiedObligations`, and `traces`. Every
trace row must include the scenario id, ordered event steps, current revision,
evidence generation, authority or scope decision, budget charge, state
transition, terminal decision, observed result, and missing proof. Use one
`currentGeneration` value as the final completion gate: increment it on every
fresh observation and permitted mutation, clear the stored verification, and
accept verification only when both revision and generation equal the current
values. A generation counter that is recorded but not compared at the terminal
decision is not verification evidence.

## Decisions that change the run

| Observation during execution                                           | Required next decision                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A service is already healthy                                           | Skip remediation; check health independently before claiming success.                                                                                   |
| A deployment changes while approval is pending                         | Replan for the current revision and seek approval for the revised action.                                                                               |
| A mutation times out after dispatch                                    | Record `unknown`; read its operation status/external state before deciding whether a retry is safe.                                                     |
| A tool repeatedly errors without new evidence                          | Stop the branch within budget; report the missing observation or alternative permitted tool.                                                            |
| A resumed specialist already has a current, complete evidence artifact | Reuse it; do not rerun that specialist just because the manager resumed.                                                                                |
| Bounded specialists agree on a conclusion                              | Validate each artifact and primary source at the current revision, then independently verify the manager's terminal predicates before marking complete. |
| A specialist times out, requests wider scope, or cites stale memory    | Deny unapproved scope, keep incomplete work partial, and exclude stale memory from the verdict; resume only within remaining authority and budget.      |
| Specialists disagree, or memory conflicts with fresh evidence          | Inspect primary evidence; leave the conclusion unresolved when it cannot settle the dispute.                                                            |

Use [the execution decision runbooks](references/execution-decisions.md) for concrete remediation and delegated investigation sequences, operation states, and verification gates.

## Boundaries

For an orchestration deliverable, include the chosen hierarchy and why each specialist changes the decision. Record delegated authority and remaining shared budget so parallel children cannot each spend the whole parent allowance. Bind approvals to the concrete action and revision; reject stale approvals and stale specialist evidence. Demonstrate normal completion, denial, timeout reconciliation, duplicate delivery, exhausted budget, and unavailable evidence through executable cases or explicitly labeled specifications when execution is unavailable. The final handoff must distinguish implemented controls from observed external effects. If live authority, recovery, tool integration, or an external completion oracle was not executed, list that obligation as `unverified` rather than implying coverage from a synthetic evaluator.

For implementation work, persist a compact evidence artifact or trace that records the chosen hierarchy, each delegated scope and authority, the shared budget, stale or timeout reconciliation, memory provenance when memory is used, and the independent completion oracle. Code structure alone does not prove those controls were exercised. If the task does not permit exercising a required control, record that limitation explicitly instead of presenting the implementation as verified.

Preserve any supplied executable evaluator contract exactly before adding broader orchestration machinery. For a bounded, pure manager/specialist evidence evaluator, honor the input fields, output shape, rejection reasons, ordering, and terminal state precedence defined by that contract. Judge each specialist independently: accept only current, successful, in scope results with an artifact; reject a widened scope, timeout, stale revision, or missing artifact with its specified reason. Stale memory is excluded from the verdict; it does not veto otherwise valid current specialist evidence. Matching non null conclusions from accepted specialists can complete the evaluator, contradictory conclusions require review, and no accepted specialists leave it blocked. Apply additional runtime safety or external verification requirements only where the requested interface calls for them; never silently change a deterministic contract's results.

- `llm-application-engineering` owns bounded inference/tool contracts and deterministic product behavior. This skill begins where the model chooses among multiple future actions or agents over an evolving run.
- `prompt-context-engineering` owns prompt/context construction and optimization; this skill owns loop, state, authority, delegation, budgets and completion.
- `authorization-security` owns deeper authorization policy analysis; this skill must enforce the resulting permissions at every action boundary.
- `llm-evaluation` / `ml-evaluation` own benchmark and judge methodology; this skill owns agent behavior at the scenario level and uses those evals as release evidence.
- `ai-safety-evaluation` owns dedicated safety and red team assessment; this skill owns operational control surfaces such as approvals, tool scope and termination.

Use [the maintained source map](references/sources.md) for current orchestration/runtime patterns. Provider SDK primitives are examples, not universal contracts; preserve these invariants even when the runtime changes.
