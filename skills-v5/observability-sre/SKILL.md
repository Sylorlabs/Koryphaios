---
name: observability-sre
description: Design service objectives, telemetry, alerting, and operational feedback with bounded cost and cardinality. Use when building observability or SRE measurement; use incident-response for active incidents and reliability-verification for resilience verdicts under disturbance.
---

# Observability and SRE

Start with the operational decision that telemetry must support. Define the user-visible service objective or failure mode, then choose the smallest set of black-box and white-box signals that answers: **what is broken, for whom, how badly, and what evidence helps localize why?** More telemetry is not automatically more observability.

## Design loop

1. **Define service boundaries and objectives.** Name the service/user journey, SLI event population, good-event rule, unit, aggregation window, target, exclusions, and ownership. Keep availability, latency, freshness, durability, and correctness objectives explicit rather than combining unlike failures into one opaque score.
2. **Instrument stable semantics.** Prefer standard semantic conventions for service/resource identity, operations, errors, and network/protocol attributes when they fit. Preserve units and denominator definitions. Do not put unbounded request IDs, user IDs, raw URLs, prompts, or arbitrary error text into metric labels.
3. **Correlate signals deliberately.** Metrics should show scope and trend; traces show request paths and causal neighborhoods; logs/events preserve discrete detail; profiles explain resource consumption. Carry trace/correlation identifiers in logs where safe, but keep high-cardinality correlation out of metric dimensions.
4. **Design sampling around questions.** Record head/tail sampling policy and expected blind spots. If errors or long-latency traces must be retained, verify the sampling design can actually select them and that the sampler itself has enough capacity. Never report sampled counts as full-population counts without the appropriate estimator/qualification.
5. **Alert on actionable symptoms.** Prefer user-impacting latency/error/availability or impending hard-capacity symptoms over every internal cause. Every page needs an owner, severity, threshold/window, runbook or diagnostic entry point, and an action a responder can take. Allow transient slack where the reliability objective permits it.
6. **Verify the observability path.** Inject or replay a representative failure and prove the raw event becomes the expected metric/log/trace, dashboard/SLO math is correct, the alert fires only after the intended condition, clears after recovery, and the telemetry pipeline itself is monitored. A silent collector/exporter failure must not look like a healthy service.
7. **Preserve supplied measurement contracts.** When a repository task provides a telemetry simulator, replay corpus, package lifecycle commands, or an artifact schema, treat those inputs as user owned unless the task explicitly authorizes changing them. Put SLI, sampling, alert, and provenance decisions into the requested artifacts and verify them against the supplied measurement path. Do not rewrite the simulator or corpus to make the proposed policy pass.

## Operational guardrails

- Treat privacy/security as part of telemetry schema design. Redact or avoid secrets, credentials, sensitive payloads, and direct personal identifiers before export.
- Bound metric cardinality, event/log volume, trace sampling, and retention cost. Cardinality and sampling are correctness concerns because they can silently remove the evidence needed during an incident.
- Keep symptom and cause panels distinct. A database saturation metric may explain a user-latency page, but it should not replace the user-impact signal as the paging contract unless the service has a specific capacity-risk objective.
- Version dashboards, rules, semantic conventions, and collector configuration with the service so changes can be correlated with telemetry drift.

## Boundaries

- `incident-response` owns command, containment, communications, timeline, handoffs, and restoration during an active production incident. This skill supplies and repairs the observability needed by responders.
- `reliability-verification` owns the explicit resilience/recovery verdict under controlled disturbance or soak. Observability supplies its measurement system.
- `verification` owns the broader completion verdict; observability claims still need direct end-to-end evidence through the telemetry path.
- `operational-data-analysis` analyzes operational datasets for a question; this skill designs and verifies the production measurement system itself.

Use [the maintained source map](references/sources.md) for SRE monitoring/alerting principles and the current OpenTelemetry semantic/sampling contracts.
