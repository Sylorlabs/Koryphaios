---
name: deterministic-debugging
description: Debug a repeatable logic, parsing, state, lifecycle, or contract failure by minimizing the reproducer and locating the first causal divergence. Use when the same input or controlled state reliably produces the same wrong behavior.
---

# Deterministic Debugging

Start from a deterministic reproduction: exact input, state, version, command, and expected versus observed behavior. Reduce it while preserving the failure, then trace the relevant transformations or state transitions until the first value, branch, or invariant diverges from the intended contract.

Test the causal hypothesis with a focused observation or assertion before editing. When a fix is authorized, correct the owning boundary rather than masking the final symptom, then keep the minimized case as regression evidence and rerun the surrounding contract checks. For diagnosis-only work, hand off that reproducer and proposed correction without changing the implementation.

Use the parent `debugging` discipline for the full reproduce/hypothesize/fix/regress loop. Route timing-dependent schedules to `concurrency-debugging`, multi-process/service causality to `distributed-debugging`, and measured resource/latency regressions to `performance-debugging`.

Use [the maintained source map](references/sources.md) for the troubleshooting basis.
