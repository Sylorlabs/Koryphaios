# Package-local checks and evaluation boundary

Run the focused, offline package check from the repository root:

```sh
bun test skills-v5/language-runtime-security/evals/local-checks.test.ts
git diff --check -- skills-v5/language-runtime-security
```

The test validates the V5 package schema, maintained source-map freshness fields, local links, the package's direct trigger boundary, and stable full-task contracts. It does not seed the global catalog, run a model, write evaluation ledgers, run a campaign, or establish promotion evidence.

## Security contract covered by this package

The skill requires a reviewer to state the actual runtime/compiler/engine/embedder and target identity, the trust model, the isolation boundary, every host capability, resource-limit enforcement points, observable denials and effects, and recovery after traps, cancellation, exhaustion, or worker failure. Desired configuration is kept separate from observed behavior.

The structured artifact must preserve the task's supplied field names and terminology. When no schema is supplied, use the stable fields `environment`, `guarantees`, `ownershipBoundary`, `crossLayerTrace`, `isolationBoundary`, `capabilities`, `resourceLimits`, `observations`, `effectsAndAudit`, `recovery`, `reproducers`, and `unsupportedOrUnverified`. Each field must distinguish intended contract from observed evidence.

WASI, WebAssembly engines, JITs, interpreters, subprocesses, containers, VMs, OS sandboxes, native extensions, and target architectures are separate boundaries. If one was not supplied and exercised, its security behavior remains **unverified**. A source-level proof, specification citation, synthetic fixture, or another runtime's behavior cannot promote that claim.

The synthetic task fixtures retain their external IDs, `fixture://` addresses, and artifact names. Their task contracts are acceptance requirements, not live runtime receipts. Real OS isolation, host capability denial, resource enforcement, durable effect rollback, audit integrity, restart cleanup, and recovery require the named runtime and host environment to be exercised separately.
