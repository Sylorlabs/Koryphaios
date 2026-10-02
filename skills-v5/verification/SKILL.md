---
name: verification
description: Establish whether work satisfies its acceptance claims using fresh evidence from the actual target surface. Use when verifying a change or preparing a completion claim; compose specialist verification skills for domain specific oracles and state any unavailable proof.
---

# Verification

Own the final claim-to-evidence boundary. Turn the requested outcome and acceptance criteria into a small set of falsifiable claims, select an observable oracle for each claim, gather fresh evidence after the latest relevant change, and report only what that evidence establishes.

## Evidence loop

1. State each material claim, target environment, and observable pass/fail discriminator. “The command exited 0” is not proof of the effect the command was meant to cause.
2. Choose the narrowest trustworthy oracle. Prefer repository-supported checks and direct inspection of resulting state. `testing-engineering` owns test strategy; this skill owns whether the completion claim is actually proven.
3. Use fresh evidence after the latest relevant edit/build/deployment/state change. Exercise the real consumer-facing boundary when practical, not only a helper or mock.
4. Treat tool success messages as reported evidence, not independent proof. For consequential mutations, read resulting state through an independent path when practical; validate surprising absence/zero readings with a known-hit probe or second view.
5. Scale checks to material risk and unresolved uncertainty. Do not repeat a clean check unless state changed or the instrument is suspect.
6. Mark each claim `confirmed`, `refuted`, or `inconclusive`, preserving exact checks, environment, unavailable evidence, and residual uncertainty. Never promote mocked, simulated, stale, or inaccessible evidence into real-runtime proof.

Before completion, validate the claim to oracle artifact. Every material claim needs an oracle, observed result, and verdict, plus one overall verdict of `confirmed`, `refuted`, or `inconclusive`. Missing any field is incomplete. The overall verdict must agree with unresolved material claims and expose any missing discriminator.

Persist the claim-to-oracle map in the task-designated report artifact when one is requested, even for read-only verification. Include the exact focused-check commands and results, the real consumer command and observed output or its unavailable status, the independent discriminator, and the overall verdict; a prose-only answer does not replace the report.

Preserve the requested report format and location. When JSON is requested, validate its syntax and required fields, including every material claim, its oracle and observed result, and the overall verdict. A passing focused test cannot override a failed consumer observation. A failing required claim refutes completion; missing or stale proof makes it inconclusive. Apply the same bounded verdict in the final response and the persisted artifact.

## Specialist boundaries

Compose the narrower oracle when required: `functional-verification`, `reliability-verification`, `security-verification`, `accessibility-verification`, `visual-verification`, or `performance-verification`. Their specialist result does not permit a broader completion claim than the evidence supports.

## Failure and stop conditions

Distinguish product failure from environment, fixture, or instrument failure before generalizing. If the target surface is unavailable, the oracle cannot observe the claim, or evidence remains contradictory after a bounded second check, report `inconclusive` and the missing evidence. Stop once every material claim has a fresh bounded verdict and another check would not change confidence or scope.

Use [the maintained source map](references/sources.md) for version-sensitive guidance, provenance, and conflicts.
