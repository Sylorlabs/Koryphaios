---
name: api-contract-design
description: Design and evolve public API and SDK contracts around caller identity, lifecycle, errors, retries, pagination, and compatibility. Use when defining caller promises or preserving installed clients during an API change. Compose HTTP, GraphQL, or gRPC guidance for protocol semantics; backend implementation alone belongs elsewhere.
---

# API Contract Design

Model caller visible concepts and journeys before choosing transport syntax. Define identity, lifecycle, validation, errors, pagination, ordering, idempotency, concurrency, authorization context, deprecation, and compatibility. Keep storage details private unless they are intentionally part of the public contract.

Keep the requested contract surface as the scope boundary. Do not redesign adjacent APIs, introduce a new transport, or add a version dimension merely because another convention looks cleaner. If the requested contract cannot satisfy a demonstrated requirement, make the conflict explicit before changing the public surface.

Before editing any contract document, distinguish an **existing normative reference** from the contract artifact the task actually asks you to author. A supplied compatibility specification that already defines the requested caller promises is acceptance evidence: preserve its original text unless an authorized requirement explicitly calls for changing that document. Implement its promises in source and maintained tests. Put additional migration decisions or runnable examples in a separate owned document when needed; rewriting a reference specification for clarity can invalidate an otherwise correct implementation.

Record the starting bytes or digest of a protected reference and compare them after the change. Preserve its path as well as its content; moving, appending to, or regenerating it is still a contract change.

For a repository implementation task, turn the caller promises into executable changes early. Locate the existing public artifact, implementation entry point, and maintained caller tests; identify what prior callers actually send and observe. Make the smallest cohesive change to the contract and implementation that can exercise one real caller path, run its focused test, then add the compatibility and failure cases that distinguish the old and new semantics. Iterate from the first concrete test failure instead of spending the execution window on a contract proposal without working code. Preserve the project's existing test and deployment interfaces; do not rewrite fixtures or loosen assertions to manufacture success.

## Completion gate

An executable contract change is complete only when every applicable obligation below is present in the maintained artifact set.

1. The caller contract is explicit. When the request asks to specify, evolve, or migrate a contract, ensure a maintained schema, contract document, or caller example states the changed behavior. Author or update an owned artifact only where the supplied normative reference leaves a genuine gap or the task explicitly authorizes its change.
2. The implementation matches that contract.
3. Maintained tests assert every changed caller promise and every semantic partition with a different outcome. Add or update those tests in the same change unless existing maintained tests already prove the behavior.
4. Prior supported callers remain covered when compatibility matters, including the old request shape, old enum behavior, object identity, or other observable semantics that could regress.
5. Relevant negative and recovery paths are exercised.

Do not trade one obligation for another. Hidden checks, ad hoc probes, generated artifacts, or prose alone do not replace maintained regression coverage.

## Transferable decisions

- Define business identity and lifecycle before endpoints or fields. Keep persistence identity private unless it is also the stable public identity.
- Make validation, error identity, retryability, pagination ordering, concurrency behavior, authorization context, defaults, optionality, nullability, and server owned values explicit so callers do not infer conflicting semantics.
- Keep the public failure surface closed over the published taxonomy. A caller visible failure carries only the contract's own error code, retryability and terminality markers, and a message written for a caller. Internal dependency identities such as driver, datastore, shard, queue or table names, hostnames, ports, upstream status text, driver error codes, and stack traces never reach the payload; map them to the public code at the boundary and keep the internal detail in server side telemetry. When an internal component is temporarily unavailable, report the public transient failure for the operation, not the name of the component that failed.
- For idempotent mutations, specify which request fields determine semantic identity, whether equivalent optional values normalize together, what a replay returns, and the conflict behavior for key reuse with different requests. A retry must not create a second logical operation.
- Treat a change as breaking when an interaction that was valid under the prior contract can become invalid or change meaning. For staged migrations, state the old and new supported surfaces, coexistence window, deprecation signal, telemetry used to decide removal, and removal condition.
- For pagination, define a stable total order, tie breakers, concurrent write semantics, cursor scope, expiry, and invalid cursor behavior. A continuation cursor should encode or reference the position needed for stable traversal rather than depend on a shifting offset.
- For combined retry, cursor, enum, or staged client migrations, read [caller compatibility and continuation procedures](references/caller-compatibility.md) before implementation. Preserve the existing callers and the new behavior in different test partitions.
- If a caller supplied token must resist tampering, use authenticated integrity such as an appropriate keyed MAC, authenticated encryption, signature, or opaque server state. A checksum detects corruption but does not authenticate. Keep signing material outside source code and make key ownership and rotation explicit.
- Do not make a new runtime secret, environment variable, service, or deployment setting required unless the task or environment provides that contract. Reuse an established configuration seam. When configuration is outside scope and no seam exists, prefer a process owned or injectable signer with its lifecycle limit stated, or opaque server state when appropriate.
- Treat enum expansion as a compatibility event when installed clients may use closed or strict decoders. Define unknown value behavior or a compatibility adaptation and exercise an old client against the new server value.
- For in process and SDK contracts, object identity, aliasing, mutability, retained metadata, and live versus snapshot behavior are caller visible semantics. Do not introduce copies, wrappers, normalization, or caching without compatibility evidence.
- Delegate protocol specific semantics to the matching child. HTTP methods and caching belong to `http-rest-engineering`; GraphQL type evolution belongs to `graphql-engineering`; protobuf wire compatibility belongs to `grpc-protobuf`.

## Verification

Read maintained contract tests before implementation and map each changed caller promise to an assertion. Exercise each semantic partition with a different outcome, including lifecycle state, version, enum value, error class, authorization state, pagination boundary, retry, or recovery when applicable.

Compare the new contract with the prior supported surface. Test through the same objects and calls real callers observe, including mutation or retained references when mutable in process objects are exposed. Run executable examples in the repository documented environment and validate machine readable contracts separately from executable behavior.

For a repair with a known defective starting implementation, run the maintained regression tests on the repair and on that starting implementation, then restore the repair. Require a behavioral assertion to reject the original defect, rather than a missing import, syntax error, test name, or keyword. Report which caller promises each test proves; rejection of one original defect does not establish coverage of every partition.

## Failure boundaries

Do not expose persistence tables directly, collapse semantic failures into success shaped responses, add breaking fields or enum behavior casually, force callers to infer retryability, use an unauthenticated checksum as tamper protection, hard code token signing material, or add a version dimension without a concrete compatibility need. Do not silently substitute a different transport, schema shape, or reduced contract when the requested mechanism fails. Surface the incompatibility and verify any necessary change against caller obligations.

## Hierarchy and routing

- Broader skills: `developer-experience`.
- Narrower children: `graphql-engineering`, `grpc-protobuf`, `http-rest-engineering`.
- Required skills: verification.

Route here for transport neutral API shape, lifecycle, compatibility, pagination, error semantics, and caller visible contract decisions. Compose the matching child when the request specifically needs HTTP, GraphQL, or gRPC and protobuf semantics.

`backend-engineering` owns service implementation when caller promises are already fixed. `migration-planning` owns rollout coordination across consumers; this skill owns the target contract and supported compatibility window. Select a protocol child directly for protocol only work; inherited parent guidance is not a separate request to redesign the API.

## Completion evidence

Report the contract difference from the prior supported caller surface, preserved normative inputs, owned contract artifact, implementation entry point, and maintained tests. Map caller promises to actual success, negative, compatibility, recovery, and regression rejection results. State unexercised compatibility risks and deployment or signer lifecycle limits.

The evaluator owns routing observations, paired experiments, and independent review records. Deliver caller artifacts and observed test evidence; do not invent those evaluator records or count a local deterministic check as skill qualification.

Use [the maintained source map](references/sources.md) for facts that depend on a version and for source conflicts.
