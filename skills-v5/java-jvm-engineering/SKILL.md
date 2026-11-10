---
name: java-jvm-engineering
description: Engineer Java and JVM systems with explicit concurrency, memory, compatibility, build, and framework lifecycle boundaries. Use when the request specifically requires java, jvm, maven, gradle java; prefer a narrower child only when its boundary is established.
---

# Java Jvm Engineering

## Boundary

Confirm the Java release and vendor matrix, preview or incubator flags, source and bytecode target, build tool and wrapper version, dependency graph, module or classpath layout, nullability conventions, serializer and persistence formats, framework lifecycle, and concurrency model. Treat object identity, mutability, `equals` and `hashCode`, classloading, reflection, service loading, executors, and resource cleanup as contracts. Distinguish source, binary, behavioral, and wire compatibility; preserve each only where real consumers depend on it.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared. Compose `concurrency-debugging`, `performance-testing`, `grpc-protobuf`, or `migration-planning` when one of those owns the primary boundary; retain this skill for the Java/JVM implementation and runtime evidence.
- Required skills: verification.

Use this skill when Java language, JVM runtime, Maven or Gradle Java build contracts, classloading, or JVM concurrency is material. Framework behavior remains conditional on the framework and version actually present. Quoted, historical, negated, fixture only, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve the supported JDK range before using language, runtime, garbage collector, module, virtual thread, or library behavior that varies by release. Pin the build's `--release` or toolchain setting and check the emitted class file version, runtime module graph, preview flags, reflection, service provider, and multi release JAR paths against the oldest supported consumer.
- Name the compatibility contract before editing a public type. Compile a prior source consumer, link a prior binary consumer, and round trip representative prior data separately when those contracts matter. Do not infer binary or wire compatibility from a successful current version build.
- Make executor ownership explicit. The component that creates an executor normally owns orderly shutdown and must decide what interrupted, rejected, queued, or unfinished work means for the application. Bound queues and define rejection or backpressure behavior instead of allowing an unbounded executor to hide saturation.
- Define the executor's termination contract beyond calling `shutdownNow()`: await termination with a bounded policy, preserve interrupt status, and distinguish a task that removes its own tenant from external shutdown. Do not claim zero live threads when a task that ignores interruption remains; report the residual thread and its owner as unresolved evidence.
- Preserve interruption as a control signal when APIs use it. `shutdownNow` makes a best effort and cannot prove that user tasks stopped if they ignore interruption. Do not replace interruption with a flag that the blocking operation never observes, swallow `InterruptedException`, or use sleeps as synchronization.
- State the happens before or ownership invariant for shared state. Choose locks, `volatile`, atomics, concurrent collections, or task completion based on the required visibility, atomicity, and ordering; a thread safe collection does not make a multiple step check then act sequence atomic. Make cancellation, timeout, retry, and executor rejection observable at the boundary.
- For lifecycle callbacks, make close and removal idempotent and safe when callbacks fail, race with removal, or remove their own registration. Avoid holding a lock while invoking user code, and verify that callback ordering and reentrancy are part of the documented contract rather than accidental iteration order.
- Change `equals` and `hashCode` together when identity semantics change, and review collection behavior for mutable keys. Treat class identity as `(class loader, binary name)` when diagnosing casts, service loading, linkage errors, or duplicate plugin loads.
- Apply Java serialization compatibility rules only if the system actually uses Java object serialization. Do not impose them on unrelated JSON, database, protobuf, or RPC models. For every format, define omitted, explicit null, unknown field, unknown enum, malformed record, and restart recovery behavior at the actual boundary.
- Choose virtual threads only after confirming the target JDK and the blocking profile. They can improve throughput for many blocking tasks but do not remove CPU limits, external resource limits, queue policy, pinning, or cancellation obligations; compare them with the existing executor under the same workload.
- Treat performance as a measured workload claim. Keep the input distribution, output equivalence, warmup, JIT state, concurrency, heap and GC settings, measurement window, and sample count fixed; attribute latency and allocation changes with JFR or a profiler before changing flags, pools, collectors, or object layout. A faster microbenchmark or a zero sample percentile is not service evidence.

## Failure discriminators

- If shutdown hangs, distinguish executor lifecycle, tasks that ignore interruption, blocked I/O, and non daemon threads before increasing shutdown timeouts.
- If behavior changes only after dependency or runtime upgrade, inspect classpath or module resolution, service loading, reflection, and bytecode target compatibility.
- If a race appears intermittent, identify the missing visibility or ordering edge and replace timing luck with a barrier, latch, executor completion, or repeated schedule that observes the invariant.
- If throughput or latency changes, separate warmup, allocation rate, GC pauses, lock contention, queueing, external I/O, and benchmark harness effects before attributing the result to a JDK or collection change.
- If cache or set membership becomes inconsistent, inspect mutable identity fields and `equals` or `hashCode` before blaming concurrency.
- If old serialized state fails, identify the actual wire or persistence format and its compatibility rules before editing model fields.
- If a cast, `NoSuchMethodError`, or missing provider occurs only in packaging or production, inspect duplicate versions, classloader identity, service resources, module exports/opens, and the actual packaged artifact.

## Verification at the JVM boundary

- Run the repository's authoritative Maven or Gradle checks on every affected supported JDK target when behavior can vary by runtime.
- Exercise executor shutdown and interrupted work for lifecycle changes, and verify owned resources close exactly once. Include high churn add/remove, task failure, rejection, timeout, concurrent removal, process termination, self removal, and a control with a task that ignores interruption when the executor can invoke lifecycle callbacks. Observe named threads before and after shutdown; if the required JDK, Maven, or Gradle tool is unavailable, retain that as an explicit verification blocker.
- Use deterministic coordination rather than sleeps. Cover the success, cancellation, interruption, timeout, failure, retry, restart, and recovery paths that the public contract exposes, and assert both the externally visible result and the absence or ownership of residual work.
- Test null and public model boundaries explicitly when annotations or interop contracts change. Verify source compatibility, binary linkage, and wire compatibility as separate tests with old consumers or golden data where applicable.
- Run a compatibility fixture using real prior data or consumers when binary or serialization compatibility is part of the requirement. For packaged libraries, inspect the jar/module contents and run a consuming process that exercises service loading and reflective entry points.
- For performance work, record the command, JDK/vendor, flags, workload, warmup, sample count, p50/p95/p99, throughput, allocation/GC, thread/queue state, and uncertainty. Keep synthetic probes and unavailable profilers separate from production like evidence.
- Verify framework lifecycle changes through the actual container or host rather than isolated construction when scope and ownership matter.

## Completion evidence

- JDK, build, framework lifecycle, and compatibility assumptions affected
- Runtime evidence for shutdown, interruption, memory visibility, classloading, or identity risks that changed
- Measured workload, profiler or JFR, and resource evidence for any performance claim
- Executed test matrix with commands, runtime versions, observed assertions, and unavailable or unresolved checks labeled explicitly
- Real prior-consumer or prior-data evidence when compatibility is claimed

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
