---
name: functional-verification
description: Verify a feature against its acceptance contract across success, invalid input, persistence, and recovery. Use when functional verification, acceptance tests, or regression checks are needed; compose other verification specialties for security, accessibility, visual, or performance claims.
---

# Functional Verification

Establish whether the implemented behavior matches the contract a user or consuming system can observe. Start from stated requirements, acceptance criteria, existing public behavior, and the change's affected surfaces; do not infer success from implementation shape or from a green lower-level test alone.

## Verification loop

1. **Write the behavioral claims.** Convert the request into a compact acceptance matrix: precondition, action, expected observable result, durable state change, and failure result where relevant. Separate explicit requirements from inferred compatibility expectations.
2. **Use the real consumer boundary.** Exercise the supported command, API, UI flow, persisted artifact, or protocol surface at the narrowest level that still observes the claim. Internal calls are supporting evidence, not the oracle, when the public boundary can disagree.
3. **Cover the state transitions that matter.** Include the nominal path plus material boundaries: empty/maximum values, invalid input, repeated operation, partial progress, cancellation, persistence across reopen/restart, and recovery after an expected failure. Do not mechanically enumerate cases that cannot change the verdict.
4. **Inspect side effects independently.** For mutations, read the resulting state through an observable path distinct from the success response when practical. Confirm both intended effects and important non-effects such as `dry-run`, cancellation, rejection, or rollback.
5. **Preserve compatibility.** Re-run the nearest unchanged contract or regression that could plausibly be broken by the change. A new behavior passing while an adjacent existing behavior regresses is not a functional pass.
6. **Issue bounded verdicts.** Mark each acceptance claim confirmed, refuted, or inconclusive and attach fresh evidence. Distinguish a product failure from an unavailable environment or broken test instrument.

## Boundaries

- `verification` owns the overall claim-to-evidence completion verdict.
- `testing-engineering` owns designing durable new test coverage. Functional verification may run or minimally extend a fixture when needed to observe a claim, but it should not expand into a general suite redesign.
- `security-verification`, `accessibility-verification`, `reliability-verification`, `visual-verification`, and `performance-verification` own their specialized oracles. Compose them when the acceptance contract contains those claims rather than approximating them with generic functional checks.

Never report a mocked, simulated, stale, or internal-only observation as proof of a behavior that depends on a different real surface. Use [the maintained source map](references/sources.md) for the verification and acceptance guidance behind this workflow.
