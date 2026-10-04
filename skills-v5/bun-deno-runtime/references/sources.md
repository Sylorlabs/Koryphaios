# Source map

`bun-deno-runtime` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Bun documentation**: https://bun.com/docs
  - Scope: Bun documentation as available and inspected 2026-10-03
  - Use: Bun runtime, package, test, server, and compatibility behavior.
  - Verified: 2026-10-03; refresh after 30 days.
- **Deno documentation**: https://docs.deno.com/
  - Scope: Deno runtime getting-started documentation last modified 2026-07-29 and inspected 2026-10-03.
  - Use: Deno runtime, secure-default permissions, package and built-in toolchain, server, and Node compatibility behavior.
  - Verified: 2026-10-03; refresh after 30 days.

## Targeted permission review, 2026-10-02

Retrieved https://docs.deno.com/runtime/fundamentals/security/ and the filesystem API index at https://docs.deno.com/api/deno/file-system/. The security guidance distinguishes scoped read and write grants, permission denials, and subprocess authority outside the runtime sandbox. The API index identifies filesystem operations; it was not a complete per API permission audit. Historical paired artifacts show an output write followed by a denied read. The entrypoint now makes that capability distinction explicit without prescribing the fixture implementation or widening access. This source review is not a fresh runtime execution or evidence of improved model outcomes.

## Interpretation rules

Local evaluator check, 2026-09-06: the Bun migration fixture exercises Bun 1.3.14 against Node v26.8.1/npm 11.19.0 with a local dependency, root postinstall generation, frozen lockfile, package exports, CLI behavior, timer cancellation, and POSIX interruption cleanup. This is bounded runtime evidence, not a recommendation to adopt those versions or proof of Deno behavior. The reusable skill does not prescribe the fixture's architecture. See `backend/src/kory/skill-eval-bun-runtime-fixtures.ts` in the repository.

Completed Deno verification, 2026-09-06: `backend/src/kory/skill-eval-deno-runtime-fixtures.ts` exercises pinned Deno 2.9.6 against actual temporary files, loopback HTTPS/redirects, a disposable Git repository, independent raw permission-denial probes and evaluator-owned side-effect readbacks. All 13 controls passed with 46 assertions, including a Node-compatible filesystem implementation; the subsequent seven-file Bun/Deno/core regression run passed 89 tests with 778 assertions and backend typechecking. Narrow flag ordering may vary; code need not use one prescribed filesystem API. TLS verification remains enabled with a corrected end-entity test certificate. This is evidence for the bounded local evaluator, not a hostile-code sandbox, protection against concurrent path replacement, blind qualification, or proof of skill uplift. Child-process authority remains outside Deno's own permission sandbox. Runtime/tool availability remains a readiness gate.

Targeted recheck, 2026-09-06: https://bun.com/docs/runtime/nodejs-compat and https://bun.com/docs/pm/lifecycle distinguish API compatibility from dependency-script trust. https://docs.deno.com/runtime/reference/permissions/ and https://docs.deno.com/examples/subprocess_tutorial/ document capability flags and the critical limitation that child processes are not confined by Deno's sandbox.

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
