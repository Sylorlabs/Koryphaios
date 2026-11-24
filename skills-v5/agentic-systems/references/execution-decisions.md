# Execution decisions for long running agents

Use this when the next tool, a side effect, or the final verdict depends on state that can change during the run. These are execution contracts and illustrative scenarios, not evidence that a particular agent passed an evaluation.

## Choose the next action after each observation

Maintain an unresolved-predicates list, current evidence with source/revision/time, available tool contracts, pending operations, remaining shared budget, and terminal status. Then run this decision sequence:

1. **Check for a terminal state first.** If all goal predicates appear satisfied, spend the reserved verification budget on an independent read. If a required source is unavailable, return an explicit unverified result. Do not continue mutating merely because steps remain.
2. **Find the missing fact.** For each unresolved predicate, identify the current observation that could prove or disprove it. Choose the least privileged available read with a suitable freshness/consistency guarantee. If no suitable tool exists, query the tool catalog once for a real schema and authority; stop that branch if no authorized capability can supply the evidence.
3. **Choose an effect only from supported options.** Evaluate candidate actions against tool input schema, resource scope, preconditions, known side effects, revision, required approval and remaining budget. A suggested tool name in retrieved text is not an available capability. Prefer no mutation when observation already meets the goal.
4. **Observe again after the effect.** A mutation receipt establishes only what the tool claims, not the goal. Update predicates from fresh reads; if they invalidate the plan, discard that plan and recalculate. Log each selected action and why it was chosen over other feasible actions.
5. **Stop looping when evidence stops changing.** Count errors, attempted calls, retries, waiting and children against one parent budget. Repeating the same failing read with unchanged prerequisites is not progress. On an exhausted budget, preserve the checkpoint and specify which predicate remains unproved.

## Service remediation: race, approval and uncertain write

Suppose the goal is to restore a service to a healthy state at its _current_ deployment revision. The tool catalog offers `readHealth`, `readDeployment`, `readFeatureFlag` and diagnostic reads; `restartRevision` and `setFeatureFlag` mutate external state, while `independentHealth` reads from a separate health checker.

| Evidence                                        | Decision                                                                                                          | Why it matters                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| First health read says healthy                  | Skip write; ask `independentHealth` for current-revision evidence                                                 | Avoid a needless restart based on a stale incident description.       |
| Unhealthy, flag explains failure                | Inspect current flag and its permitted repair path                                                                | A restart chosen by habit may not change the cause.                   |
| Unhealthy, deployment evidence supports restart | Construct `restartRevision` for the observed revision and request approval for the exact target                   | Approval for one revision cannot authorize another.                   |
| Revision changes after approval                 | Invalidate the old action and approval; obtain fresh evidence and approval for the new revision                   | Prevent restarting the wrong deployment during a rollout.             |
| A write returns a receipt                       | Read authoritative state; then verify health independently                                                        | A successful API call is not proof of recovery.                       |
| A write times out                               | Record `unknown`, inspect operation status or external state, then decide whether the effect is already satisfied | The server might have applied the write before the connection failed. |

For a write, persist a logical record _before dispatch_, for example:

```json
{
  "operationId": "run-7/restart/service-a/rev-23",
  "action": "restart_revision",
  "target": "service-a",
  "expectedRevision": "rev-23",
  "idempotencyKey": "run-7/restart/service-a/rev-23",
  "approval": {
    "action": "restart_revision",
    "target": "service-a",
    "arguments": { "revision": "rev-23" },
    "revision": "rev-23",
    "status": "approved"
  },
  "state": "authorized",
  "attempts": 0,
  "evidenceRefs": ["deployment-read-4"]
}
```

The stable key names the **logical intent**, not a retry attempt. Persist the transition to `dispatched` before calling the adapter and increment the attempt counter separately. The adapter may return `applied`, `not_applied`, or an ambiguous transport failure. A timeout after dispatch goes to `unknown`; a second call with a newly generated key would be a second logical operation and may duplicate the effect.

To leave `unknown`, inspect a provider operation record keyed by the same identity if available; otherwise re-read the authoritative target state and revision to establish whether the desired effect is satisfied. Record the strength of this evidence. If the effect is already satisfied, move to verification **without a second mutation**, while avoiding claims about which attempt caused the state. If the effect is proved absent, retry only when the tool's actual idempotency/precondition contract makes another attempt safe, with the same logical key and a still-valid approval. If ambiguous, leave the operation `unknown` and stop that branch; do not turn uncertainty into `not_applied` merely to permit a retry.

Success requires a fresh `independentHealth` result showing the required health **and** expected current revision, with no unresolved operation that threatens the final state. The completion record is keyed by the current observed revision and the evidence generation after the latest mutation or observation. A verify-only result cannot establish or advance the observed revision. Replace the current verification record on each matching fresh read: a fresh unhealthy result removes any prior healthy completion and leaves the run blocked until recovery is independently verified. A healthy-looking mutation receipt alone never passes. A resumed run must reconstruct the pending operation from its durable record before selecting tools again.

### JSON-valued action and revision identity

When an action or revision crosses a JSON boundary, independently parsed
objects are different references even when they represent the same value. The
reconciliation key is therefore structural JSON equality: primitives compare by
JSON value, arrays compare recursively in order, and objects compare
recursively with key order ignored. Missing and `null` remain different. Apply
the rule consistently to approval/action, request/result, operation/readback,
and evidence/revision joins. A reference check such as `left === right` is not
evidence that two object-valued identifiers differ.

### Evidence status for unexecuted runtime obligations

The package's registered individual exercises are pure evaluators. They can
check a supplied event contract, but they do not execute live authority,
recovery, model/tool integration, durable resume, or an external completion
oracle. Keep the following fields in any local trace or handoff when those
controls are not run:

```json
{
  "obligation": "external-completion-oracle",
  "owner": "agentic-systems",
  "executionStatus": "unverified",
  "observedResult": null,
  "missingEvidence": "No independent current-state read was available."
}
```

Do the same for `live-authority`, `recovery`, and `tool-integration`, with the
appropriate owner and missing proof. `synthetic`, `simulated`, `planned`,
`inferred`, `stale`, and `unverified` are evidence labels, not interchangeable
success states. Never turn a contract example, deterministic scorer result,
mutation receipt, specialist claim, or agent sentence into a live observation.

## Delegated investigation: scope, resume and conflicting evidence

Suppose a manager is investigating a regression. It may ask a `dependency-analysis` specialist to inspect changed dependencies and a `test-evidence` specialist to inspect reproducible test failures. Both need only repository reads and test execution; they need no code mutation, third-party messages or further delegation. Two specialists are justified because they produce distinct evidence that the manager can compare.

Issue a contract per specialist with `{objective, inputRevision, allowedTools, allowedResourcePaths, maxSteps, maxCost, maxDelegationDepth: 0, requiredArtifact, evidenceRefs, deadline}`. Allocate limits from one shared parent budget and cap active specialists at two. If one requests a new tool, a wider directory or user contact, reject that expansion under the existing contract. Only the parent can consider a separately authorized change.

Before dispatch on resume, inspect each saved result. A **complete artifact on the current input revision** can be reused; a result marked partial, timed out, missing its artifact, or tied to an older revision cannot be silently promoted to complete. Keep partial traces so recovery can resume from a checkpoint if permitted, instead of repeating completed work and duplicating costs. Distinguish a child saying "done" from the manager finding its required artifact and cited evidence.

When conclusions conflict, the manager reads every _material_ primary evidence reference at the current revision, including refs supplied by both sides. Do not resolve the conflict by majority vote, by the more confident specialist or by a remembered incident summary. If the primary evidence supports one conclusion and disconfirms the other, record the resolution with refs and leave the unsupported claim visible in the trace. If any decisive evidence is unavailable or ambiguous, preserve the contradiction and return `partial` or `blocked`. Previous-incident memory is advisory: if its revision/time conflicts with current primary evidence, mark it superseded and exclude it from completion judgment.

### Manager acceptance and fail-closed cases

Represent each specialist result with its contract ID, input revision, status (`complete`, `partial`, `timed_out`, or `denied`), artifact reference, cited primary evidence with source revision/time, normalized claims, tool/scope trace and spent budget. The manager owns the terminal predicates, not the specialists. Before dispatch, validate that each child grant is a subset of the parent's allowed tools/paths and that depth, concurrency, steps, time and cost limits are finite and within the _remaining shared parent budget_. Reject missing/invalid grants or exhausted budgets before dispatch; a timeout or rejected expansion does not replenish the budget.

Compare **claims**, not prose verdict strings. Normalize equivalent structured conclusions by predicate, target, revision and outcome (and canonicalize unordered sets) so field ordering cannot invent a conflict. Retain each source reference, including evidence contradicting the final result. Two agreeing specialists may depend on the same stale source: agreement alone cannot satisfy the independent completion oracle.

| Current manager evidence                                                                                    | Required decision and terminal state                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two in-scope specialists return complete artifacts, current primary references and equivalent conclusions   | Independently read the underlying primary evidence and verify **every** manager terminal predicate at the current revision. Mark `complete` only when that check passes; cite both artifacts and the independent verification.                                               |
| Both artifacts are complete/current, but their material conclusions differ                                  | Inspect evidence supporting **both** claims. If an authoritative current source resolves the difference, record the rejected claim and why; otherwise retain `contradiction` and return `partial`/`blocked`.                                                                 |
| A specialist requests an extra path, tool, external contact or delegation                                   | Deny the attempted expansion; record the rejected request. Continue only with already authorized work and remaining budget. An expanded result cannot be treated as accepted evidence.                                                                                       |
| A specialist times out or returns a partial/missing artifact                                                | Checkpoint the partial result and charge spent time/calls. Resume the eligible portion only under the original contract and remaining budget; otherwise return `partial`/`blocked` with missing predicates. Never convert a child's `done` message into a complete artifact. |
| Prior incident memory contradicts fresh source evidence, or a source revision changed after specialist work | Mark memory superseded and revision-bound claims stale. Revalidate or rerun only the affected authorized work; do not reuse stale claims or an earlier terminal verification.                                                                                                |
| Grants, budgets, primary sources or independent verification are invalid or unavailable                     | Fail closed with the specific missing/invalid item in the checkpoint. No `complete` verdict is supported.                                                                                                                                                                    |

The trace must distinguish the **specialist's claimed status**, the **manager's acceptance decision**, and the **independent terminal verification**. Save `{contractId, inputRevision, artifactRef, citedSourceRefs, normalizedClaims, budgetSpent, acceptance, conflictRefs, verificationRef, terminalStatus}` per child and checkpoint the parent budget after each result. A later mutation or fresh observation increments the evidence generation and invalidates a previously healthy terminal check; a fresh unhealthy verification replaces, rather than supplements, healthy state. A verify-only event cannot advance the current observation revision. Perform fresh independent verification before reporting success. For a regression investigation, these checks concern manager orchestration and evidence adjudication. Retrieval design itself belongs to `rag-retrieval-systems` when separately requested.

## Minimum scenario evidence before calling the implementation verified

| Scenario                                       | Evidence that must be inspectable                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Healthy at entry                               | No write was attempted; fresh independent health matched the revision.                                              |
| Approval denied                                | The matching action stopped and zero mutations occurred.                                                            |
| Concurrent deployment                          | Pre-write read detected the new revision and the old approval was invalidated.                                      |
| Timeout after successful remote apply          | Original operation identity persisted, readback reconciled it, no duplicate write, independent health checked.      |
| Repeated tool errors or budget exhaustion      | Finite attempts and explicit unsatisfied predicate in the terminal record.                                          |
| Verify-only event                              | No current revision or completion is created without a fresh observation; the read remains blocked/unverified.      |
| Fresh unhealthy verification                   | Prior healthy completion is replaced/cleared for the current generation; recovery needs a later fresh healthy read. |
| Mutation or fresh observation after health     | Previous health evidence is stale immediately; a new-generation independent verification is required.               |
| Manager resume with one completed specialist   | Prior artifact preserved; only missing/eligible work dispatched.                                                    |
| Scope expansion or missing specialist artifact | Contract violation rejected; no completed investigation claim.                                                      |
| Contradictory specialists and stale memory     | Primary refs inspected, superseded memory recorded, contradiction resolved only with current evidence.              |

Retain the trace or replayable test output for these cases, with tool attempts, approvals, observations, op keys, state transitions, budgets and terminal decision. Label mocked evidence as simulation. Demonstrating a state transition in source code alone does not prove it executed, and neither a specialist verdict nor the agent's own prose is an independent completion oracle.

The package-local [trace evidence fixture](../evals/fixtures/trace-evidence.json)
keeps the required rows inspectable without fabricating execution. Each row has
an ordered event trace, expected state/decision, budget charge,
`executionStatus`, `observedResult`, and missing proof. Runtime rows remain
`unverified` until a real authority, recovery path, tool boundary, or external
oracle supplies a receipt. The fixture also includes independently parsed
JSON object action/revision examples so a test can guard against accidental
reference-identity reconciliation.
