# Deterministic contract testing: local evidence boundary

Run the package-local check from the repository root with the installed, locked
Bun toolchain:

```sh
bun test skills-v5/deterministic-contract-testing/evals/fixture-integrity.test.ts
```

This offline check validates the package schema and source map, exercises the
package's authored and held-out routing cases through the real resolver, checks
that both full-task records have registered synthetic materializers and
deterministic scorers, and runs evaluator-integrity negative controls. It does
not invoke a model, run a paired skill/no-skill task, start a broker/database or
other real dependency, run a qualification campaign, conduct a blind review, or
write a promotion ledger.

## What local checks establish

| Local check                                   | Evidence established                                                                                                                                            | Evidence not established                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Package validation and source-map/link checks | The package is structurally loadable, its maintained citations are present and fresh under their declared policy, and local references stay inside the package. | Citation quality alone does not qualify the skill.                                                      |
| Resolver routing cases                        | The current resolver makes the expected direct-selection decisions for the authored package corpus under the checked catalog.                                   | Authored cases are routing regression fixtures, not independent generalization measurements.            |
| Registered fixture readiness                  | The two `fixture://` scenarios have materializers, deterministic scorers, falsifiable checks, and explicit evidence requirements.                               | Registration and readiness do not show that an agent completed either task.                             |
| Scorer negative controls                      | Missing starter evidence and changed evaluator-owned inputs are rejected without treating prose as execution evidence.                                          | Negative controls are not model output, task success, mutation qualification, or blind semantic review. |

## Deterministic fixture versus real qualification

The lease and schema/state-machine fixtures are controlled synthetic workspaces.
Their fixed clocks, deterministic nonce bytes, pinned examples, local reducer,
mutation checks, and repeated focused commands can establish only the declared
local contract. They do not establish behavior of a real network, database,
broker, filesystem, process, provider, deployment, or production runtime.

The task evidence contract therefore requires an exact command/runtime identity,
an observed versus unexecuted label, and an explicit `synthetic/local` boundary.
The paired same-model skill/no-skill artifacts and independent blind semantic
review remain unavailable until a separate official evaluation runs them. Do not
turn a passing local check or scorer result into a qualification or promotion
claim.

The registered materializers and scorers live in the evaluator implementation;
this package-local test imports them read-only and does not modify that shared
implementation.
