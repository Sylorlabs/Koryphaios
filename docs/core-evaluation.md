# Core verification and task evaluation

## Deterministic regression gate

`bun run test:core` runs backend files in separate processes with disposable databases and credential-free test homes, then runs the frontend suite. Live provider tests are excluded by default. Individual fixes use the identical boundary:

```sh
bun run scripts/test-backend-isolated.ts \
  --file backend/src/runs/session-run-store.test.ts \
  --file backend/src/eval/benchmark.test.ts
```

Repeat `--file` for more files. Bun options such as `--test-name-pattern` are forwarded. Do not pass bare file filters: the default runner discovers all backend files. `--single-process` is available for aggregate coverage, with weaker inter-file state isolation.

## Task evaluation

`backend/src/eval/benchmark.ts` runs versioned fixtures through an explicit runner adapter. It supplies the task prompt and turn budget, records elapsed time, validates reported usage/cost/intervention metrics, and verifies the final code with trusted checks. The included fixtures cover a module contract, arithmetic repair with unseen cases, and concurrent cache coalescing plus rejection recovery. They are regression fixtures, not evidence of market-leading coding performance.

```sh
bun run eval:core --adapter ./my-local-eval-adapter.ts > evaluation.json
```

The selected file must export:

- `identity`: an explicit harness/provider/model/version description.
- `run(workspace, {task, signal})`: a promise returning `{turns, tokensUsed?, costUsd?, humanInterventions?}` after all writers and descendants have stopped.

The adapter receives only the public task contract, not the verifier function. It must send `task.description` to its agent, enforce `task.maxTurns`, stop work on `signal`, and await process termination before resolving. The harness also rejects observed turn overruns. Unknown metrics remain `null`; reporting zero asserts an observed zero. No provider is selected or charged automatically by this command. The adapter is trusted local executable code.

A timeout cancels the operation and allows a bounded shutdown grace period. If the runner has not settled, its workspace is retained and reported in `retainedWorkspace`; inspect/stop its processes before removing it. Never delete a workspace underneath an active writer. Verification source is kept outside the task workspace and executes in a child process with a deadline, bounded output and no inherited API credentials or automatic `.env` loading.

**A disposable directory, a child process and a stripped environment are not an OS sandbox.** The adapter must supply platform confinement before running untrusted agents or generated code. The built-in verifier child itself is not kernel-confined. Do not run adversarial outputs on a sensitive host; use a disposable VM/container with appropriate filesystem and network boundaries. The metrics returned by an adapter are reports, not independently attested billing or process telemetry.

Compare runs only with the same fixture implementation, task manifest hash, repository baseline, budgets, and environment. The manifest identifies task descriptions, deadlines, and setup/verifier source; it does not attest the runtime or dependencies. Use repeated runs and report failures and unavailable providers. A meaningful competitive study additionally needs held-out real repository tasks, independent review of accepted changes, measured human interventions, and actual paid/provider-version evidence. This implementation does not manufacture those results.
