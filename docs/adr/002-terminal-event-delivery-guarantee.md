# ADR-002: Terminal-event delivery guarantee via pendingTerminalEvents queue

## Status

Accepted

## Context

The frontend's busy/Stop state depends on receiving terminal events (`stream.complete`, `agent.completed`, `agent.error`) to transition from "busy" to "idle". If a terminal event is dropped, the UI gets stuck:

- The Stop button stays active forever
- The composer is disabled
- The user can't send new messages
- The only recovery is a page refresh

The prior WS manager had no backpressure handling — it called `ws.send(data)` on every client for every message, regardless of whether the client's buffer was full. On slow clients or network congestion, `send()` would either block or throw, and the terminal event was lost.

A 45-second frontend watchdog existed as a last-resort safety net, but it was the **primary** mechanism for recovery — meaning users would wait 45 seconds after every stuck state.

## Decision

Implement a terminal-event delivery guarantee in the WS manager:

1. **Backpressure check**: Before each `send()`, check `ws.getBufferedAmount()`. If over 64KB, mark the client as `overloaded`.
2. **Skip non-critical messages for overloaded clients**: Stream deltas, thinking, tool calls — these are lossy by design (the frontend can re-sync from the ordered-event-log on reconnect).
3. **Queue terminal events**: `stream.complete`, `agent.completed`, `agent.error` are pushed to `client.pendingTerminalEvents` and retried on each heartbeat tick (every 5s).
4. **Heartbeat retry**: The heartbeat loop (reduced from 30s to 5s) calls `retryTerminalEvents()` for each client — if the client is no longer overloaded and the socket is open, queued terminal events are delivered.
5. **Frontend watchdog extended to 120s**: The watchdog is now a true safety net, not the primary mechanism. If it fires, it indicates a bug in the delivery path.

## Consequences

- **Positive**: Terminal events are delivered reliably even under backpressure.
- **Positive**: Slow clients don't block the event loop (non-critical messages are skipped).
- **Positive**: The frontend watchdog fires only on actual delivery bugs, not on normal backpressure.
- **Negative**: Overloaded clients miss intermediate stream deltas (acceptable — they re-sync on reconnect).
- **Negative**: Terminal events may be delivered out of order relative to skipped deltas (acceptable — the frontend's state machine handles this by checking the current state before applying the terminal event).

## Alternatives considered

- **WebSocket compression**: Reduces buffer pressure but doesn't solve the fundamental "slow client" problem.
- **Server-sent events instead of WebSocket**: One-directional, but we need bidirectional for user input.
- **Increase watchdog timeout only**: Doesn't solve the root cause — terminal events are still lost.
