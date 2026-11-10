# Package checks and evidence boundary

Run from the repository root with the locked project runtime:

```sh
bun test --timeout 30000 skills-v5/in-process-backend/evals/package-local.test.ts
git diff --check -- skills-v5/in-process-backend
bunx prettier --check skills-v5/in-process-backend
```

The package local test is an offline, read only authoring check. It validates the V5 schema, source map provenance and freshness, package local links, routing cases through the trigger function, hierarchy metadata, registered materializers and deterministic scorers, and scorer rejection of the supplied defective fixtures. It uses temporary directories for fixture materialization and removes them after each test.

The checks do not run a model, perform paired skill or no skill evaluation, invoke a blind reviewer, or write qualification ledgers. They do not establish promotion or qualification.

## Fixture boundary

The queue and cache exercises are synthetic repository fixtures. Their registered checks can establish the modeled state transitions when the generated Bun tests execute. They do not prove that a candidate used SQLite, that multiple OS threads or goroutines raced, that a real process restarted, that a production resource limit held, or that a dependency ignoring cancellation was bounded outside the fixture. A fixture, map, fake clock, phase driver, or simulated restart must be reported as `simulated`; unavailable host evidence stays `unavailable`.

For runtime promotion evidence, retain the exact source revision, runtime and dependency versions, fixture or store identity, caller entrypoint, ownership and state model, named schedules actually executed, failure injection point, cleanup result, durable effect identities, and fresh post recovery operation. Keep source claims tied to the maintained source map and label inferred or stale claims explicitly.
