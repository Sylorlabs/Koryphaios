# Source map

Source curation for `nodejs-runtime`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Node.js streams API**: https://nodejs.org/api/stream.html
  - Adopted: respect writable backpressure, reason about buffering and `highWaterMark`, and use pipeline teardown and abort semantics deliberately.
  - Conditional: `AbortSignal` and cleanup options depend on the supported Node release. Check the target major before relying on newer APIs.
  - Limit: a correct stream pipeline does not establish low event-loop latency or bounded application memory without workload evidence.
- **Node.js process API**: https://nodejs.org/api/process.html
  - Adopted: treat process signals, exit behavior, environment, and active-resource ownership as runtime contracts for shutdown-sensitive code.
  - Conditional: signal availability and behavior vary by operating system and process topology.
  - Limit: process documentation does not identify which application handle or listener is leaking.
- **Node.js API documentation index**: https://nodejs.org/docs/latest/api/
  - Preserved use: current runtime API discovery.
  - Limit: `latest` is not a substitute for checking the repository's supported Node major.

Runtime diagnostics and representative load control event-loop, memory, and active-handle claims. API documentation controls supported semantics.
