# Source map

Source curation for `java-jvm-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Java SE 25 ExecutorService**: https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ExecutorService.html
  - Adopted: executor ownership includes orderly shutdown, and `shutdownNow` is a best-effort interruption request rather than proof that arbitrary tasks have stopped.
  - Conditional: Java SE 25 API details apply directly only to compatible target JDKs. For older supported JDKs, consult that release's API.
  - Limit: executor APIs cannot make code that ignores interruption terminate safely.
- **Java Object Serialization versioning**: https://docs.oracle.com/en/java/javase/25/docs/specs/serialization/version.html
  - Adopted: treat class evolution as a compatibility problem when the application actually persists or exchanges Java object-serialization streams.
  - Conditional: apply only to Java object serialization, not JSON, protobuf, database schemas, or unrelated wire formats.
  - Limit: a structurally compatible change still needs representative prior-data or consumer evidence for the application contract.
- **Java SE documentation index**: https://docs.oracle.com/en/java/javase/
  - Preserved use: locate the exact API and specification for the supported JDK release.
  - Limit: the index alone is not evidence for a version-specific runtime rule.

Target JDK and framework lifecycle evidence control concrete behavior. Do not generalize Java SE 25 details onto older supported runtimes without checking their API contracts.
