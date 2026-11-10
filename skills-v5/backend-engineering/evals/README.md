# Package checks and evaluation limits

From the repository root, using the installed project runtime and dependencies:

```sh
bun test skills-v5/backend-engineering/evals/package-local.test.ts
git diff --check -- skills-v5/backend-engineering
```

The test command is offline and read only. It validates this package with the maintained schema, checks source map provenance, local links, scenario and artifact compatibility, the maintained prose signal, and the runtime's actual trigger function with this package supplied in memory. It does not seed or activate skills or write evaluation ledgers. Package only routing verifies this root's direct trigger boundary; it does not measure selection against the full catalog, inherited specialist guidance, or model behavior. Full resolution requires the host's mandatory core skills, starting with `task-routing` and adding testing, verification, or debugging according to the task. Those packages are not supplied in this isolated check, so full resolution is a separate boundary.

The original 16 routing rows remain regression cases. Added rows are authored regressions for ordinary requests, compound responsibilities, adjacent verification or diagnosis, and explicit scope exclusions. Despite the legacy `held-out` tags and file name, reviewed cases cannot serve as newly independent blind evidence.

## Runtime boundaries

The two scenario IDs, `fixture://` addresses, and required artifact names remain unchanged for the existing external harness. The worker owns result and verification artifacts. The paired evaluation artifact and routing/hierarchy judgment belong to the evaluator.

The package contract requires same-key/different-payload ownership: the first accepted payload remains authoritative and the preserved public 202 response is used when the fixture has no conflict result. The current job materializer has maps, an array queue, synchronous calls, and an injected interruption after upload. Its maintained fixture regressions and deterministic checks cover duplicate submissions with first-payload ownership, one queued delivery after a duplicate submission, repeated cancellation with cancellation queue draining, stable output after interruption, duplicate delivery after completion, and pending cancellation. The checks do not establish parallel claim isolation, an actual broker acknowledgment, disk durability, or lease fencing. Sequential worker calls and a stable object key are modeled recovery evidence only.

The current sync scorer interrupts and reapplies against the same mutable state object. It checks logical update counts, side effect IDs, stale versions, cancellation, and cursor progress in that model. It does not reopen a store, run concurrent sync owners, or exercise provider expiry and reset. Those boundaries are unavailable unless a package-local or supplied adapter provides and executes them.

The expanded assertions in `tasks/` identify those missing boundaries and the evidence needed when an adapter supports them. They do not modify the executable harness or grant qualification credit. A package check passing establishes packaging and bounded routing only. Real storage/process recovery, verifier calibration, paired task runs, and independent review require separately authorized evaluation work.
