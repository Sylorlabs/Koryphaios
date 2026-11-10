# Package-local checks and evidence limits

Run from the repository root:

```sh
bun test ./skills-v5/database-performance/evals/package-contract.test.ts
git diff --check -- skills-v5/database-performance
```

The test is read-only. It validates the package schema, source-map freshness and evidence labels, local Markdown links, package-local routing through the actual trigger function, and the two full-task contracts. The full-task assertions verify that the fixtures require engine/version, scale, parameter or migration boundaries, recovery evidence, and explicit synthetic or unavailable labels.

These checks are authoring and evaluator-contract checks, not qualification evidence. The full-task environments are declared `synthetic`; they do not run a real production database and cannot prove production p95/p99, lock safety, write impact, or migration recovery. A real target run, paired same-model skill/no-skill evaluation, and independent blind review remain separate evidence. No shared ledger, campaign, or other skill package is read or written.
