---
name: grpc-protobuf
description: Engineer gRPC and Protocol Buffers contracts with wire compatibility, deadlines, streaming, status semantics, retries, and schema evolution. Use when the request specifically requires grpc, protobuf, protocol buffers, grpc streaming; prefer a narrower child only when its boundary is established.
---

# Grpc Protobuf

## Responsibility

Treat field numbers, wire types, protobuf declaration identity, and fully qualified RPC method names as durable compatibility. Define unary and streaming lifecycle, deadlines, cancellation, metadata, status and details, idempotency, retry policy, flow control, interceptors, routing, transport security, and generated client/server versioning. Reserve removed field numbers and names.

## Transferable decisions

- Treat protobuf field numbers as durable wire identity. When a field is removed, reserve its number and usually its name so later schemas cannot reinterpret stored bytes or bytes still in flight.
- Preserve the fully qualified identity of an evolved declaration unless the task explicitly introduces a separate API/type. Changing a package, message name, or service name creates a different protobuf identity; a later schema for the same contract, including one prepared for an earlier migration stage, should keep that identity while fields are deprecated, removed, and reserved. If a new identity is intentional, treat it as a parallel contract and plan migration between the two instead of presenting it as evolution in place.
- Treat unknown enum numerics as wire values that later revisions must continue to read. If a decoder exposes an unknown numeric, the normal serializer or relay path must preserve that exact value rather than coercing or rejecting it merely because an older representation lacks an equivalent semantic value. During dual write across mixed versions, keep transparent relay separate from constructing a new request when the legacy field cannot truthfully represent the unknown value.
- Treat field presence as part of the contract. Do not silently replace absent, explicitly defaulted, legacy, and replacement values with one indistinguishable application state. If a migration uses a legacy field and a replacement field, define precedence, dual write rules, the removal stage, and the behavior when the replacement carries an unknown value. When a decode path derives the replacement value from the legacy field, fill the replacement completely, including the numeric representation of the mapped enum member, so a decoded message never carries a set symbol alongside an absent or null numeric that a later serializer or relay would then write as an empty value.
- Review compatibility in both directions when old and new clients or servers can overlap. A schema can parse successfully yet change application meaning. Binary wire compatibility does not by itself establish ProtoJSON, TextFormat, generated API, or business compatibility.
- During the overlap window a writer that knows the replacement value must populate the replacement field and the legacy field together, so an old reader and a new reader both observe the meaning they understand. Never translate the replacement value down into the legacy field alone: dropping the replacement field removes the evidence later stages and newer readers depend on, and it makes the write indistinguishable from a client that only ever knew the legacy shape. Only fall back to the legacy field alone when the replacement value has no faithful legacy representation, and state that case explicitly.
- Keep method identity stable during RPC evolution. The service method's fully qualified path, package, service, request type, and response type are part of the dispatch contract. If a new method or package is intentional, register it as a parallel route and define how callers migrate rather than treating it as an in place rename.
- Set realistic client deadlines derived from the latency needs of the whole call path and propagate or budget them across downstream RPCs. A server must stop unnecessary work after cancellation where the language runtime does not do so automatically.
- Map application failures to stable gRPC status semantics so callers can distinguish invalid input, failed preconditions, resource exhaustion, transient unavailability, deadline, cancellation, and authentication or authorization failures. Preserve structured error details only when their type, audience, size, and privacy are defined; do not turn an internal error into OK or leak stack traces, credentials, or tenant data in messages or trailers.
- Configure retries only for methods whose replay semantics are understood. Transport retry policy cannot make an application operation that is not idempotent safe.
- Treat interceptors as ordered per RPC policy layers. Establish which layer authenticates and authorizes, which layer enforces message and metadata limits, which layer records redacted telemetry, and which layer maps errors. An interceptor must short circuit denied calls, preserve cancellation and terminal status, and must not be mistaken for TLS, connection, or service configuration.
- Make routing explicit. Record the target authority, TLS server name, name resolver, service config, load balancing policy, method match, and fallback behavior. Do not let untrusted metadata or an arbitrary target string select a privileged backend or bypass method authorization.
- Define a transport and identity boundary before sending credentials. Use the language's supported TLS or mTLS configuration, verify the peer name and trust chain, bind call credentials to the intended authority and scope, reject reserved or oversized metadata, and keep authorization decisions at the server boundary. Reflection, health, debug, and admin methods need an explicit exposure and authorization policy.
- Bound message sizes, metadata, decompression, concurrent streams, and application queues according to the service budget. A transport or parser limit is part of availability and security behavior, and an exceeded limit must fail closed without partial privileged work.

## Observable checks

- Run fixtures that pair old clients with new servers and new clients with old servers for changed messages and methods, including unknown fields and reservations for deleted fields.
- For schema evolution made in place, compare descriptor full names (package plus message/service name) across revisions as well as field numbers/types. Test an intentional identity fork separately from compatibility of the original declaration.
- Exercise unknown enum numerics through the same decode and encode path used by the application or relay. Copying the original bytes around a serializer that rejects the decoded unknown value does not establish round trip compatibility.
- Keep executable regression tests with the change. For message evolution, cover old binary read by a new reader and new binary written for an old reader or server during the compatibility window, precedence between legacy and replacement fields, and unknown enum and field round trips; each case must assert decoded values, wire markers, or preserved bytes rather than merely calling an encoder/decoder. For streaming fixes, retain tests for slow readers, cancellation, deadlines, downstream errors, half close, bounded queues, and resource cleanup; assert terminal status, received values, queue bounds, producer shutdown, and resource release rather than relying on a patch limited to the implementation or on test names that only echo keywords.
- Force a deadline to expire during server work and verify the client status, server cancellation handling, and downstream deadline propagation where supported.
- Exercise status codes that are retryable and those that are not, and verify the configured retry count, backoff, and externally visible side effects.
- For streaming RPCs, test half close, cancellation, slow consumers, bounded buffering, and backpressure behavior.
- Exercise interceptor order and short circuit behavior with allowed, unauthenticated, unauthorized, oversized, malformed, and handler-error calls. Assert that sensitive metadata is redacted, denied calls have no handler side effect, the original terminal status and details survive wrapping, and a second interceptor cannot overwrite a chosen terminal outcome.
- Exercise target and method routing with an intended backend, an unavailable or mismatched route, a changed authority or certificate name, and a method-specific service config. Assert that fallback is explicit and that route selection does not weaken authentication or authorization.
- Exercise TLS or mTLS peer verification, call credential scope, metadata limits, inbound and outbound message limits, decompression limits where supported, and reflection or admin method exposure. Mark simulated security boundaries separately from tests over a real channel.
- Generate or compile representative clients for supported languages, then still execute interoperability tests at the wire level.

## Execution under a time budget

- Select observable checks for the contract surface actually changed. Field evolution needs schema identity, behavior on old and new versions of the wire, and reservation evidence; streaming lifecycle work needs flow control, terminal status, cancellation, and cleanup evidence. Include every requirement of the requested change, but do not spend a bounded task running checks for unrelated RPC features.
- For RPC boundary work, identify the route and interceptor chain before testing handlers. Security checks need an allowed call, a denied call, and an independent no-effect check; routing checks need the target, resolver or service config, selected method/backend, and a negative route.
- Identify runnable tests and available compilers/generators early. For a staged field migration, inspect the active declarations and the declarations for later migration stages, complete the related schema and application codec changes, and run targeted tests that span both versions before optional hardening. For streaming work, establish the lifecycle behavior and run focused stream regressions before optional stress repetitions.
- After a failed check, fix its cause and rerun the affected tests. Preserve time for a final verification run and an accurate completion report; avoid speculative expansion into edge cases, repeated broad suites, or installing optional tooling when these would displace required evidence. Report unavailable generators or compilers separately from executable runtime results. Prioritization changes work order, not compatibility requirements or verification standards.

## Failure boundaries

Do not reuse removed field numbers, rename or repackage a declaration merely to express a later migration stage, reinterpret a legacy field without a presence and precedence contract, depend accidentally on how an enum behaves for unknown values, claim round trip support for unknown enums by bypassing a serializer that rejects the decoded value, ignore deadlines, or enable retries without idempotency analysis. Do not let metadata choose an untrusted route, use an interceptor as a substitute for transport security, expose credentials or internal details in logs and errors, or accept unbounded messages and queues. Do not treat compilation of generated code as proof of runtime compatibility across versions.

## Hierarchy and routing

- Broader skills: api-contract-design.
- No narrower bundled child is declared.
- Required skills: verification.

Route here when protobuf wire compatibility, gRPC lifecycle, deadlines, cancellation, status codes, retries, streaming behavior, RPC interceptors, method routing, or gRPC transport and metadata security is central. Keep public API lifecycle and product semantics that are neutral to the transport in `api-contract-design`; keep broad listener and deployment behavior in `network-service-backend`; compose `application-security`, `authorization-security`, or `security-verification` when their independent security boundary is central.

## Completion evidence

- Message and RPC interoperability results across versions.
- Descriptor or generated symbol evidence that fully qualified declaration identities stayed stable for evolution in place, or explicit migration evidence when a new identity was intentionally introduced.
- Method route and interceptor chain evidence, including authorization, limit rejection, redaction, and preserved terminal status.
- Transport security, metadata, message-limit, and no-effect evidence for changed methods.
- Deadline, cancellation, retry, and status code evidence for changed methods.
- Streaming backpressure and disconnect evidence when streaming is in scope.
- Compatibility results for generated clients, kept separate from runtime wire evidence.

Use [the verification workflow for bounded tasks](references/verification-workflow.md) to order contract work and checks, and [the maintained source map](references/sources.md) for facts that vary by version and for source conflicts.
