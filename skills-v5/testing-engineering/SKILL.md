---
name: testing-engineering
description: Design or improve executable test coverage for a concrete system, change, or regression. Use when the task is to write tests, choose test boundaries, add regression coverage, or build a test strategy; use verification instead when the primary job is to prove a finished change is correct with existing evidence.
---

# Testing Engineering

Turn a behavioral claim or failure risk into durable executable evidence. Start from the contract that must remain true, then choose the cheapest test boundary that can actually falsify it. Do not begin from a framework, test-count target, or fixed pyramid.

## Build the test strategy

1. Recover the user-visible behavior, invariant, protocol, state transition, compatibility promise, or regression being protected. Inspect existing tests before adding a new style.
2. Name the defect the test must catch and the observable pass/fail discriminator. For a bug, preserve the smallest representative regression case.
3. Use the smallest faithful boundary. Move outward only when the risk lives in serialization, persistence, process/network boundaries, rendering, devices, concurrency, or recovery that a smaller test cannot observe.
4. Control time, randomness, files, network, and external services only when doing so preserves the real contract. A mock is invalid evidence when it can pass while the production boundary is broken.
5. Keep layers complementary. Do not repeat the same assertion everywhere. When practical, prove a regression test fails on known-bad behavior or a controlled mutation before relying on its green result.

## Evidence quality

- Prefer behavioral assertions to private implementation details; make relevant state/version/time/order/identity explicit in fixtures.
- Treat flakes as defects or unmodeled behavior, never as permission to retry until green.
- Treat fixture-model evidence as bounded: a fake clock, simulated process, or in-memory substitute proves only the modeled contract unless it exercises the claimed production boundary.
- Preserve reproducible commands, meaningful failures, and skipped/unavailable coverage.
- A passing test proves only the exercised behavior and boundary. `verification` owns the final completion claim.

## Specialist boundaries

Use the narrower child when it owns the risk: `deterministic-contract-testing`, `property-fuzz-differential-testing`, `integration-fault-testing`, `interface-usability-testing`, `performance-testing`, or `simulation-device-testing`. This parent owns coverage strategy and boundary choice; children own their specialist oracle.

Use [the maintained source map](references/sources.md) when test terminology, platform behavior, or external guidance materially affects the strategy.
