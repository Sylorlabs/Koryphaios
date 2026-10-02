---
name: api-contract-design
description: Design APIs around stable resource and action semantics, types, compatibility, errors, pagination, idempotency, observability, and lifecycle. Use when the request specifically requires api design, public api contract, sdk api surface, api versioning; prefer a narrower child only when its boundary is established.
---

# Api Contract Design

Model caller visible concepts and journeys before choosing transport syntax. Define identity, lifecycle, validation, errors, pagination, ordering, idempotency, concurrency, authorization context, deprecation, and compatibility. Keep storage details private unless they are intentionally part of the public contract.

Keep the requested contract surface as the scope boundary. Do not redesign adjacent APIs, introduce a new transport, or add a version dimension merely because another convention looks cleaner. If the requested contract cannot satisfy a demonstrated requirement, make the conflict explicit before changing the public surface.

## Completion gate

An executable contract change is complete only when every applicable obligation below is present in the maintained artifact set.

1. The caller contract is explicit. When the request asks to specify, evolve, or migrate a contract, update a maintained schema, contract document, or caller example that states the changed behavior.
2. The implementation matches that contract.
3. Maintained tests assert every changed caller promise and every semantic partition with a different outcome. Add or update those tests in the same change unless existing maintained tests already prove the behavior.
4. Prior supported callers remain covered when compatibility matters, including the old request shape, old enum behavior, object identity, or other observable semantics that could regress.
5. Relevant negative and recovery paths are exercised.

Do not trade one obligation for another. Hidden checks, ad hoc probes, generated artifacts, or prose alone do not replace maintained regression coverage.

## Transferable decisions

- Define business identity and lifecycle before endpoints or fields. Keep persistence identity private unless it is also the stable public identity.
- Make validation, error identity, retryability, pagination ordering, concurrency behavior, authorization context, defaults, optionality, nullability, and server owned values explicit so callers do not infer conflicting semantics.
- Treat a change as breaking when an interaction that was valid under the prior contract can become invalid or change meaning. For staged migrations, state the old and new supported surfaces, coexistence window, deprecation signal, telemetry used to decide removal, and removal condition.
- For pagination, define a stable total order, tie breakers, concurrent write semantics, cursor scope, expiry, and invalid cursor behavior. A continuation cursor should encode or reference the position needed for stable traversal rather than depend on a shifting offset.
- If a caller supplied token must resist tampering, use authenticated integrity such as an appropriate keyed MAC, authenticated encryption, signature, or opaque server state. A checksum detects corruption but does not authenticate. Keep signing material outside source code and make key ownership and rotation explicit.
- For authenticated text tokens, define one canonical serialization and text encoding. Reject a supplied encoded segment when decoding and reencoding it does not reproduce the exact original string before accepting its authentication result. This prevents alternate textual encodings of the same bytes from creating multiple accepted token spellings. Exercise tampering at the payload and authenticator boundaries, including the final encoded character.
- Do not make a new runtime secret, environment variable, service, or deployment setting required unless the task or environment provides that contract. Reuse an established configuration seam. When configuration is outside scope and no seam exists, prefer a process owned or injectable signer with its lifecycle limit stated, or opaque server state when appropriate.
- Treat enum expansion as a compatibility event when installed clients may use closed or strict decoders. Define unknown value behavior or a compatibility adaptation and exercise an old client against the new server value.
- For in process and SDK contracts, object identity, aliasing, mutability, retained metadata, and live versus snapshot behavior are caller visible semantics. Do not introduce copies, wrappers, normalization, or caching without compatibility evidence.
- Delegate protocol specific semantics to the matching child. HTTP methods and caching belong to `http-rest-engineering`; GraphQL type evolution belongs to `graphql-engineering`; protobuf wire compatibility belongs to `grpc-protobuf`.

## Verification

Read maintained contract tests before implementation and map each changed caller promise to an assertion. Exercise each semantic partition with a different outcome, including lifecycle state, version, enum value, error class, authorization state, pagination boundary, retry, or recovery when applicable.

Compare the new contract with the prior supported surface. Test through the same objects and calls real callers observe, including mutation or retained references when mutable in process objects are exposed. Run executable examples in the repository documented environment and validate machine readable contracts separately from executable behavior.

## Failure boundaries

Do not expose persistence tables directly, collapse semantic failures into success shaped responses, add breaking fields or enum behavior casually, force callers to infer retryability, use an unauthenticated checksum as tamper protection, hard code token signing material, or add a version dimension without a concrete compatibility need. Do not silently substitute a different transport, schema shape, or reduced contract when the requested mechanism fails. Surface the incompatibility and verify any necessary change against caller obligations.

## Hierarchy and routing

- Broader skills: `developer-experience`.
- Narrower children: `graphql-engineering`, `grpc-protobuf`, `http-rest-engineering`.
- Required skills: verification.

Route here for transport neutral API shape, lifecycle, compatibility, pagination, error semantics, and caller visible contract decisions. Compose the matching child when the request specifically needs HTTP, GraphQL, or gRPC and protobuf semantics.

## Completion evidence

Report the contract difference from the prior supported caller surface, required maintained caller artifact, representative success and negative and compatibility and recovery results, and residual compatibility risk that could not be exercised.

Use [the maintained source map](references/sources.md) for facts that depend on a version and for source conflicts.
