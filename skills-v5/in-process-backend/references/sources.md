# Source map

## Lifetime interpretation

- **Dependency injection guidelines**: https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection/guidelines
  - Scope: .NET dependency injection disposal and lifetime guidance as available 2026-09-06.
  - Verified: 2026-09-06; refresh after 90 days. The .NET container owns disposal for instances it creates, while externally supplied instances retain a different ownership contract.
  - Adopt explicit creation, borrowing, lifetime, and disposal ownership. Adapt this distinction to the actual host's module lifecycle, including partially initialized and long lived owners.
  - Reject imposing .NET, a dependency injection container, singleton services, or a factory pattern on every backend. These mechanisms are conditional examples, not portable requirements.

- **SQLite transactions**: https://sqlite.org/lang_transaction.html
  - Scope: SQLite transaction and locking guidance as available 2026-10-17.
  - Use: transaction and locking terminology only. The source does not prove application level effect idempotency, worker scheduling, or restart recovery.
  - Verified: 2026-10-17; refresh after 180 days.

- **AbortSignal**: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
  - Scope: AbortSignal cancellation notification semantics as available 2026-10-17.
  - Use: a cancellation signal notifies consumers; it does not settle an arbitrary promise or transfer ownership of shared work.
  - Verified: 2026-10-17; refresh after 90 days.

Topology belongs to `backend-engineering`. Host execution, not this documentation, proves isolation between consumers, reentrancy, and cleanup. This content review does not establish paired or blind efficacy qualification.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit and evaluation ledger is authoritative for qualification status.
- Hierarchy: broader `backend-engineering`.
- Routing: five positive, five near neighbor negative, three compound or ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill or no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: lifecycle background and reference discovery only; the landing page is not evidence for host specific disposal or concurrency semantics.
  - Verified: 2026-09-04; refresh after 180 days.

The maintained sources support terminology and decision framing. They do not establish that the current Bun fixture used SQLite, that two OS threads or goroutines raced, that a process was restarted, that a non cooperative dependency was bounded in a production host, or that recovery occurred outside the fixture. Keep those claims `unavailable` until the corresponding runtime receipt exists.
