---
name: java-jvm-engineering
description: Engineer Java and JVM systems with explicit concurrency, memory, compatibility, build, and framework lifecycle boundaries. Use when the request specifically requires java, jvm, maven, gradle java; prefer a narrower child only when its boundary is established.
---

# Java Jvm Engineering

## Boundary

Confirm language and JVM targets, build tool, dependency graph, nullability conventions, framework lifecycle, and concurrency model. Treat object identity, mutability, `equals` and `hashCode`, classloading, reflection, executors, and resource cleanup as contracts. Preserve binary or serialization compatibility only where real consumers depend on it.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Java language, JVM runtime, Maven or Gradle Java build contracts, classloading, or JVM concurrency is material. Framework behavior remains conditional on the framework and version actually present. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve the supported JDK range before using language, runtime, garbage collector, module, virtual-thread, or library behavior that varies by release.
- Make executor ownership explicit. The component that creates an executor normally owns orderly shutdown and must decide what interrupted or unfinished work means for the application.
- Preserve interruption as a control signal when APIs use it. `shutdownNow` is best-effort and cannot prove that user tasks stopped if they ignore interruption.
- Change `equals` and `hashCode` together when identity semantics change, and review collection behavior for mutable keys.
- Apply Java serialization compatibility rules only if the system actually uses Java object serialization. Do not impose them on unrelated JSON, database, or RPC models.

## Failure discriminators

- If shutdown hangs, distinguish executor lifecycle, tasks that ignore interruption, blocked I/O, and non-daemon threads before increasing shutdown timeouts.
- If behavior changes only after dependency or runtime upgrade, inspect classpath or module resolution, service loading, reflection, and bytecode target compatibility.
- If cache or set membership becomes inconsistent, inspect mutable identity fields and `equals` or `hashCode` before blaming concurrency.
- If old serialized state fails, identify the actual wire or persistence format and its compatibility rules before editing model fields.

## Verification at the JVM boundary

- Run the repository's authoritative Maven or Gradle checks on every affected supported JDK target when behavior can vary by runtime.
- Exercise executor shutdown and interrupted work for lifecycle changes, and verify owned resources close.
- Test null and public model boundaries explicitly when annotations or interop contracts change.
- Run a compatibility fixture using real prior data or consumers when binary or serialization compatibility is part of the requirement.
- Verify framework lifecycle changes through the actual container or host rather than isolated construction when scope and ownership matter.

## Completion evidence

- JDK, build, framework lifecycle, and compatibility assumptions affected
- Runtime evidence for shutdown, interruption, classloading, or identity risks that changed
- Real prior-consumer or prior-data evidence when compatibility is claimed

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
