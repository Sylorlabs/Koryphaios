---
name: release-planning
description: Plan production exposure, readiness gates, canaries, rollback, and release ownership. Use when rollout policy or a release decision is central; use cicd-engineering for pipeline mechanics and migration-planning for coexistence of old and new contracts or state.
---

# Release Planning

A release is a controlled exposure of a known change to real users or workloads. The plan must bind the release decision to one exact artifact/configuration set, define what evidence permits each increase in exposure, and make stopping or reverting safer than continuing blindly.

## Release workflow

1. **Identify the release unit.** Record exact application/configuration/model/feature-flag versions, artifact digests or immutable identifiers, dependencies, affected surfaces, owners, intended environments, user cohorts, support commitments, and any compatibility assumptions. Do not treat a branch name or “latest” as the release unit.
2. **Set readiness gates before exposure.** Require the relevant build/test/security/reliability checks, capacity/quota readiness, observability coverage, runbooks/support ownership, rollback/disable path, and known-issue review. Gate on evidence that exists, not checklist language alone.
3. **Choose progressive exposure deliberately.** Use canary or staged cohorts sized to limit blast radius while still producing representative signals. Separate canary and control populations when comparison matters, and define whether cohorts are by instances, traffic, tenants, regions, devices, or feature flags.
4. **Define measurement and observation windows.** Name the service/user metrics, error budget/SLO signals, business guardrails, sample sufficiency, warm-up effects and minimum observation time. A short green interval with insufficient traffic is not a successful stage.
5. **Write deterministic stop/go rules.** For each stage, specify thresholds that advance, hold, disable, or roll back. Include ambiguous telemetry, missing data, unrelated incidents, and operational blackout periods. Humans may override, but the override and rationale become release evidence.
6. **Make recovery executable.** Define the previous known-good release, rollback/feature-disable mechanism, dependency compatibility, expected rollback time, data/configuration constraints, and verification after recovery. If rollback is unsafe because of a state/contract transition, compose `migration-planning` and define roll-forward instead of claiming a simple revert.
7. **Coordinate operations and support.** Name release commander/owner, monitoring and support contacts, user/customer communication triggers, maintenance/change windows where applicable, and escalation path into `incident-response` if impact becomes an incident.
8. **Close the release with evidence.** Confirm full rollout state, user/service health, support signals, outstanding exceptions, artifact/config identity, and removal of temporary canary/flag controls only when safe. Record what was learned and preserve failed-stage evidence as regression input.

## Boundaries

- `cicd-engineering` owns workflow permissions, build/test jobs, artifact transport, protected environments and deployment concurrency; this skill owns production exposure policy and go/no-go decisions.
- `migration-planning` owns mixed-version compatibility, state/data backfill, cutover and irreversible transition sequencing; this skill owns rollout of a change that is already compatible with the current production state.
- `reliability-verification` owns an independent verdict on an already-defined release or recovery test; this skill owns designing the release gates and progression.
- `incident-response` owns active incident command/mitigation once the release causes operational impact; the release plan supplies stop/rollback and handoff context.
- `product-management` owns roadmap/customer prioritization; this skill owns safe operational delivery of the chosen release.

Use [the maintained source map](references/sources.md) for canary, release-engineering and compatibility guidance.
