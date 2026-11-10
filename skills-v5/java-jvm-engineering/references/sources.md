# Source map

Source curation for `java-jvm-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Java SE 25 ExecutorService**: https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ExecutorService.html
  - Adopted: executor ownership includes orderly shutdown, and `shutdownNow` is a best-effort interruption request rather than proof that arbitrary tasks have stopped.
  - Conditional: Java SE 25 API details apply directly only to compatible target JDKs. For older supported JDKs, consult that release's API.
  - Limit: executor APIs cannot make code that ignores interruption terminate safely.
  - Verified: 2026-09-06; refresh after 90 days.

- **Java Language Specification, Chapter 17 Threads and Locks**: https://docs.oracle.com/javase/specs/jls/se25/html/jls-17.html
  - Adopted: use happens-before, synchronization, volatile, and inter-thread ordering rules to state the visibility invariant instead of relying on timing or collection thread-safety.
  - Conditional: Java SE 25 language rules apply directly only to a compatible target release; check the target specification when it differs.
  - Limit: the specification establishes language-level ordering, not application-level absence of races, correct lock choice, or safe cancellation.
  - Verified: 2026-10-17; refresh after 90 days.

- **Java Flight Recorder API**: https://docs.oracle.com/en/java/javase/25/docs/api/jdk.jfr/jdk/jfr/package-summary.html
  - Adopted: use an executed recording to attribute allocation, garbage collection, lock, thread, and latency observations for a measured workload.
  - Conditional: a recording describes the workload and flags that were actually run; it does not establish a universal improvement or replace a representative benchmark.
  - Limit: profiler and JFR evidence cannot explain an unmeasured production workload or prove a different deployment has the same behavior.
  - Verified: 2026-10-17; refresh after 90 days.

- **Java SE 25 ClassLoader API**: https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/lang/ClassLoader.html
  - Adopted: diagnose class identity and loader-boundary failures using the loader and binary name, then verify service loading and the packaged artifact in a consuming process.
  - Conditional: the API describes loader behavior; module exports, opens, service configuration, and packaging remain application and deployment contracts.
  - Limit: a classloader API citation alone cannot prove that a production dependency graph or provider resource is correct.
  - Verified: 2026-10-17; refresh after 90 days.
- **Java Object Serialization versioning**: https://docs.oracle.com/en/java/javase/25/docs/specs/serialization/version.html
  - Adopted: treat class evolution as a compatibility problem when the application actually persists or exchanges Java object-serialization streams.
  - Conditional: apply only to Java object serialization, not JSON, protobuf, database schemas, or unrelated wire formats.
  - Limit: a structurally compatible change still needs representative prior-data or consumer evidence for the application contract.
  - Verified: 2026-09-06; refresh after 90 days.
- **Java SE documentation index**: https://docs.oracle.com/en/java/javase/
  - Preserved use: locate the exact API and specification for the supported JDK release.
  - Limit: the index alone is not evidence for a version specific runtime rule, compatibility claim, or performance result.
  - Verified: 2026-09-04; refresh after 90 days.

Target JDK, build artifact, framework lifecycle, and workload evidence control concrete behavior. Golden records, old consumers, thread dumps, JFR recordings, and benchmark measurements are application evidence and must be retained or labeled unavailable; they are not replaced by documentation citations. Do not generalize Java SE 25 details onto older supported runtimes without checking their API contracts.
