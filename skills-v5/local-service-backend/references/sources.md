# Source map

## Applied curation, 2026-09-06

The Linux man pages project's [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) was inspected for peer credentials and pathname versus abstract sockets. Adopt authenticating the actual local peer and verifying host specific endpoint semantics. Do not treat Linux options as portable to every OS, or local IPC as automatically trusted. This source supports a boundary choice, not mandatory Unix sockets or a new service. Shared permission and evidence rules remain with the host/core; lifecycle and local process checks remain here.

`local-service-backend` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version sensitive guidance; qualification is tested with hierarchy aware held out routing, paired same model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering.
- Routing: five positive, five negatives from near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **POSIX.1 2024**: https://pubs.opengroup.org/onlinepubs/9799919799/
  - Scope: The Open Group Base Specifications Issue 8 / POSIX.1 2024
  - Use: Shell, utilities, process, stream, signal, and portability contracts.
  - Verified: 2026-09-04; refresh after 365 days.
- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional practice baseline.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
