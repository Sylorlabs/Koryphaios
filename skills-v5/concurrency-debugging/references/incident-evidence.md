# Incident evidence and controlled schedules

Use this reference when an incident involves overlapping operations, shutdown or callback lifetime, or when a local reproducer must establish _which_ schedule breaks the contract. The aim is an executable causal explanation, not a timeline inferred from wall clock log order.

## Capture evidence at the contested boundary

Start with **one affected key/session/job**, including all actors that can mutate or wait on it. Prefer existing traces and snapshots for a live production incident; intrusive scheduling, lock instrumentation, and fault injection belong in an authorized staging or test environment.

| Evidence field                                                                                        | Why it matters                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Run/trace ID, actor or task ID, operation ID, object or resource ID                                   | Distinguish overlapping attempts, retries, and unrelated requests.                       |
| Sequence/checkpoint ID within the actor; source of event                                              | Establish local program order even if log collectors reorder records.                    |
| Source revision, runtime/toolchain, scheduler mode/seed, instrumentation and limits on dropped events | Make replay reproducible and identify gaps that prevent a causal claim.                  |
| Read state and version, intended change, expected version, observed commit version and complete state | Expose stale snapshots and check whether conflict detection actually affected the write. |
| Lock/queue identity, acquire/release/blocked attempt, holder, call stack                              | Distinguish lock inversion from slow I/O, starvation, or a missing signal.               |
| Cancellation, notification, callback registration/disposal, completion acknowledgments                | Check the winning terminal action and whether cleanup finished.                          |

Capture enough to identify **the first incorrect transition**. Instrument the smallest point _before the snapshot_, _after the snapshot_, _immediately before the commit_, and _after the commit_ as needed, with correlation IDs and without sensitive payloads. For a stuck process obtain thread/task dumps and lock ownership at more than one observation point if safe; snapshotting or verbose logging itself can change scheduling. Distinguish events that were executed from simulations by the test scheduler or from hypotheses grounded in the source.

A plausible wall clock sequence does not prove that one worker saw another worker's write. The graph contains only supported edges for what happened before what: actor program order; mutex release → later acquire of that mutex; atomic synchronization where its memory ordering guarantees it; established channel/queue handoff; or completion/join → dependent continuation. A promise or `await` does not order two otherwise independent tasks. Mark edges without evidence as **unknown**, then identify a conflicting read/write pair lacking the required order or a cyclic dependency.

Use the target language and primitive's documented guarantees: atomicity of one access does not automatically publish other state or make a multi-step operation atomic. In a single-threaded async logical race the individual accesses may all be ordered, yet two read/modify/write operations can still overlap and commit stale state. Diagnose that transaction boundary rather than inventing a native memory data race. Missing or sampled events remain gaps; absence of a log line is not proof that an action never occurred.

For an async store, a useful causal trace is:

```text
A: read object at vN -------- apply A's delta ------ commit vN+1
B: read object at vN --- apply B's delta ---------------- commit using stale vN snapshot
                          ^ both reads precede both commits
```

Confirm _both_ read versions and actual full final state: a final version of `vN+2` can still have silently lost A's field. Reverse the commits: if independent deltas are required to survive, either order must retain both. With a boundary gated on the expected version, check that one stale attempt is rejected **and its caller retries with fresh state**; with updates scoped to individual fields, check that writes derive unaffected fields from the current state. A sequential pass alone does not test concurrency, and wholesale serialization of unrelated object IDs can hide a narrower defect.

## Construct a schedule that can fail on demand

1. Locate the exact contention window in the _original_ implementation. Put controllable checkpoints immediately after competing reads or first acquisitions and before their conflicting commit/second acquisition. If the fixture represents an interleaving as two phases rather than real threads, drive both phase orders and label the evidence as simulated.
2. Confirm the harness observed all expected checkpoints before releasing either contender; log the schedule ID, actor IDs, state/revisions and final result. Do **not** use elapsed milliseconds as proof the ordering happened.
3. Test the alternate order and an unopposed/sequential control on the original revision. For a race, record failures as well as schedules that happen to pass. For a deadlock, establish blocked waits and their owners. Save or reconstruct a reproduction from before the fix after modifying source only when the preserved baseline is trustworthy, and disclose its provenance.
4. After correction, run the exact same contract through both directions and controls. If the new lock hierarchy makes an old breakpoint unreachable, move the checkpoint to the relevant operation boundary instead of forcing an impossible lock state.

A barrier can **manufacture** a deadlock if an actor holds a mutex while waiting for a test coordinator that itself needs that mutex. Arrange release/cleanup in `finally`, use a watchdog only to fail a stalled test, and make sure the watchdog cancels/unblocks/joins the participants. If a real deadlock cannot be unwound cooperatively, run it in a disposable child process, capture its wait evidence, then terminate and reap that child within the test bound. Report a timeout as a failed termination observation, never a successful deadlock fix. Avoid arbitrary sleeps, correctness decisions based on timers, or reliance on lucky scheduler timing.

## Wait graph and progress invariant

Represent each blocking edge as `actor → awaited resource/actor` and each ownership edge as `resource → holder`:

```text
shutdown → queue lock → flush → session lock → shutdown
```

Confirm that shutdown holds the session lock while waiting for the queue lock and flush holds the queue lock while waiting for the session lock **at the same time**. That directed cycle shows why neither can advance. An async wait for a worker that must acquire a lock held by its waiter is the same form of dependency, even if no OS thread is blocked.

Repair by enforcing one acquisition order everywhere or restructuring so a lock is released before a dependent wait. Define when shutdown stops admitting work: units already accepted must drain, while later arrivals follow the existing rejection/admission contract. Shutdown must wait for accepted units' _completion_, not merely remove the cycle by skipping or dropping work. An empty queue can mean work was dequeued but is still running; retain unit IDs and completion acknowledgments. A shutdown control without contention checks draining; the previously conflicting schedule checks progress. If there is no demonstrated cycle, investigate starvation, missing wakeups, stalled I/O, or livelock before declaring a deadlock.

For a callback that runs after disposal, or double completion, draw an equivalent ownership graph: queued callback → owner lifetime, cancellation → terminal state, completion → terminal state. Choose a linearization point so only one contender can commit terminal state and side effects, and make teardown wait for or invalidate callbacks still in flight as required. Check both orders: callback before disposal and disposal before callback, or cancel before completion and completion before cancel.

Also pause between a callback's validity check and its effect: disposal during an `await` or reentrant call must not let a stale generation act on a replacement owner. Unregistering a listener does not recall a callback already queued. Assert ownership of terminal state and observable effect counts separately; a terminal flag held in memory alone cannot prove external delivery exactly once.

## Failure and recovery evidence

Choose the failure path introduced or affected by the repair, then verify that valid work can proceed afterward on the **same entity**:

- **Conflict/retry:** observe rejection or rebasing of the stale attempt, the fresh state used, and the final accepted delta. If retries exist, test the existing cancellation/exhaustion outcome: no false success, no lost accepted work, and no repeated non-idempotent effects. A repair that atomically applies independent deltas needs no invented CAS failure path.
- **Lock/worker failure:** inject at a supported test seam while ownership is held or work is in flight; verify release or explicit failure propagation, settlement of waiting callers, and the fate of every accepted unit. Do not mark a flush complete merely because its worker exited.
- **Teardown:** release an old callback after disposal/resubscription and prove that it cannot affect the new generation; a new legitimate callback must still work. Record drained/unregistered participants and any outstanding work.

Separate recurrence prevention from incident-state recovery. List already lost updates, duplicated effects, or unfinished units and their authoritative reconciliation source. When recovery is part of the task, preserve the affected state, reconcile only from supported history under the existing replay/idempotency contract, then verify the resulting state and a fresh operation. If history or a live runtime is unavailable, mark recovery **unverified**; a passing local model does not repair production state.

## Verification matrix and reporting

| Failure class             | Deliberate failing schedule                                                                      | Evidence required after the fix                                                   | Control/coverage                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Overlapping updates       | Both actors read the same old version, A then B writes; also B then A                            | Both independent changes survive, revision/commit contract honored in both orders | Sequential updates; another key remains independent; bounded repeat; fresh work after stale attempt |
| Shutdown deadlock         | Two actors acquire their first resources, then each requests the other's resource                | No wait cycle; conflicting schedule terminates; all accepted units finish         | Ordinary shutdown with pending work; supported failure path; no leaked workers/locks                |
| Terminal race or teardown | Cancellation/disposal occurs on either side of completion/callback, including check → effect gap | One terminal owner; no duplicate effect or callback after invalidation            | Nonoverlap; old vs new generation; valid work after cancel/dispose                                  |

Keep deterministic, named schedule tests as the primary regression. Repeating one fixed simulation with two phases 1,000 times checks repeatability but explores no additional schedules; do not report the loop count as concurrency stress. When the task calls for stress, run a finite, recorded set of executions with varied interleavings, contention, or scheduler seeds, and assert final state, progress, and cleanup **on every iteration**. Report which schedules actually occurred, run count, seed, runtime, and failures. If the runtime exposes only fixed simulation, say that scheduling stress was unavailable. A run without the targeted interleaving is weaker evidence. Include race detectors where available and relevant (for example, an instrumented ThreadSanitizer build for supported native threads); a clean detector run cannot rule out a logical async race, code outside its instrumentation, or deadlock. Lock/thread diagnostics likewise identify a wait state, not automatic proof of its root cause.

For a JSON handoff, put the executed loop in a named `repeatabilityRegression` or `stressRegression` object, not just a planned count:

- Identify the test, command, exit status, source/runtime, and evidence kind (`simulated` or real scheduled execution).
- Use numeric `iterations` for **completed schedule executions**, separate from requested iterations. Name each schedule ID/order and its executed count.
- Retain schedule IDs, invariant outcomes, and failures for each iteration in the object or a linked structured test receipt; report early aborts and cleanup failures. Totals must reconcile with the retained results. Keep failures from before the fix separate from regressions run after the fix.
- For genuinely varied stress, include seeds/contention settings and observed schedule coverage. A random seed alone does not demonstrate that a different schedule ran.

The current package's full task exercises expose a document store model with two phases and a simulation of lock ordering. Execute and label those model results; do not claim they exercised real async barriers, native lock blocking, worker cleanup, or production recovery. If the supplied model cannot express a requested alternate schedule or failure path, identify the missing seam rather than fabricate runtime evidence.

A useful handoff states: **observed schedule and outcomes from before the fix** (or "not executed" with reason), **edges showing what happened before what, or the cycle of waits**, **precise invariant and owning repair**, **schedule, control, and stress commands and results from after the fix**, **failure/cleanup and recovery results**, and **remaining untested interleavings**. Include the actual changed code path when implementation was part of the task; do not substitute a claimed fix or a textual timeline for executed tests.
