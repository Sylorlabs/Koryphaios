---
name: network-service-backend
description: Build and repair network-facing services, including transport framing, backpressure, request lifecycles, graceful draining, protocol contracts, and authorization. Use when the behavior of a network listener or service boundary is central to the request.
---

# Network Service Backend

## Establish the actual service boundary

Identify the clients and their supported versions, network protocol, transport and authentication, trust zones, deployment and process topology, and the authoritative owner of each request or durable effect. Record request/response and error semantics, payload size, latency, concurrency, compatibility, idle timeout and resource budgets. Choose HTTP, RPC, raw streams, or messaging from these contracts; do not assume REST, internet exposure, or a distributed deployment.

Trace the actual listener through admission, validation, authorization, request handling, response flushing, and teardown. Define which component owns retries, cancellation and deadlines, and what a client can safely repeat after losing the reply. Check authorization on each operation and resource, not merely on opening a socket. Keep secrets and internal failures out of protocol responses.

## Repair byte streams and outbound pressure

- **Preserve message boundaries.** TCP reads can split a header, split a body, or join several messages. For a protocol with length prefixes, accumulate the incomplete header, validate its declared size against the configured maximum _before_ allocating or copying its body, emit all complete frames in order, and retain only the incomplete suffix. Treat frames with zero length according to the protocol contract. A single successful read of a whole frame proves very little.
- **Bound input state.** Set a maximum frame size and a bounded parser buffer. Test a partial header followed by an oversized length, a truncated final body, repeated tiny fragments, several concatenated frames, and a complete frame followed by a partial one. Reject malformed input explicitly and release parser state on disconnect or timeout.
- **Bound output state.** Measure queued bytes, not just message count. Before enqueueing, verify the total fits the configured capacity; on refusal leave the old queue and counters intact and signal the caller to wait, reject or close according to policy. Partial writes reduce queued bytes only when the transport actually accepts them. Slow or disconnected readers must not hold unlimited memory.
- **Respect half close and cancellation.** Distinguish peer EOF, an idle timeout, a canceled request, a pending write and a hard transport error. Clean up timers, queued buffers and listeners deterministically, preserving already committed effects. The appropriate response to a half close depends on the protocol; do not erase work in flight on every read EOF.

## Drain a service without losing admitted work

1. **Stop new admission first.** On shutdown, reject new requests/connections and advertise unready status where supported. Preserve already admitted requests, including streaming, calls that are not idempotent, and handshake transitions, while their applicable completion policy runs. Merely closing all active entries is an immediate abort, not a graceful drain.
2. **Track each boundary to its real outcome.** Distinguish active, finished, canceled and forcibly terminated work. Stop opening new persistent streams, allow eligible operations in flight to finish, and apply an explicit bounded deadline to stragglers. Only at that deadline terminate remaining work and account for its incomplete status.
3. **Make refusal distinguishable from failure.** A connection or request refused because the service is draining must be observable as a refusal, not as a lost peer: answer with the protocol's unready or retryable status, and close only after that refusal is written. A bare close of a newly accepted connection during drain is indistinguishable from a crash, so a client cannot tell whether to retry elsewhere or treat its request as failed. The same applies to admitting a request after the drain started: reject it explicitly rather than accepting it and abandoning it mid-flight.
4. **Prevent duplicate durable effects.** A request whose effect committed but whose reply was interrupted is ambiguous to the client. Use stable request identities with a durable effect/idempotency record when the operation needs replay protection. A request map in memory or a successful connection close cannot prove that side effects occur exactly once across restart.
5. **Verify restart and rollout behavior.** Test drain during an idle connection, a partial frame, a stream, a TLS handshake, and before/after a commit that is not idempotent. Verify old/new clients, deadline exhaustion, duplicate retry, and resumption or reconciliation of interrupted work. Distinguish a simulation within one process from live transport and deployment evidence.

## Completion evidence

Report the selected service and protocol boundary, trust/auth contract, wire formats, limits, retry/cancellation and shutdown ownership. Run tests of success paths and negative paths over the actual transport when available, including fragmented/coalesced input, oversized frames, slow readers, disconnects, draining of work in flight, replay of calls that are not idempotent and deadline recovery. Measure buffered/queued bytes, remaining active work, errors visible to users and latency at the claimed load. Clearly label synthetic tests and any untested production behavior.

`backend-engineering` owns the broader service state and architecture. Select a narrower child when the work is specifically about CDN edges, network stack protocols, real time feeds or serverless platform behavior; compose it with this skill only when network service lifecycle work remains. Contract design specific to a protocol may also belong to `api-contract-design`, `http-rest-engineering` or `grpc-protobuf` rather than changing a listener.

Use [the maintained source map](references/sources.md) for facts that vary by version and source conflicts.
