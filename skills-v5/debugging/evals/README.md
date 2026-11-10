# Debugging package-local checks

Run from the repository root with the locked Bun installation:

```sh
bun test skills-v5/debugging/evals/package-contract.test.ts
```

This offline check validates the package and source-map links, routes the public and held-out cases through the real resolver, verifies the parent/child boundary cases, confirms the two current full-task materializer/scorer registrations, and checks both registered scorers against unchanged starters and focused corrected candidates.

The starter-red and corrected-green cases are evaluator-integrity controls. They do not run a model, create a same-model pair, perform blind semantic judging, or certify promotion. The package's task contracts and reports must still distinguish observed reproduction from unavailable host/runtime evidence, and the broader qualification process remains outside this package.
