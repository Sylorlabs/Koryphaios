# Source map

## Applied curation, 2026-09-06

[Command Line Interface Guidelines](https://clig.dev/) was inspected for stdout/stderr separation, noninteractive behavior, pipes, errors, cancellation and plain output. Adopt composability and real-terminal verification. This is maintainer-authored community guidance, not the POSIX specification. Do not require every program to use the same flag vocabulary, progress style, or interactive prompts. Shared permission rules do not belong in every terminal child; stream and terminal lifecycle constraints do.

`terminal-interface` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader visual-interface-design, frontend-engineering; narrower children shell-cli-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **POSIX.1-2024**: https://pubs.opengroup.org/onlinepubs/9799919799/
  - Scope: The Open Group Base Specifications Issue 8 / POSIX.1-2024
  - Use: Shell, utilities, process, stream, signal, and portability contracts.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
