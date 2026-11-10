# Source map

This map separates protobuf wire evolution from gRPC call behavior. Generated APIs that are specific to a language can differ, so compatibility claims must be exercised with the supported language and runtime versions.

## Adopted principles

- Proto3 field numbers are wire identity and removed field numbers should be reserved to prevent accidental reuse.
- Protobuf declaration full names, field presence, unknown fields, and enum numerics need an explicit application compatibility review. Binary wire safety does not automatically establish ProtoJSON, TextFormat, generated API, or business compatibility.
- gRPC clients should set realistic deadlines because calls otherwise can wait without an application deadline, and servers should stop work after cancellation.
- Retry policy is specific to the method and the status. gRPC documents transparent retry separately from configured retry policy and warns that operations which are not idempotent are not always safe to retry.
- Status codes carry failure semantics that the application can see; callers should not have to infer retry or correction behavior from free form text alone.
- Interceptors are ordered per RPC layers. Authentication, authorization, limits, telemetry, and error mapping need an explicit order and must preserve denial, cancellation, and terminal status semantics.
- TLS or mTLS authenticates the transport or peer, while call credentials and authorization establish the caller's permitted operation. Metadata is a bounded side channel and must not be treated as an untrusted routing authority.
- Name resolution and service configuration determine target routing, method configuration, load balancing, deadlines, and retries for a target. A method route or fallback must remain explicit and authenticated.

## Conditional recipes that were not adopted

- Proto3 syntax, service config, retry throttling, and generated APIs that are specific to a language are implementation choices, not universal API architecture.
- Rich error details, reflection, health checking, and hedging are optional features and should be adopted only when the service contract needs them.
- No code generator wrapper, schema registry, gateway, or transport proxy is mandated.
- No language independent interceptor order, TLS profile, metadata limit, message size limit, reflection policy, or resolver implementation is mandated. Choose and verify those at the service boundary.

## Verification scope

Verify interoperability between old and new messages, declaration identities, reservations for deleted fields, field presence and precedence, handling of unknown fields and enum numerics, deadline and cancellation propagation, retry side effects, status and detail mapping, interceptor order, authorization and limit rejection, target and method routing, peer verification, redaction, and streaming backpressure in the actual language runtimes. Documentation alone cannot establish application idempotency or transport security.

## Primary sources

- gRPC documentation root: https://grpc.io/docs/
  - Existing navigation source retained from 2026-09-04.
- Protocol Buffers documentation root: https://protobuf.dev/
  - Existing navigation source retained from 2026-09-04.
- Proto3 Language Guide: https://protobuf.dev/programming-guides/proto3/
  - Adopted for reuse of field numbers, reservations, unknown fields, and schema evolution that stays compatible on the wire.
  - Verified 2026-11-07.
- Protobuf Encoding: https://protobuf.dev/programming-guides/encoding/
  - Adopted for field tags, wire types, packed values, and the distinction between serialized bytes and application meaning.
  - Verified 2026-10-17.
- Protobuf Enum Behavior: https://protobuf.dev/programming-guides/enum/
  - Adopted for language differences in open and closed enum handling and preservation of unknown numeric values.
  - Verified 2026-10-17.
- gRPC Interceptors: https://grpc.io/docs/guides/interceptors/
  - Adopted for per RPC interceptor scope, use cases, and order dependent behavior.
  - Verified 2026-10-17.
- gRPC Flow Control: https://grpc.io/docs/guides/flow-control/
  - Adopted for receiver driven streaming flow control and the distinction between an application write and bytes sent on the network.
  - Verified 2026-10-17.
- gRPC Authentication: https://grpc.io/docs/guides/auth/
  - Adopted for TLS, mTLS, channel credentials, call credentials, and server side credential validation.
  - Verified 2026-10-17.
- gRPC Metadata: https://grpc.io/docs/guides/metadata/
  - Adopted for metadata as an HTTP/2 header and trailer side channel, reserved keys, and bounded request header considerations.
  - Verified 2026-10-17.
- gRPC Error Handling: https://grpc.io/docs/guides/error/
  - Adopted for stable status handling and optional structured error details at the caller boundary.
  - Verified 2026-10-17.
- gRPC Service Config: https://grpc.io/docs/guides/service-config/
  - Adopted for target scoped method configuration, deadlines, retries, wait for ready, health checks, and load balancing.
  - Verified 2026-10-17.
- gRPC Custom Name Resolution: https://grpc.io/docs/guides/custom-name-resolution/
  - Adopted for target schemes, resolver ownership, service discovery, and resolver supplied service configuration.
  - Verified 2026-10-17.
- gRPC Deadlines: https://grpc.io/docs/guides/deadlines/
  - Adopted for explicit deadlines, server cancellation, and deadline propagation.
  - Verified 2026-11-07.
- gRPC Retry: https://grpc.io/docs/guides/retry/
  - Adopted for transparent versus configured retries, backoff, and retry policy scope.
  - Verified 2026-11-07.
- gRPC Status Codes: https://grpc.io/docs/guides/status-codes/
  - Adopted for stable failure semantics and status distinctions that matter for retries.
  - Verified 2026-11-07.
