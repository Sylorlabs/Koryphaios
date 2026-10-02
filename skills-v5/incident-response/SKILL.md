---
name: incident-response
description: Coordinate active incidents through scoped impact, reversible mitigation, preserved evidence, communication, and verified recovery. Use when handling a production incident or outage; use observability-sre for measurement design and reliability-verification for controlled resilience qualification outside an incident.
---

# Incident Response

Treat an incident as two simultaneous problems: restore acceptable user/service behavior and keep the response itself coordinated. Establish a single source of truth, role ownership, current impact, and next decision before deep diagnosis expands the work.

## Active-response loop

1. **Declare and bound.** Record declaration time, severity, affected users/regions/functions, first known symptom, current service state, and the criteria that would raise or lower severity. Declare early when coordination overhead is already material.
2. **Establish command.** Name an incident commander (IC). For incidents large enough to justify it, separate operations/technical mitigation, communications, and scribe/timeline responsibilities. The IC coordinates and decides; subject-matter responders execute approved changes. Unassigned roles remain with the IC explicitly.
3. **Create a live incident record.** Maintain timestamps for observations, hypotheses, decisions, changes, owners, outcomes, and next checkpoints. Separate “we observed X” from “we think Y caused X.” Preserve logs/traces/configuration snapshots and other volatile evidence before rollback/restart when feasible.
4. **Stabilize with reversible actions.** Prefer rollback, traffic shift, feature disablement, capacity relief, dependency isolation, or load shedding that reduces user impact with a known undo path. Assign one owner per mutating action and avoid simultaneous uncontrolled changes that destroy causal evidence.
5. **Communicate facts and cadence.** State user impact, current mitigation/status, what is known/unknown, and the next update time or trigger. Do not publish speculative root cause as fact. Keep external/customer communications aligned with the command record.
6. **Verify recovery from multiple signals.** Confirm the mitigation through the primary user-impact symptom plus service health, backlog/state convergence, dependency health, and representative transactions as applicable. Watch long enough to cover the failure's recurrence window; a single green graph is not resolution.
7. **Close and hand off deliberately.** Record end time, residual risk, temporary mitigations, configuration divergence, monitoring/watch items, and named follow-up owners. Preserve a factual timeline for later learning. Root-cause analysis and permanent redesign may continue after the incident is no longer active.

## Escalation and safety

- Escalate for missing authority, cross-team ownership, customer/data risk, legal/compliance obligations, or unsafe operational actions rather than improvising permissions.
- For security/privacy incidents, compose the appropriate security/privacy response discipline and preserve forensic evidence/chain requirements; ordinary service restoration must not destroy security evidence.
- Prefer safe failure and customer-impact reduction over experimental diagnosis on a degraded production system. Reproduce destructive hypotheses in an isolated environment when possible.

## Boundaries

- `observability-sre` owns telemetry/SLO/alert design and repair. During an incident, use existing evidence first; redesign the telemetry path only when missing or incorrect telemetry is materially blocking response.
- `reliability-verification` owns planned fault/recovery/soak qualification and release verdicts, not command of a live outage.
- `verification` owns a broader completion verdict after evidence exists; incident-response owns the operational recovery decision and observation window.
- `mlops`, `database-performance`, networking, cloud, security, or other specialists may execute/diagnose their subsystem under the incident command structure.

Use [the maintained source map](references/sources.md) for command-role, coordination, timeline, communication, and security-incident lifecycle guidance.
