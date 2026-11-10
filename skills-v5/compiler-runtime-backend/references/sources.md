# Source map

## Applied curation, 2026-09-06

The test organization and regression sections of [LLVM Testing Infrastructure](https://llvm.org/docs/TestingGuide.html) were inspected. Adopt small defect-reproducing cases and distinguish internal transformation checks from whole-program execution against an oracle. Do not mandate LLVM, FileCheck, lit, a particular IR, or a repository layout for another compiler. Preserve target/host and semantic phase boundaries. General authority and handoff paragraphs were removed without weakening the language-specific checks. Reading this guide does not prove a compiler or a skill correct.

`compiler-runtime-backend` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering; narrower children embedded-firmware.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **LLVM documentation**: https://llvm.org/docs/
  - Scope: LLVM project documentation as available 2026-09-04
  - Use: Compiler, IR, runtime, optimization, toolchain, and testing reference.
  - Verified: 2026-09-04; refresh after 90 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
