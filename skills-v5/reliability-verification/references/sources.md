# Source map

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader verification; narrower children incident-response, observability-sre.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Testing for Reliability**: https://sre.google/sre-book/testing-reliability/
  - Use: systems-level reliability testing, dependency fidelity, stress/disaster-recovery testing, and limits of test confidence.
  - Version scope: Google SRE book chapter available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google SRE: Addressing Cascading Failures**: https://sre.google/sre-book/addressing-cascading-failures/
  - Use: overload failure modes, retry amplification, graceful degradation, component limits, recovery after overload, and noncritical-backend testing.
  - Version scope: Google SRE book chapter available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google SRE: Production Services Best Practices**: https://sre.google/sre-book/service-best-practices/
  - Use: capacity testing, degradation, load shedding, retry discipline, and production-service reliability expectations.
  - Version scope: Google SRE book chapter available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **AWS Well-Architected Framework: Reliability Pillar**: https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html
  - Use: recovery planning, controlled failure simulation, failure-domain thinking, and AWS workload resilience.
  - Version scope: AWS Reliability Pillar material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **Azure Well-Architected Framework: Reliability targets**: https://learn.microsoft.com/en-us/azure/well-architected/reliability/metrics
  - Use: explicit RTO/RPO/MTTR-style targets tied to failure-mode analysis and tested recovery plans.
  - Version scope: Azure guidance available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

## Interpretation rules

- Define the reliability objective before selecting a disturbance; survival alone is not a pass when recovery, correctness, or degradation bounds are part of the contract.
- Prefer isolated or non-production experiments unless production scope and safeguards are explicitly authorized.
- Track correctness and durable state alongside availability/latency; high throughput with duplicate or lost work is a reliability failure.
- Keep short stress tests, long soaks, recovery tests, and disaster-recovery evidence distinct rather than extrapolating one into another.
