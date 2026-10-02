# Source map

Usability evaluation answers a bounded question about how people or justified expert proxies perform and understand realistic tasks under stated conditions. It does not discover broad unmet needs by default, replace analytics/statistics, or prove implementation correctness.

## Maintained interpretation

- Define the decision first. Name the participant population or justified proxy, product state, task, environment, success/recovery signals, measures, and result that would change the plan before selecting a method.
- For moderated task evaluation, frame tasks as believable goals rather than interface instructions. Do not reveal the intended path or teach the design. Observe what people do and say, where they hesitate or backtrack, whether they complete, what assistance is required, and whether they understand outcomes and recovery.
- Preserve the observation layer before interpretation. Record what happened, then distinguish a finding supported by evidence from a hypothesis about cause and from a proposed design change.
- Scope claims to the actual people, tasks, product version, environment, medium, and method. Convenience samples, small qualitative studies, and expert inspections do not establish population prevalence or statistical effect size.
- Use expert cognitive walkthroughs or heuristics when participant access, design maturity, or the decision makes inspection useful, but label them as expert evidence. They can identify plausible breakdowns and test hypotheses; they do not substitute for observed representative-user behavior when that is the claim.
- Prioritize findings by consequence to the task: harm, irreversibility, task criticality, frequency within the observed evidence, assistance/workaround, and confidence. Preserve contradictory cases rather than averaging them away.
- Retest consequential changes under comparable task conditions. A changed interface is not proof that the original usability problem was resolved.

## Community-pattern review

Nielsen Norman Group's heuristic set is a useful structured vocabulary for expert review, but Kory does not treat a heuristic violation as automatically severe or universal. Severity must remain tied to the actual product, task, population, consequences, and evidence.

Rampstack's MIT `usability-testing` package contains strong operational patterns around goal-framed tasks, neutral moderation, observing hesitation/backtracking, issue synthesis, and retesting. It also contains fixed sample-size ranges, timing formulas, the legacy "5 users / 85%" claim, and fixed frequency-based severity definitions. Those are not universalized because study design and inferential strength depend on the question, participant segments, task heterogeneity, risks, and intended claims.

## Verification record

- GOV.UK moderated usability testing: official Service Manual guidance verified 2026-09-04; recheck within 90 days.
- GOV.UK research-session analysis: official Service Manual guidance verified 2026-09-04; recheck within 90 days.
- Nielsen Norman Group usability heuristics: industry primary-source article checked 2026-09-04; recheck within 120 days.
- Rampstack `usability-testing`: GitHub `main` inspected 2026-09-04; repository license is MIT. Recheck within 30 days.
