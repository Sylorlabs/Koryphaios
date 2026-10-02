# Source map

`concurrency-debugging` is individually authored. Promotion still requires clean routing, paired same-model skill/no-skill full-task evidence, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: controlled hypothesis testing and causal troubleshooting discipline.
  - Verified: 2026-09-04; refresh after 180 days.

- **Clang: ThreadSanitizer**: https://clang.llvm.org/docs/ThreadSanitizer.html
  - Scope: Clang 24 development documentation opened 2026-09-06.
  - Adopted: instrumented dynamic data-race detection, with runtime/platform and instrumentation limits made explicit.
  - Rejected: reading a clean ThreadSanitizer run as proof of deadlock freedom or absence of all races. Deadlock diagnosis needs a relevant wait/ownership oracle.
  - Verified: 2026-09-06; refresh after 180 days.

## Interpretation rules

- Model actor/resource ownership and ordering before editing synchronization.
- A non-reproducing run does not prove absence of a race; preserve controlled schedules or use appropriate dynamic/static diagnostics when available.
- Do not use arbitrary sleeps as correctness logic or as a substitute for a causal schedule.
- Tool findings are evidence to interpret in the runtime context, not an automatic proof of the only possible root cause.
