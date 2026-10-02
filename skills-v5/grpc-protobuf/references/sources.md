# Source map

This map separates protobuf wire evolution from gRPC call behavior. Language-specific generated APIs can differ, so compatibility claims must be exercised with the supported language and runtime versions.

## Adopted principles

- Proto3 field numbers are wire identity and removed field numbers should be reserved to prevent accidental reuse.
- gRPC clients should set realistic deadlines because calls otherwise can wait without an application deadline, and servers should stop work after cancellation.
- Retry policy is method-specific and status-specific. gRPC documents transparent retry separately from configured retry policy and warns that non-idempotent operations are not always safe to retry.
- Status codes carry application-visible failure semantics; callers should not have to infer retry or correction behavior from free-form text alone.

## Conditional or non-adopted recipes

- Proto3 syntax, service config, retry throttling, and language-specific generated APIs are implementation choices, not universal API architecture.
- Rich error details, reflection, health checking, and hedging are optional features and should be adopted only when the service contract needs them.
- No code generator wrapper, schema registry, gateway, or transport proxy is mandated.

## Verification scope

Verify old and new message interoperability, deleted-field reservations, unknown-field handling, deadline and cancellation propagation, retry side effects, status mapping, and streaming backpressure in the actual language runtimes. Documentation alone cannot establish application idempotency.

## Primary sources

- gRPC documentation root: https://grpc.io/docs/
  - Existing navigation source retained from 2026-09-04.
- Protocol Buffers documentation root: https://protobuf.dev/
  - Existing navigation source retained from 2026-09-04.
- Proto3 Language Guide: https://protobuf.dev/programming-guides/proto3/
  - Adopted for field-number reuse, reservations, unknown fields, and wire-compatible schema evolution.
  - Verified 2026-09-06.
- gRPC Deadlines: https://grpc.io/docs/guides/deadlines/
  - Adopted for explicit deadlines, server cancellation, and deadline propagation.
  - Verified 2026-09-06.
- gRPC Retry: https://grpc.io/docs/guides/retry/
  - Adopted for transparent versus configured retries, backoff, and retry policy scope.
  - Verified 2026-09-06.
- gRPC Status Codes: https://grpc.io/docs/guides/status-codes/
  - Adopted for stable failure semantics and retry-relevant status distinctions.
  - Verified 2026-09-06.
