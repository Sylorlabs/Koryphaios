---
name: grpc-protobuf
description: Engineer gRPC and Protocol Buffers contracts with wire compatibility, deadlines, streaming, status semantics, retries, and schema evolution. Use when the request specifically requires grpc, protobuf, protocol buffers, grpc streaming; prefer a narrower child only when its boundary is established.
---

# Grpc Protobuf

## Responsibility

Treat field numbers and wire types as durable compatibility. Define unary/streaming lifecycle, deadlines, cancellation, metadata, status/details, idempotency, retry policy, flow control, and generated client/server versioning. Reserve removed field numbers/names.

## Transferable decisions

- Treat protobuf field numbers as durable wire identity. When a field is removed, reserve its number and usually its name so later schemas cannot reinterpret stored or in-flight bytes.
- Review compatibility in both directions when old and new clients or servers can overlap. A schema can parse successfully yet change application meaning.
- Set realistic client deadlines from end-to-end latency needs and propagate or budget them across downstream RPCs. A server must stop unnecessary work after cancellation where the language runtime does not do so automatically.
- Map application failures to stable gRPC status semantics so callers can distinguish invalid input, precondition failure, resource exhaustion, transient unavailability, and authentication or authorization failures.
- Configure retries only for methods whose replay semantics are understood. Transport retry policy cannot make a non-idempotent application operation safe.

## Observable checks

- Run old-client/new-server and new-client/old-server fixtures for changed messages and methods, including unknown fields and deleted-field reservations.
- Force a deadline to expire during server work and verify the client status, server cancellation handling, and downstream deadline propagation where supported.
- Exercise retryable and non-retryable status codes and verify configured retry count, backoff, and externally visible side effects.
- For streaming RPCs, test half-close, cancellation, slow consumers, bounded buffering, and backpressure behavior.
- Generate or compile representative clients for supported languages, then still execute wire-level interoperability tests.

## Failure boundaries

Do not reuse removed field numbers, depend accidentally on enum unknown-value behavior, ignore deadlines, or enable retries without idempotency analysis. Do not treat generated-code compilation as proof of cross-version runtime compatibility.

## Hierarchy and routing

- Broader skills: api-contract-design.
- No narrower bundled child is declared.
- Required skills: verification.

Route here when protobuf wire compatibility, gRPC lifecycle, deadlines, cancellation, status codes, retries, or streaming behavior is central. Keep transport-neutral public API lifecycle and product semantics in `api-contract-design`.

## Completion evidence

- Cross-version message and RPC interoperability results.
- Deadline, cancellation, retry, and status-code evidence for changed methods.
- Streaming backpressure and disconnect evidence when streaming is in scope.
- Generated-client compatibility results separated from runtime wire evidence.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
