# Agentic systems: local evidence boundary

Run from the repository root using the installed, locked Bun toolchain:

```sh
bun test skills-v5/agentic-systems/evals/fixture-integrity.test.ts
```

This offline check validates the package and source freshness, runs its 16 authored routing cases through the real resolver, and checks the two registered synthetic scorers with unchanged, incomplete and tampered candidates. It invokes no model, paired qualification run or blind reviewer and records no promotion result. A catalog validation failure can block routing even when this package validates; report that failure rather than treating the cases as passed.

## What the registered individual exercises cover

| Task                                     | Registered exercise                                                          | Evidence it can establish                                                                                                    | Runtime evidence still required by the task                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentic-systems-full-task-1-individual` | Pure execution-state evaluator, `concept@2` / `concept-scorer@2`             | Decisions over supplied observation, request, result and verification events; exact output comparisons on a synthetic corpus | Real tool discovery and approval enforcement, atomic revision preconditions, stable operation identity across uncertain delivery, durable resume, wall-clock and aggregate spend limits, independent health readback |
| `agentic-systems-full-task-2-individual` | Pure manager/specialist evidence evaluator, `concept@2` / `concept-scorer@2` | Acceptance and rejection of supplied specialist evidence, memory freshness and conclusion conflicts                          | Actual bounded child dispatch, shared parent-budget enforcement, durable checkpoint/resume, reuse of completed work and independent primary-source adjudication                                                      |

The current registrations live in `backend/src/kory/skill-eval-ai-protocol-concept-fixtures.ts`. Their materialized README is the executable interface authority. Older pilot registrations without the `-individual` suffix are different scenarios; their interfaces and results cannot be substituted for these tasks. Registration/readiness alone does not establish the broader runtime requirements above.

The local negative controls prove that the registered scorers reject inadequate or altered submissions. They do not implement a reference answer, establish model uplift, or certify the live agent controls. The package runbooks are illustrative specifications; their examples are not observed execution receipts. Preserve official failures and open regressions until fresh, contract-bound official evidence resolves them.

The package-local [trace evidence fixture](fixtures/trace-evidence.json) is an
inspectable contract for the required negative and recovery traces. It is
explicitly `unverified` with `observedResult: null`: it does not fabricate live
authority, recovery, tool integration, or an external completion-oracle result.
Each row names its expected event sequence, revision/evidence generation,
approval or scope decision, budget charge, terminal decision, and missing proof.
Action and revision examples in the fixture are independently parsed JSON
objects; reconciliation must be structural rather than reference identity.

The execution-state boundary also has three fail-closed regression cases that a
candidate implementation must exercise: a verify-only event cannot create or
advance the current observed revision; a fresh unhealthy verification replaces
prior healthy state; and a mutation or fresh observation invalidates health
evidence from the previous evidence generation. These cases are distinct from
timeout uncertainty: a matching fresh unhealthy verification can resolve
`unknown` while still leaving completion blocked. The runbook records the
expected transitions in [execution decisions](../references/execution-decisions.md).

## Evidence to retain when runtime execution is available

- Remediation: target/revision, tool arguments, approval binding, logical operation key separate from attempt number, state transitions including `unknown`, attempted-call budget use, readback and independent health observations.
- Delegation: parent and child contracts, authority subsets, aggregate allocated/spent budget, artifact/source revisions, accepted and rejected claims, memory provenance, resume dispatches and independent terminal verification.
- Every record: actual command/runtime, source revision, observed result and explicit simulated, unavailable, stale or unresolved labels. Keep proposed tests distinct from executed tests. If live authority, recovery, tool integration, or an external completion oracle was not executed, record that exact obligation as `unverified` with its missing proof.

Paired same-model runs and independent blind review remain requirements of the official evaluation process. Local authoring checks do not grant promotion.
