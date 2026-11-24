# Harness stress investigation — October 21, 2026 (local time)

## Verdict

**The synthetic browser stress workload now passes its latency budgets after a
focused streaming-render change.** The app as a whole is still not fully
performance-qualified: this does not cover the native Tauri/WebKit shell, real
provider/tool subprocesses, or the original 12 GB incident end to end.

The changes here add a repeatable measurement runner, isolated server
instrumentation, and a measured fast path for live Markdown rendering. Earlier
migration and memory-retention fixes remain in the working tree. Unrelated
concurrent work was preserved.

## Reproduction

Use the repository's installed dependencies and Playwright Chromium. No extra
dependency or browser download is performed by the benchmark.

```sh
bun run build:frontend:static
bun scripts/benchmark-harness.ts --smoke --output outputs/harness-smoke-new.json
bun scripts/benchmark-harness.ts --output outputs/harness-full-new.json
# Separate profiling run: instrumentation changes timing; do not compare it
# directly against an unprofiled run as an optimization measurement.
bun scripts/benchmark-harness.ts --profile --output outputs/harness-profile-new.json
```

The runner exits nonzero on a workload error, cutoff, browser error, or exceeded
budget. The current runner records `completed`, `deadlineExceeded`, and
`budgetsPassed` separately. `--deadline-ms` can shorten, but not extend, its
180,000 ms ceiling. A one-millisecond cutoff smoke check verified that it reports
an incomplete run and exits instead of continuing the startup retry loop.

Run on an otherwise quiet host. Do not terminate someone else's jobs to create
that environment. Record individual rounds, not only a favorable aggregate.

### Isolation and workload

- `scripts/benchmark-harness.ts` starts a fresh backend on loopback port 39323,
  refusing an occupied port. It does not attach to the installed service.
- Temporary database, home, workspace, local KMS, and authentication session.
  Ambient provider credentials are excluded; CLI autodetection is disabled.
- `scripts/benchmark-harness-server.ts` instruments the real source server and
  refuses external HTTP fetches. Browser requests are restricted to its own
  loopback origin. No generation endpoint is called.
- Fresh production/static frontend; source backend with `NODE_ENV=test` because
  disposable local KMS is prohibited in production. Not a packaged desktop test.
- Default: 40 chats × 120 messages, alternating user prompts and roughly 3 KB
  Markdown/code responses. History is inserted into the disposable database;
  subsequent API reads and UI rendering are real.
- Three rounds of 240 history requests at concurrency eight, followed by three
  rounds opening every chat through its actual sidebar button.
- Eight chats with a manager and three workers each: 32 synthetic streaming
  lanes, 300 chunks per lane, terminal markers, and concurrent composer typing.
  These are frontend WebSocket injections, not 32 native provider processes or a
  test of backend streaming durability/backpressure.
- Session deletion, ten seconds of ordinary idle recovery, then a separately
  labeled forced-GC diagnostic. Forced GC is not used to satisfy idle budgets.
- `--smoke`: eight chats, one request/switch round, 30 chunks per lane.

### Measurement definitions and limitations

- Backend RSS/JS heap and 250 ms timer delay sampled in the child process.
- Renderer JS heap and DOM/document counts from Chromium CDP at checkpoints.
- Browser RSS checkpoints use PIDs reported by that specific Chromium instance,
  including browser/renderer/GPU/utility processes, not other user browsers.
  `ps` reports KiB; values are converted to MiB. This metric is unavailable on
  non-Unix hosts. Summed RSS can count shared pages more than once and does not
  account for swapped-out memory; it is not total physical footprint.
- Input-to-paint is an automation round trip through text insertion and two
  animation frames, **not browser INP**. It includes scheduling/protocol cost.
- API and switching p95 budgets: 100 ms and 250 ms. Input budget: 100 ms.
  Component memory guardrails: 512 MiB backend RSS and 512 MiB sampled renderer
  heap. These do not constitute the requested 2 GB whole-desktop ceiling.
- Browser RSS/heap are checkpoints, not continuous peaks. No native Tauri shell,
  WebKit engine, real tool subprocess workload, or long-duration soak is included.
- Bun 1.3.14, Chromium 151.0.7922.34, macOS arm64, Apple M5, 10 cores, 24 GiB RAM.
  Base revision `5e0f43e47e6681e5cb6e75cde4b1585c319cf683` with extensive
  uncommitted/concurrent changes, not a clean immutable benchmark revision.

## Recorded evidence

### Final runner verification — completed smoke workload

`outputs/harness-smoke-verified.json`, started 2026-10-22T04:53:15Z, verifies the
final runner end to end: `completed: true`, `deadlineExceeded: false`,
`budgetsPassed: false`. The command exited nonzero because API and switching
latency still exceeded their budgets. There were no browser page errors.

| Measurement                                           |           Result |
| ----------------------------------------------------- | ---------------: |
| History p50 / p95                                     |  20.6 / 115.5 ms |
| Chat switching p50 / p95                              | 290.1 / 367.2 ms |
| Insertion-to-paint p50 / p95                          |   17.3 / 64.5 ms |
| Renderer heap: idle / after switching                 |  13.9 / 42.9 MiB |
| Renderer heap: streaming complete / ordinary recovery |  24.6 / 26.6 MiB |
| Renderer heap after separately forced GC              |         14.9 MiB |
| Browser + backend RSS at stream-complete checkpoint   |        858.2 MiB |
| Browser + backend RSS after deletion + 10 s idle      |        620.5 MiB |
| Backend RSS at final ordinary recovery checkpoint     |         97.5 MiB |

Host load averages were still approximately 41–50, but lower than during the
full attempt. This is **not a demonstrated software speedup**: the environment
changed, the full workload did not complete, and no product optimization was
made between runs. This final smoke is functional verification of the runner,
not the requested heavy-load qualification. Frontend checking also ran during
part of this smoke, another reason not to use its timing as a clean baseline.

An intermediate browser-launch experiment stalled before browser measurements
(`outputs/harness-smoke-final.json`). It was reverted to the already-working
direct Playwright launch before this final verified run; it is an instrumentation
failure, not a product-performance result.

### Final full workload after the rebuilt streaming fast path

`outputs/harness-full-verified-fix.json` (started
`2026-10-23T00:26:16.800Z`) completed the default workload with
`completed: true`, `deadlineExceeded: false`, and an empty `budgetFailures` list.
This run used a rebuilt static frontend; its `frontendEntrySha256` differs from
the earlier bundle. The before/after runs used the same workload; host/cache
conditions differed, so the streaming-render change is the only result
attributed directly to the frontend optimization.

| Measurement                        | Before (`harness-full-quiet.json`) | After (`harness-full-verified-fix.json`) |
| ---------------------------------- | ---------------------------------: | ---------------------------------------: |
| API p95 average across 3 rounds    |                           160.8 ms |                                  23.8 ms |
| Switch p95 average across 3 rounds |                           318.3 ms |                                 165.9 ms |
| Streaming input-to-paint p95       |                           136.0 ms |                                  96.0 ms |
| Budget failures                    |                                  7 |                                        0 |
| Streaming lanes / events           |                         32 / 9,664 |                               32 / 9,664 |
| Completion / cutoff                |                      complete / no |                            complete / no |

The fast path directly targets the streaming renderer; therefore the streaming
input improvement is the most relevant comparison. Do not attribute the full
API/switching deltas solely to this frontend change.

The focused change is in `frontend/src/lib/utils/streaming-segments.ts` and
`FeedEntry.svelte`: live prose is escaped and rendered as text instead of being
re-tokenized and sanitized on every debounce tick. Math-delimited chunks still
use the Markdown/KaTeX path, and completed rich fenced blocks still render
immediately. Once streaming ends, the normal full Markdown renderer remains the
source of truth.

Final-run checkpoints included approximately 50 MiB renderer heap at stream
completion, 35 MiB after ten seconds of ordinary post-deletion idle, and 17 MiB
after the separate forced-GC diagnostic. Browser/backend RSS was about 1,021 MiB
at stream completion and 632 MiB after ordinary recovery in that run; these are
checkpointed RSS sums, not whole-desktop physical-memory totals.

`outputs/harness-full-after-stream-fast-path.json` and
`outputs/harness-full-final.json` were generated before the static rebuild and
must not be used as proof of the source change. They are retained as diagnostic
history only.

### Earlier completed smoke workload

`outputs/harness-smoke.json` (started 2026-10-22T04:28:41Z; local evening
October 21). This artifact predates the explicit completion flags; it
contains streaming, deletion recovery, and budget results without a workload
exception.

| Measurement                                       |            Result |
| ------------------------------------------------- | ----------------: |
| History request p50 / p95                         |   57.7 / 241.3 ms |
| Eight chat switches p50 / p95                     | 906.6 / 1850.9 ms |
| Composer insertion-to-paint p50 / p95             |   21.3 / 696.8 ms |
| Streaming data/terminal events sent               |             1,024 |
| Renderer heap before switching                    |          13.9 MiB |
| Renderer heap after switching                     |          44.4 MiB |
| Renderer heap after streaming                     |          49.8 MiB |
| Renderer heap after deletion + 10 s idle          |          51.8 MiB |
| Renderer heap after separate forced-GC diagnostic |          14.9 MiB |
| Backend recovery RSS median / maximum sampled     |  78.3 / 104.3 MiB |
| Browser page errors                               |                 0 |

The reachable heap diagnostic is encouraging, but normal idle heap had **not**
returned to baseline after ten seconds. Do not describe 14.9 MiB as ordinary
idle recovery or total application memory. All three latency budgets failed.

### Incomplete full workload with profiling enabled

`outputs/harness-profile.json` began at 2026-10-22T04:30:56Z. All 720 history
requests and 120 sidebar switches completed. The three-minute server cutoff
occurred during streaming; the old runner subsequently waited for a terminal
marker and the outer shell reached its 240-second limit. The backend-unavailable
overlay in its screenshot is caused by that cutoff, not evidence of a product
crash. No completed CPU profile or full recovery measurement was obtained.

| Checkpoint                 | Browser RSS | Backend RSS | Combined RSS | Renderer heap |
| -------------------------- | ----------: | ----------: | -----------: | ------------: |
| Browser idle, seeded chats |   338.0 MiB |   154.0 MiB |    491.9 MiB |      15.7 MiB |
| Switch round 1             |   564.6 MiB |   104.8 MiB |    669.3 MiB |      49.9 MiB |
| Switch round 2             |   568.6 MiB |   163.5 MiB |    732.1 MiB |      64.2 MiB |
| Switch round 3             |   615.4 MiB |   134.0 MiB |    749.3 MiB |      69.2 MiB |

History p95 by round: **408.8, 312.1, 371.5 ms**. Switch p95 by round:
**1859.7, 1420.2, 880.4 ms**. Partial streaming input measurements overlap the
cutoff and are not a completed-workload result. The old artifact's `events`
counter measures calls made by the producer, not acknowledged delivery.

`outputs/harness-baseline.json` is an earlier **incomplete** development run;
its streaming terminal marker was not verified. Do not treat it as a passing
baseline. Earlier diagnostic screenshots may predate their overwritten JSON
report; only the full-run screenshot above has been inspected against that run.

## Verification and failures

The two required root commands were executed with **300,000 ms maximum timeouts**:

- `bun run typecheck`: **passed**, backend and MCP typechecks exited zero.
  The frontend's script is named `check`, not `typecheck`, so this root command
  does not by itself verify Svelte templates.
- `bun run test`: **not complete**, stopped at the five-minute ceiling while the
  large backend suite was still running. In that run MCP completed with **496
  passed / 0 failed**. The frontend had two failures from the first version of
  the fast path plus one unrelated Beam setup timeout; the math compatibility
  issue was fixed afterward. A subsequent complete frontend run passed **188
  files / 1,418 tests**. No completed backend aggregate is claimed.

Observed full-suite failures, kept visible rather than retried to obtain green:

- MCP `proactive-monitoring.test.ts`: config-file watcher event timeout. Also
  reproduced in a focused run (14 passed, one failed). Not touched by the
  migration/cache/frontend retention edits.
- Frontend `providers-beam.test.ts`: a ten-second setup-hook timeout in the
  root run. It does not reproduce in the focused streaming/FeedEntry suite.
- The temporary `FeedEntry.variant.test.ts` equation failure was caused by the
  first fast path and was fixed by retaining a math-only rich-render branch.
- Backend `chat-git.test.ts:158`: expects constructing a source-folder
  `ChatGit` to throw `owned isolated`, while a separate existing implementation
  change intentionally supports ordinary in-place folders. Focused reproduction:
  nine passed, one failed. Migration and cache changes do not control that branch.
- Backend `manager-chat-workspace.test.ts`: expected `unavailable`, got `ENOENT`.
- Backend skill-audit CLI tests: host-selection assertion and piped-JSON timeout.

No failing product assertion was established as caused by this continuation's
benchmark-only changes. No unrelated behavior/test expectation was changed to
make the suite green. The shared dirty checkout changed during the investigation,
so a clean-revision attribution of every failure is not claimed.

Other actual checks:

| Check                                             | Result                                                          |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Fresh `bun run build:frontend:static`             | Passed, static frontend generated                               |
| `bun run --filter frontend check`                 | Passed: 0 errors, 8 existing warnings in AgentThreadFeed.svelte |
| Full frontend suite after final fix               | Passed: 188 files, 1,418 tests                                  |
| Full MCP suite observed inside root run           | Passed: 30 files, 496 tests                                     |
| Six focused frontend store files                  | 119 passed                                                      |
| Migration regression file                         | 27 passed                                                       |
| Cache-fabric regression file                      | 11 passed                                                       |
| Installed TypeScript compiler on benchmark runner | Passed                                                          |
| One-millisecond benchmark cutoff probe            | Expected nonzero exit; incomplete/cutoff JSON written           |
| Final benchmark smoke                             | Completed, no page errors, 2 latency budget failures            |
| `git diff --check`                                | Passed                                                          |

Focused frontend command:

```sh
bun run --filter frontend test -- \
  src/lib/stores/shortcuts.test.ts \
  src/lib/stores/session-erasure.test.ts \
  src/lib/stores/feed-reload-reasoning.test.ts \
  src/lib/stores/feed-turn-continuation.test.ts \
  src/lib/stores/websocket-tool-completion.test.ts \
  src/lib/stores/websocket-transcript-recovery.test.ts
```

Backend regressions used the existing isolated runner. The mixed investigation
also included `chat-git.test.ts`, so that command's overall exit was nonzero even
though both relevant regression files passed:

```sh
bun run test:backend:isolated -- \
  --file backend/src/db/migrations.test.ts \
  --file backend/src/providers/__tests__/cache-fabric.test.ts \
  --file backend/src/kory/__tests__/chat-git.test.ts
```

The benchmark is outside the backend's normal source include set. Its additional
typecheck used the already installed frontend compiler and Bun type roots:

```sh
bun frontend/node_modules/typescript/bin/tsc --noEmit --target ES2022 \
  --module Preserve --moduleResolution bundler \
  --typeRoots frontend/node_modules/@types --types bun --skipLibCheck \
  --allowImportingTsExtensions scripts/benchmark-harness.ts
```

## Next step

1. Qualify native WebKit/Tauri, real worker/tool processes, large tool output,
   and a longer soak before accepting the user's whole-app memory targets.
2. Reproduce or rule out the original 12 GB whole-desktop incident with process-
   group accounting; the browser/backend checkpoints here are not sufficient.
3. Track the unrelated root-suite failures separately. Do not rerun the entire
   suite repeatedly under the same environment merely to seek a green sample.

This continuation did not reinstall/restart the user's live application, use
paid models, or commit the mixed worktree. It did rebuild ignored frontend
artifacts for the isolated browser run.
