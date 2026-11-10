# Source map

`concurrency-debugging` is individually authored. Promotion still requires clean routing, paired full task evidence from the same model with and without the skill, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging.
- Routing: five positive cases, five negative cases from near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, pairing the same model with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Local evidence boundary

The document save exercise uses begin/commit phases, and the shutdown exercise computes a model of lock ordering. Executed outputs establish **simulated** schedules and state, not native thread blocking, actual worker completion, or production recovery. Both task contracts require bounded repeatability records tied to executed schedule assertions. The broader runtime failure, cleanup, and recovery checks in [the incident evidence playbook](incident-evidence.md) remain unavailable until an appropriate executable seam exists. Routing and task fixture requirements describe evaluation contracts; they do not assert that qualification or blind evaluation has run.

The current shared deterministic scorers do not fully enforce those records: the save scorer recognizes repeat/stress test text and a numeric report without proving the authored loop executed; the deadlock scorer checks authored red/green regression behavior but not a receipt for each iteration. Treat a scorer pass as bounded by its actual assertions, not as proof that every package evidence requirement was verified. Closing that enforcement gap requires work outside this package.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: controlled hypothesis testing and causal troubleshooting discipline.
  - Verified: 2026-09-04; refresh after 180 days.

- **Clang: ThreadSanitizer**: https://clang.llvm.org/docs/ThreadSanitizer.html
  - Scope: Clang 24 development documentation opened 2026-09-06.
  - Adopted: instrumented dynamic detection of data races, with runtime/platform and instrumentation limits made explicit.
  - Rejected: reading a clean ThreadSanitizer run as proof of deadlock freedom or absence of all races. Deadlock diagnosis needs a relevant wait/ownership oracle.
  - Verified: 2026-09-06; refresh after 180 days.

- **Go: The Go Memory Model**: https://go.dev/ref/mem
  - Scope: June 6, 2022 revision inspected 2026-10-17.
  - Adopted: distinguish actor program order from synchronization edges; use documented mutex/channel/atomic handoffs and observed reads to justify visibility claims.
  - Boundary: these are Go guarantees. Consult the target language and primitive before claiming the same ordering, atomicity, or visibility elsewhere; atomic access alone does not make a multi-step operation atomic.
  - Verified: 2026-10-17; refresh after 180 days.

## Interpretation rules

- Model actor/resource ownership and ordering before editing synchronization.
- A run that does not reproduce the failure does not prove absence of a race; preserve controlled schedules or use appropriate dynamic/static diagnostics when available.
- Do not use arbitrary sleeps as correctness logic or as a substitute for a causal schedule.
- Tool findings are evidence to interpret in the runtime context, not an automatic proof of the only possible root cause.
- Keep recurrence prevention, accepted-work completion, and reconciliation of incident-damaged state separate. A repeatable model result is not an executed recovery observation.
