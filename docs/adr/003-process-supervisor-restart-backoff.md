# ADR-003: Exponential backoff + restartCount preservation in process supervisor

## Status

Accepted

## Context

The process supervisor restarts crashed child processes. The prior implementation had two critical bugs:

1. **Fixed 5s restart delay**: Every restart happened 5 seconds after the crash, regardless of how many times the process had crashed. A persistent failure (bad config, missing binary, wrong permissions) would crash-loop every 5 seconds forever.

2. **restartCount reset to 0 on each spawn**: `startProcess()` always set `restartCount: 0` in the persisted process record. This meant the `maxRestarts` cap never bound — the supervisor would restart the process infinitely, each time thinking it was the first restart.

Combined, these bugs meant a single bad process could generate thousands of crash-restart cycles per hour, filling logs, consuming CPU, and starving other processes.

## Decision

1. **Exponential backoff**: `delay = min(restartDelayMs * 2^(attempt-1), 60_000)` — 5s, 10s, 20s, 40s, 60s, 60s, ...
2. **Preserve restartCount**: `startProcess()` accepts `options.restartCount` and uses it instead of defaulting to 0. `scheduleRestart()` passes `restartCount + 1` to the new spawn.
3. **Re-check the cap inside the timeout callback**: The max-restart cap is checked both at schedule time and inside the callback, in case the process was manually killed while waiting.
4. **Emit a `gave_up` lifecycle event**: When the cap is exceeded, the supervisor emits a `gave_up` status so the UI can show the process as permanently failed.

## Consequences

- **Positive**: Persistent failures stop after `maxRestarts` attempts, not infinite.
- **Positive**: Backoff reduces log spam and CPU waste during transient failures.
- **Positive**: The `gave_up` status is visible in the UI and logs.
- **Negative**: Transient failures take longer to recover from (5s → 10s → 20s on the first three attempts). This is acceptable — transient failures are rare, and the cost of a crash loop is worse.

## Alternatives considered

- **Fixed delay with cap only**: Doesn't reduce log spam during the crash-loop period.
- **Linear backoff (5s, 10s, 15s, ...)**: Slower to reach the cap, more total restarts.
- **Circuit breaker**: Stop restarting entirely after N failures in a window. More complex, and the max-restart cap already provides this functionality.
