---
name: realtime-systems
description: Engineer real-time client/server systems with connection lifecycle, ordering, fan-out, presence, backpressure, reconnection, and state reconciliation. Use when the request specifically requires websocket, real time updates, realtime connection, server sent events; prefer a narrower child only when its boundary is established.
---

# Realtime Systems

## Responsibility

Define connection identity, authentication refresh, subscription ownership, ordering scope, message IDs, acknowledgement, fan-out, presence semantics, heartbeat, backpressure, reconnect/resume, and authoritative state reconciliation. Treat the realtime channel as transport, not the only state source.

Verification focus: Exercise disconnect/reconnect, duplicate/missed/reordered messages, slow clients, auth expiry, multi-device sessions, server restart, scale-out routing, and catch-up from authoritative state.

Failure boundaries: Do not assume persistent ordered connections, keep unbounded per-client queues, trust stale connection identity after token expiry, or make presence a strongly consistent fact without that infrastructure.

## Hierarchy and routing

- Broader skills: network-service-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

## Decision rules

- Choose the transport from directionality and lifecycle needs. WebSocket supports full duplex messaging; server-sent events provide a server-to-client event stream over HTTP with reconnect behavior.
- Define ordering scope, event identity, replay or resume position, and authoritative state before promising continuity across reconnects.
- Advance a resumable cursor only across a contiguous acknowledged prefix in its declared ordering scope. The greatest event ID merely observed is not a safe resume point when gaps, reordering, parallel delivery, or partial processing can occur; track gaps explicitly or reconcile from authoritative state before advancing past them.
- Treat connection identity and authentication as renewable state. Revalidate or refresh authorization when credentials expire or subscriptions change.
- Bound per-client buffering and define slow-consumer behavior. Dropping, disconnecting, coalescing, or backpressuring are product and transport decisions that must be explicit.
- Treat presence as an inferred, time-bounded signal unless the system has stronger consistency infrastructure and a product contract that requires it.

## Observable checks

- Force disconnect and reconnect while traffic is active and verify the documented resume, replay, or reconciliation behavior.
- Inject duplicate, missed, and reordered application messages where the protocol or scale-out path can produce them.
- Create a gap, deliver a later event, reconnect from the recorded resume position, and prove the missing event is replayed or recovered rather than skipped by a max-observed cursor.
- Throttle a client and measure queue growth, coalescing, backpressure, or disconnect behavior against the configured bound.
- Expire credentials during an active connection and verify subscription and identity handling.
- Restart or move a server instance and verify catch-up from authoritative state rather than relying on a connection surviving indefinitely.

## Completion evidence

- Transport and state-reconciliation decision with ordering and reconnect scope.
- Disconnect, slow-client, auth-expiry, and restart results for the exercised environment.
- Explicit unknowns for production fan-out topology, network intermediaries, and scale behavior.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
