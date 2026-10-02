# Source map

`debugging` is individually authored. Promotion still requires clean public and held out routing, paired full task evidence using the same model for the skill and baseline arms, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: root responsibility with narrower children `concurrency-debugging`, `deterministic-debugging`, `distributed-debugging`, `hardware-runtime-debugging`, and `performance-debugging`.
- Routing: five positive, five near neighbor negative, three compound or ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, paired skill and baseline runs using the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative specifications and reference sources outrank community patterns when they conflict. Runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: reproduce or directly establish the problem, understand the system, form and test hypotheses, reduce the failing path, distinguish correlation from causation, mitigate safely when necessary, then correct root cause.
  - Authority: first party Google SRE troubleshooting guidance. Apply its method proportionally rather than importing production operations assumptions into every repository bug.
  - Verified: 2026-09-04. Refresh after 180 days.

- **Google Engineering Practices: Small CLs**: https://google.github.io/eng-practices/review/developer/small-cls.html
  - Scope: developer guidance as available 2026-09-04.
  - Use: focused and self contained bug fix changes, related test code, reviewability, and scope that can be rolled back safely.
  - Authority: strong industry practice that remains subordinate to repository instructions and the actual bug contract.
  - Verified: 2026-09-04. Refresh after 180 days.

## Interpretation rules

- A reproduction is preferred but not mandatory when the system cannot safely or practically be reproduced; direct logs, traces, crash data, or state evidence can establish the failure if the limitation is explicit.
- A correlation or symptom disappearing after a broad rewrite is not sufficient root cause evidence.
- Mitigation and permanent correction are distinct outcomes; label them accordingly.
- The regression check should protect the demonstrated contract at the closest useful observable boundary, not implementation trivia.
