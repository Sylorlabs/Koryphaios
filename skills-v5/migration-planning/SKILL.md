---
name: migration-planning
description: Plan compatible transitions between schemas, APIs, runtimes, data stores, or architectures. Use when old and new states must coexist or data movement, cutover, and rollback affect safety; use release-planning for ordinary compatible rollouts and provider skills for platform-specific mechanics.
---

# Migration Planning

A migration changes which state or contract is authoritative. Establish whether old and new versions must coexist or whether an authorized offline/atomic cutover is viable. Explain who produces and consumes each contract, how any mixed versions behave, how progress is measured, and how the system returns to a safe state if a phase fails.

## Migration workflow

1. **Inventory the transition surface.** Identify producers, consumers, persistent state, schemas/protocols, runtime versions, background jobs, external clients, operational ownership, and every irreversible dependency. Record the current and target versions rather than assuming a generic “old” and “new.”
2. **State invariants and compatibility first.** Define what must remain true during coexistence: read/write compatibility, ordering/idempotency, uniqueness, availability, latency, data-loss limits, client support, and security/authorization semantics. Classify changes as backward-compatible, forward-compatible, or breaking for each active producer/consumer pair.
3. **Choose the transition shape from compatibility needs.** When versions must coexist, prefer expand/contract: add compatible structures, deploy tolerant readers/writers, backfill, move authority, then retire unused paths. An offline or atomic replacement can be valid when downtime, data size, consumers, and recovery permit it; document those preconditions. A major-version label does not itself provide a migration strategy.
4. **Make data movement resumable.** Define source-of-truth ownership, checkpoints, idempotency/deduplication, retry behavior, rate limits, reconciliation, and validation. Distinguish copying data from proving completeness and correctness. For dual-write periods, define divergence detection and which side wins conflicts.
5. **Design cutover as a gate, not a date.** Specify measurable preconditions, traffic/client cohorts, observation windows, capacity headroom, telemetry, and stop conditions. Progressive or canary cutovers should advance only on observed health and compatibility evidence.
6. **Separate rollback from roll-forward.** Before each phase, state whether it is reversible, what state must be preserved for rollback, and when rollback becomes unsafe because new writes or destructive transforms have crossed a point of no return. If rollback is no longer credible, define a tested roll-forward/recovery path instead of claiming one.
7. **Communicate deprecation and removal explicitly.** For public APIs or shared contracts, publish the compatibility/deprecation window, client migration path, and removal signal. A sunset date is a coordination aid; retirement still requires evidence that required consumers have moved.
8. **Verify cleanup last.** Remove compatibility shims, old columns/topics/endpoints, duplicated infrastructure, or old runtime support only after telemetry and reconciliation prove they are no longer needed. Cleanup is a separate migration phase with its own rollback/recovery implications.

## Evidence

Preserve a producer/consumer compatibility matrix, phase/state diagram, migration checkpoints, reconciliation results, cutover metrics, rollback or roll-forward evidence, and the final proof that obsolete paths are unused before deletion. Label simulations and unavailable production evidence explicitly.

## Boundaries

- `release-planning` owns staged delivery of an already-compatible release; this skill owns coexistence, state/contract transition, cutover, and migration cleanup.
- `api-contract-design` owns the target API/schema contract; this skill owns how existing consumers move safely between old and new contracts.
- Database/provider/language skills own engine-specific commands and semantics; this skill owns cross-version sequencing, compatibility, backfill, cutover, and recovery.
- `terraform-iac` owns Terraform state/import/moved/provider mechanics. A Terraform state move with unchanged system behavior is not a general system migration.
- `verification` and `reliability-verification` can independently judge the completed migration or drill. This skill owns transition design; execute the plan or mutate state only when the task authorizes implementation.

Use [the maintained source map](references/sources.md) for compatibility, deprecation, progressive rollout, and rollback guidance.
