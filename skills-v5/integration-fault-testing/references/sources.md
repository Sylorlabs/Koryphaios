# Source map

`integration-fault-testing` is individually authored for controlled failures at real component boundaries. Promotion still requires paired same-model skill/no skill observations and independent blind evaluation; these sources constrain the testing mechanics and fault semantics rather than proving a candidate is qualified.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader testing-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Testcontainers documentation**: https://testcontainers.com/getting-started/
  - Scope: documentation available 2026-09-05.
  - Use: disposable real dependencies, dynamic mapped ports, readiness/wait strategies, network composition, and cleanup of containers/networks/volumes.
  - Verified: 2026-09-05; refresh after 90 days.
- **Shopify Toxiproxy v2.12.0**: https://github.com/Shopify/toxiproxy/releases/tag/v2.12.0
  - Scope: v2.12.0 server/reference implementation.
  - Use: controlled TCP latency, timeout/reset and related network-fault experiments. Record the server/client version used by a fixture instead of assuming all 2.x clients are equivalent.
  - Verified: 2026-09-05; refresh after 180 days.
- **Google SRE: Addressing Cascading Failures**: https://sre.google/sre-book/addressing-cascading-failures/
  - Scope: SRE book guidance available 2026-09-05.
  - Use: retry amplification, retry budgets, randomized exponential backoff, cancellation propagation, overload behavior, and why failure tests must observe useful work as well as errors.
  - Verified: 2026-09-05; refresh after 180 days.
- **RFC 9293: Transmission Control Protocol**: https://www.rfc-editor.org/rfc/rfc9293.html
  - Scope: RFC 9293.
  - Use: normative TCP reset and connection-state semantics when a test injects transport-level connection failures.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Prefer the protocol/specification and the actual dependency's versioned documentation over a test tool's convenience abstraction when deciding what behavior is possible.
- A fault proxy proves behavior at the proxied transport boundary. It does not prove physical network, kernel, device, or provider behavior that the fixture did not reproduce.
- Keep substitutes faithful to the contract and inspectable. A mock that simply returns a chosen error is not equivalent to a real dependency failing after a commit or acknowledgement boundary.
- Preserve the exact fault placement, timing, runtime versions, and durable-state oracle with the result so the failure can become a regression case.
