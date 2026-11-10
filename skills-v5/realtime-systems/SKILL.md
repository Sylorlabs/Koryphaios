---
name: realtime-systems
description: Engineer real time client/server systems with connection lifecycle, ordering, fan-out, presence, backpressure, reconnection, and state reconciliation. Use when the request specifically requires websocket, real time updates, realtime connection, server sent events; prefer a narrower child only when its boundary is established.
---

# Realtime Systems

## Responsibility

Define connection identity, authentication refresh, subscription ownership, ordering scope, message IDs, acknowledgement, fanout, presence semantics, heartbeat, backpressure, reconnect/resume, and authoritative state reconciliation. Treat the realtime channel as transport, not the only state source.

Verification focus: Exercise disconnect/reconnect, duplicate/missed/reordered messages, slow clients, auth expiry, sessions across devices, server restart, routing across instances, and recovery from authoritative state.

Failure boundaries: Do not assume persistent ordered connections, keep unbounded queues for each client, trust stale connection identity after token expiry, or make presence a strongly consistent fact without that infrastructure.

## Hierarchy and routing

- Broader skills: network-service-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

## Decision rules

- Choose the transport from directionality and lifecycle needs. WebSocket supports full duplex messaging; server sent events provide a server to client event stream over HTTP with reconnect behavior.
- Define ordering scope, event identity, replay or resume position, and authoritative state before promising continuity across reconnects.
- Advance a resumable cursor only across a contiguous acknowledged prefix in its declared ordering scope. The greatest event ID merely observed is not a safe resume point when gaps, reordering, parallel delivery, or partial processing can occur; track gaps explicitly or reconcile from authoritative state before advancing past them.
- Treat a snapshot as an authoritative state **anchored at its advertised cursor and stream epoch**, not as event number one. On resync, atomically install snapshot state, set the applied/acknowledged cursor to the snapshot's own sequence, discard buffered events at or below it, and apply buffered later events only when the next contiguous sequence is available. A snapshot whose anchor is 500 must permit resume at 501 without waiting for events 1 through 499. On epoch/scope mismatch, expired retention, or unverifiable gaps, require a new snapshot instead of treating an old sequence as globally comparable. Never reset a high water cursor to zero without an explicit new epoch and complete replay from that position.
- Define acknowledgement semantics separately from receipt: acknowledge an event only after it has been applied to authoritative client state (and durably persisted if the contract promises durable processing). Replayed/duplicate events may be acknowledged again but must not repeat effects. Scope cursor/ack ownership to the authenticated subscription and device/session, and define the fate of outstanding ACKs when authorization expires or subscriptions change.
- Treat connection identity and authentication as renewable state. Revalidate or refresh authorization when credentials expire or subscriptions change.
- Bound buffering for each client and define behavior for slow consumers. Dropping, disconnecting, coalescing, or backpressuring are product and transport decisions that must be explicit.
- Treat presence as an inferred signal bounded in time unless the system has stronger consistency infrastructure and a product contract that requires it.
- Specify presence leases or heartbeat TTL, disconnect grace, and expiry semantics. Concurrent devices belonging to the same user can have distinct presence records, subscriptions, and resume cursors; one device's disconnect or ACK must not invalidate or advance another's delivery state unless the product explicitly defines a shared cursor.
- For fanout across instances, name the authoritative event log and retention/replay owner, how clients find or move between instances, how subscriptions are routed, and how a reconnect or instance restart uses the same epoch plus ordering scope. An edge/CDN proxy can preserve upgrade/timeout behavior but cannot itself supply durable replay, authorization, or event ordering across instances.

## Observable checks

- Force disconnect and reconnect while traffic is active and verify the documented resume, replay, or reconciliation behavior.
- Inject duplicate, missed, and reordered application messages where the protocol or scale-out path can produce them.
- Create a gap, deliver a later event, reconnect from the recorded resume position, and prove the missing event is replayed or recovered rather than skipped by a max-observed cursor.
- Force a too-old cursor to trigger snapshot resync at an anchor far above sequence one, then deliver later events out of order and prove progress resumes from the snapshot anchor without either skipping a gap or waiting for the beginning of history. Exercise a changed stream epoch independently of a same-epoch server restart.
- Throttle a client and measure queue growth, coalescing, backpressure, or disconnect behavior against the configured bound.
- Expire credentials during an active connection and verify subscription and identity handling.
- Exercise two subscriptions/devices under the same user, asynchronous ACK, a lost ACK with replay, and presence TTL expiry. Verify one device does not silently inherit the other's applied cursor, and authorization loss closes or revalidates the relevant subscription.
- Restart or move a server instance and verify catch-up from authoritative state rather than relying on a connection surviving indefinitely.
- Run the targeted tests and preserve actual exit status plus assertions for reconnect, gap, anchored snapshot, epoch change, slow client, ACK, and presence cases. Execute the smallest meaningful suite early, then broaden to the full runtime suite when time permits; test files merely authored or a command started without its result do not establish verification. State explicitly if a wall clock limit prevented test completion.

## Completion evidence

- Transport and state-reconciliation decision with ordering and reconnect scope.
- Disconnect, slow-client, auth-expiry, ACK, snapshot anchor, multi-device presence, and restart results observed in the exercised environment, with the actual test commands and exit statuses.
- Explicit unknowns for production fan-out topology, network intermediaries, and scale behavior.

Routing, hierarchy selection, and paired skill/no skill provenance are evaluator-owned. Do not create meta-level selection narratives or claim paired-run evidence as agent-observed work; keep the deliverable focused on connection behavior, state reconciliation, and concrete transport boundaries.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
