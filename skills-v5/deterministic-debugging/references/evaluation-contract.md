# Evaluation contract

This package records the executable binding used by the V5 evaluation harness as inspected on
2026-10-17. The package task `scorers[].id` values are semantic contract labels. The runtime
registry matches deterministic scorers by full-task scenario ID and persists the registered
materializer and scorer identities in each run artifact.

| Full-task scenario                    | Starting state                                               | Registered materializer                              | Registered deterministic scorer                             |
| ------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------- |
| `deterministic-debugging-full-task-1` | `fixture://deterministic-debugging/crlf-empty-value`         | `deterministic-debugging/crlf-empty-value@1`         | `deterministic-debugging/crlf-empty-value-scorer@1`         |
| `deterministic-debugging-full-task-2` | `fixture://deterministic-debugging/project-permission-cache` | `deterministic-debugging/project-permission-cache@1` | `deterministic-debugging/project-permission-cache-scorer@1` |

## Readiness boundary

- Registration means the materializer and deterministic scorer are discoverable for the scenario;
  it does not mean either arm has been executed or passed.
- The fixture self-check must remain red before model intervention, and a real paired run must
  retain the identical starting fingerprint for the skill and no-skill arms.
- A promotion claim needs pre-fix or starting-state evidence, causal evidence, post-fix evidence,
  negative/recovery evidence, and persisted paired artifacts. If a host cannot execute the
  fixture, record the blocker and mark the observation unavailable rather than inferring it.
- The blind-semantic scorer is a separate evidence class and must not be replaced by the
  deterministic scorer or by package-local prose.
