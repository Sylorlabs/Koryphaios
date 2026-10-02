# Source map

## Adopted principles

- WebSocket supplies a bidirectional protocol after its opening handshake; application ordering, replay, acknowledgement, presence, and state reconciliation remain application concerns.
- Server-sent events are a server-to-client HTTP event-stream mechanism with browser reconnect semantics. That makes SSE and WebSocket different transport choices rather than interchangeable recipes.
- Realtime delivery should be recoverable from authoritative state when connection loss can create gaps.

## Conditional recipes

- WebSocket is not adopted as the universal realtime transport. SSE, polling, or another mechanism can be better when the communication shape is one-way or operational constraints differ.
- Heartbeat cadence, replay logs, acknowledgements, presence storage, and fan-out infrastructure are architecture-specific and remain optional.

## Verification scope

The protocol specifications establish framing and browser event-stream semantics. They do not prove proxy behavior, mobile-network stability, reconnect latency, scale-out routing, per-client queue bounds, or application-level delivery guarantees. Those require target-environment tests.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader network-service-backend.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **RFC 6455, The WebSocket Protocol**: https://www.rfc-editor.org/rfc/rfc6455
  - Scope: WebSocket protocol, checked 2026-09-06.
  - Use: handshake, bidirectional framing, close, ping, and pong semantics.
- **WHATWG Server-sent events**: https://html.spec.whatwg.org/multipage/server-sent-events.html
  - Scope: HTML Living Standard checked 2026-09-06.
  - Use: event-stream parsing, EventSource lifecycle, and reconnect behavior.
