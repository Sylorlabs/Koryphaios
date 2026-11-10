---
name: refactor-implementation
description: Improve internal structure while preserving defined external behavior. Use when the request specifically requires refactor, restructure, extract abstraction, remove duplication; prefer a narrower child only when its boundary is established.
---

# Refactor Implementation

## Responsibility

Define invariants and compatibility first, add characterization evidence where behavior is uncertain, move in reviewable steps, reduce rather than relocate complexity, and remove obsolete paths without mixing unrelated features.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

## Professional practice

Define external behavior and compatibility invariants before editing. Characterize uncertain behavior, then move in reviewable steps that reduce complexity rather than relocate it. Preserve public contracts unless change is authorized; remove obsolete paths and prove no duplicate authority remains. Evidence: characterization checks, structural improvement, invariant results, and focused diff review. Reject simultaneous unrelated features, abstraction for its own sake, and success claims based only on compilation. Method: trace one representative request or event across every changed boundary before editing, then implement in dependency order and keep the system runnable after each coherent increment. Inspect callers and consumers whenever a contract changes. When extracting a narrow interface around stateful or transactional behavior, preserve the whole semantic unit across the boundary: start/begin state, success/commit, failure/rollback or cleanup, error propagation, and recovery visible to callers. Verify the failure path through the new abstraction itself, and when old and new call sites coexist temporarily, prove both routes preserve the same transaction and error contract before removing the old route. Exercise success, boundary, denied, interrupted, and recovery paths in the closest supported environment. Preserve exact diffs and test output, and explain any generated or migrated state. Stop and reassess when the change requires duplicate sources of truth, bypasses an owning abstraction, broadens permissions, or cannot be verified independently. Completion requires observable behavior plus cleanup of superseded paths; compilation, mocks, scaffolding, and code appearance alone are insufficient evidence.

## Completion evidence

- Behavior invariants
- Characterization checks
- Hierarchy boundary and selected specialist rationale
- Representative success, negative-path, and recovery verification
- Preserve contradictory or missing evidence explicitly.
- Verify the highest-value invalid, partial, compatibility, interruption, or recovery path for the actual environment.
- Do not claim success from compilation, a screenshot, a happy-path example, or source documentation alone when runtime or operational evidence is required.

## Supplied pure refactor evaluator

When the registered task provides a fixed `candidate.ts` boundary and an
evaluator-owned `contract.json`, implement the supplied public behavior before
attempting a structural refactor. Do not edit `README.md`, `contract.json`, or
`package.json` in that fixture. For the parser contract, the input shape is
exactly `{source: string, knownKeys: string[]}`. Process each nonempty source
line in input order and split only at the first `=`. The diagnostic object key
is **`code`**, not `kind` or `type`. Missing `=` returns exactly
`{line: N, code: "expected-equals", message: "Expected key=value"}` with no
value field. A key outside `knownKeys` returns exactly
`{line: N, code: "unknown-key", message: "Unknown key: <key>"}`. Preserve
string values and object insertion order. For example, source
`port=8080\nmode=fast` with known keys `port,mode` returns
`{ok:true,value:{port:"8080",mode:"fast"},diagnostics:[]}`; source
`port=8080\nbadline` returns
`{ok:false,value:null,diagnostics:[{line:2,code:"expected-equals",message:"Expected key=value"}]}`.
Return exactly `{ok:false,value:null,diagnostics}` when any diagnostic exists.
Do not replace a stable diagnostic with a parser exception or a different field
name. Add focused characterization tests for valid input, syntax failure, and
semantic unknown-key failure before claiming the extraction preserves behavior.

For the supplied transaction exercise, implement `begin` as a snapshot,
`set` only while active, `error` as restore plus `rollbacks + 1`, and `commit`
as durable current state plus `commits + 1`. A second transaction must start
from the committed state, so two commits over `x=1` then `y=2` return
`{state:{x:1,y:2},commits:2,rollbacks:0}`.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
