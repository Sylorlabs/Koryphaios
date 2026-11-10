# Package checks and evaluation limits

From the repository root, using the installed project runtime and dependencies:

```sh
bun test skills-v5/go-engineering/evals/package-local.test.ts
git diff --check -- skills-v5/go-engineering
```

The test is offline and read only. It validates the package schema, source-map
provenance and freshness policy, local links, task identities and contract
checks, maintained prose, and the runtime's package-only trigger function with
this package supplied in memory. It does not seed or activate skills, write
ledgers, run Go fixtures, or produce paired model evidence. Full catalog
resolution remains a separate boundary that includes the mandatory routing and
verification skills.

The two scenario IDs, fixture addresses, and required artifact names remain
external-harness identities. The task prompts require package-local evidence
for Go interface, error, context, concurrency, module, and testing boundaries;
they do not claim that a unit fixture proves network, process, broker, disk,
or non-cooperative-dependency behavior.
