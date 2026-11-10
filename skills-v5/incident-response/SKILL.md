---
name: incident-response
description: Coordinate active incidents through scoped impact, reversible mitigation, preserved evidence, communication, and verified recovery. Use when handling a production incident or outage; use observability-sre for measurement design and reliability-verification for controlled resilience qualification outside an incident.
---

# Incident Response

Treat an incident as two simultaneous problems: restore acceptable user/service behavior and keep the response itself coordinated. Establish a single source of truth, role ownership, current impact, and next decision before deep diagnosis expands the work.

## Active response loop

When the task supplies a concrete contract, required fields, or artifact schema, satisfy that contract exactly while applying incident discipline; do not replace requested outputs with a different narrative shape.

1. **Declare and bound.** Record declaration time, severity, affected users/regions/functions, first known symptom, current service state, and the criteria that would raise or lower severity. Declare early when coordination overhead is already material.
2. **Establish command and stop competing changes.** Name one incident commander (IC), an operations executor, a communications owner, and a scribe or timeline owner before authorizing more production mutations. The IC explicitly holds any combined or unfilled role. Announce and timestamp a freeze on independent flag edits, deploys, restarts, and failovers; capture actions already in progress. The IC makes the next change decision and assigns one operator. Subject specialists investigate within that control.
3. **Create a live incident record and preserve the prior state.** Timestamp observations, hypotheses, decisions, changes, owners, outcomes, and next checkpoints. Distinguish “we observed X” from “we think Y caused X.” Capture the rollout and version, current flags and routing, audit history from the control plane, impact telemetry, and relevant logs and traces _before_ rollback or restart. For a queue outage, also capture offsets, acknowledgements, messages in flight, retry and dead letter state, deduplication keys and windows, and observable downstream writes. When a snapshot is unsafe or unavailable, record that limitation and its consequence before acting.
4. **Stabilize with one reversible action at a time.** Prefer rollback, traffic shift, feature disablement, capacity relief, dependency isolation, or load shedding that reduces user impact. Before executing through an authorized control, record the IC decision, sole operator, start time, intended effect and numeric success threshold, risks, and undo path. Execute the chosen mitigation, record its completion time and returned configuration, then measure the observed result before considering another mutation. Do not substitute a proposed action for an executed one.
5. **Communicate facts and cadence.** State measured user impact, mitigation status, known facts, unknowns, and the next update time or trigger. Do not publish a speculative root cause as fact or claim rollback or failover finished before its recorded completion. Keep customer communications aligned with the command record.
6. **Verify recovery from independent signals over the recurrence window.** Compare impact after mitigation with baseline and acceptance thresholds using user errors, latency, service and dependency health, representative transactions, and backlog or state convergence as applicable. Observe at and after the expected recurrence or replay point; a single green graph does not prove resolution. Keep monitoring until the defined window passes without recurrence.
7. **Close and hand off deliberately.** Record end time, residual risk, temporary mitigations, configuration divergence, monitoring items, and named owners of subsequent work. Preserve the timeline for later learning. Analysis of root cause and permanent redesign may continue after the active incident.

## Evidence and timeline discipline

- **Keep time and units unambiguous.** Timestamp each observation, decision, action, communication, and recovery checkpoint on one stated clock with timezone or an explicit relative origin. Label rates as fractions or percentages (a fraction of `0.004` is `0.4%`) and distinguish backlog count, arrival and drain rate, and age. Check status updates against the action log; a mitigation must not be called complete before the recorded completion time.
- **Enforce chronology.** Declaration and roles precede the mutation freeze; the freeze and evidence capture precede the authorized change. Record the change completion before any update stating that it finished. Recovery checkpoints follow the change they measure, and closure follows the last required observation. If timestamps coincide, record event order explicitly. Never backdate actions or invent measurements.
- **Make decisions auditable.** Record observation, hypothesis, decision, and action as separate entry types. Each mitigation entry names its sole operator, start time, _intended effect and measurable success threshold_, expected risks, undo path, actual result, and the time that result was observed. A favorable metric after rollback is not a substitute for documenting what the rollback was intended to achieve.
- **Prove recovery with explicit acceptance criteria.** Define the baseline before the incident, current reading, acceptable threshold, and units for each impact metric. Verify transactions and dependencies independently. For queues, compare acknowledgements, offsets, and deduplication state after failover against their captured prior state; measure useful work rate, error rate, backlog _age and rate of drain_, retries, and consistency across regions. Count duplicate downstream side effects using durable business keys and writes across the replay window; consumer or deduplication counters alone are insufficient. Record any reconciliation and its owner. Define the recurrence hazard before choosing the watch window. Include the supplied recurrence point and a full relevant retry or redelivery cycle _after_ mitigation or replay, with later checkpoints proving stable useful work and no growing duplicate effects. If the cycle or timing is unknown, continue monitoring with an owned checkpoint rather than declaring resolution; restart the watch if symptoms recur.
- **Separate resolution from risk handoff.** At closure, name residual risk and unresolved hypotheses even if the primary symptom recovered. Record temporary divergence of flags, routing, or deployment from desired state, distinct watch signals and alert or rollback triggers, an owner for each reconciliation or subsequent task, and a deadline or next checkpoint. An item without an owner or observation plan is not an operational handoff.

Use one unit convention throughout the record: state whether rates are fractions or percentages, and keep prose, structured fields, thresholds, and updates consistent. Make the timeline entries explicit `observation`, `hypothesis`, `decision`, `action`, and `result` records; inferred intent in an `unknowns` field does not replace a timestamped hypothesis or decision. Every mitigation action states its intended effect before execution, and closure states residual risk plus the distinct watch signal and trigger that remain after recovery.

## Escalation and safety

- Escalate for missing authority, ownership across teams, customer or data risk, legal or compliance obligations, or unsafe actions rather than improvising permissions.
- For security or privacy incidents, apply the appropriate response discipline and preserve evidence and its custody requirements. Ordinary service restoration must not destroy forensic evidence.
- Prefer safer service behavior and reduced customer impact over experiments on a degraded production system. Reproduce destructive hypotheses in isolation when possible.

## Boundaries

- `observability-sre` owns telemetry, SLO, and alert design and repair. During an incident, use existing evidence first; redesign telemetry only when missing or incorrect signals prevent effective response.
- `reliability-verification` owns planned fault, recovery, and soak qualification and release verdicts, not command of a live outage.
- `verification` owns the broader completion verdict after evidence exists; incident-response owns the operational recovery decision and watch window.
- `mlops`, `database-performance`, networking, cloud, security, or other specialists may execute/diagnose their subsystem under the incident command structure.

Use [the maintained source map](references/sources.md) for incident command roles, coordination, timelines, communication, and security incident guidance.
