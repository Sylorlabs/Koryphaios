# Source map

`observability-sre` designs and verifies the production measurement and alerting system around user-visible reliability objectives. More telemetry is not itself evidence of better observability. Formal V5 promotion still requires paired same-model skill/no skill results plus independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader reliability-verification.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Monitoring Distributed Systems**: https://sre.google/sre-book/monitoring-distributed-systems/
  - Scope: SRE book guidance available 2026-09-05.
  - Use: symptom versus cause, black-box versus white-box monitoring, four golden signals, actionable paging, and avoiding monitoring complexity for its own sake.
  - Verified: 2026-09-05; refresh after 365 days.
- **Prometheus: Alerting practices**: https://prometheus.io/docs/practices/alerting/
  - Scope: Prometheus documentation available 2026-09-05.
  - Use: page on user-impacting symptoms, keep pages actionable, allow appropriate slack, provide consoles, and metamonitor the monitoring system.
  - Verified: 2026-09-05; refresh after 90 days.
- **OpenTelemetry Semantic Conventions 1.44.0**: https://opentelemetry.io/docs/specs/semconv/
  - Scope: semantic-conventions version 1.44.0 available 2026-11-07.
  - Use: standard meanings and naming for resource, span, metric, log, event, and profile attributes. Check individual convention stability before adopting a developing convention as a durable public schema.
  - Verified: 2026-11-07; refresh after 60 days.
- **OpenTelemetry: Sampling**: https://opentelemetry.io/docs/concepts/sampling/
  - Scope: guidance last modified 2025-10-16 and available 2026-11-07.
  - Use: head/tail sampling tradeoffs, outcome-aware tail sampling, sampler state/capacity costs, and monitoring the sampling path itself.
  - Verified: 2026-11-07; refresh after 90 days.

## Interpretation rules

- Define the user/service objective and raw event population before choosing a dashboard visualization or alert threshold.
- Preserve metric units, aggregation, event eligibility, and denominators. A dashboard number without its contract is not an SLI.
- Keep high-cardinality correlation in appropriate trace/log fields, not metric labels; still apply repository privacy and secret-handling policy to every signal.
- Treat sampling policy as part of measurement semantics. State what is sampled, what must be retained, and which counts still represent the full population.
- Monitor the telemetry pipeline itself and maintain at least one independent/black-box path for critical user-impact detection when feasible.
