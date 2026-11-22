# Probe: are the 14 insufficient-evidence packages fixture contradictions?

Date of measurement: 2026-11-15. Inventory snapshot `generatedAt
2026-11-15T04:38:29Z`: 167 ready, 14 insufficient-evidence, 1 blocked over 182
packages.

Hypothesis under test, taken from the two defects found during the quality phase:
a package that cannot earn evidence is failing because the harness asks for
something its own starter or registry cannot supply. The OpenAlex digest and the
`data-result-query` starter were both that shape, so the same shape was looked for
across every remaining package.

## Result: negative for all 14

Every one of the 14 has two full-task scenarios registered, and each scenario's
blocker names an execution environment or a provenance source rather than a
contract mismatch. None of them is a starter-versus-scorer contradiction.

| Package | Ready | Named blocker |
|---|---|---|
| `computer-use` | 0/2 | real desktop session, first party adapter, sacrificial authorized targets |
| `desktop-electron-tauri` | 0/2 | pinned Electron binary, Tauri v2 CLI plus a native driver |
| `embedded-firmware` | 0/2 | firmware/MCU execution, brownout persistence, ISR timing |
| `embedded-interface` | 0/2 | embedded display/input runtime, device state |
| `game-spatial-interface` | 0/2 | VR/AR spatial runtime with occlusion and placement |
| `gpu-compute` | 0/2 | GPU/CUDA runtime with kernel, memory and profiling evidence |
| `hardware-runtime-debugging` | 0/2 | physical or faithful hardware debugger evidence |
| `image-generation-practice` | 0/2 | real generated media plus visual evaluation |
| `native-interface` | 0/2 | desktop/mobile native runtimes with accessibility and lifecycle |
| `react-native-expo` | 0/2 | device or simulator runtime for AppState and safe area |
| `research` | 0/2 | dated archive corpus with independent provenance |
| `robotics-control` | 0/2 | robot or faithful simulator with timing and watchdog |
| `simulation-device-testing` | 0/2 | Zephyr/STM32 or PX4 HITL/SITL environment |
| `speech-audio-ai` | 0/2 | real audio assets and model inference with listening evidence |

## Host probe

The registry checks are concrete rather than advisory, so the host was probed
directly instead of trusting the report text.

- `cargo` and `rustc` are present at `/opt/homebrew/bin`.
- `tauri` is absent, so the Tauri v2 CLI probe fails before the driver is even
  considered.
- `electron` is absent, and the Electron probe requires exactly `v42.9.0`
  (`PINNED_ELECTRON_VERSION` in `backend/src/kory/skill-eval-desktop-runtime.ts`).
- `KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER` has no honest value on macOS: the driver is
  expected to perform native window automation and compositor capture, and no such
  trusted executable exists on this host. A stub would make an unenforceable
  scenario look enforceable, which is the failure mode the readiness probe exists
  to prevent.

Satisfying the Electron half of `desktop-electron-tauri` is technically possible
(install 42.9.0, point `KORY_SKILL_EVAL_ELECTRON_BINARY` at the binary inside the
app bundle) and was considered and rejected: the package needs both scenarios, the
Tauri half cannot be satisfied honestly here, and a partially evidenced package is
scored the same as a fully blocked one (`partiallyReadyPackages: 0`).

`research` deserves a separate note. Its runtime,
`backend/src/kory/skill-eval-research-history-runtime.ts`, exists and is tested, but
it is not registered in `skill-eval-fixtures.ts`, so only the external gate
materializer matches its scenarios. Wiring it in would not promote the package:
`researchHistoryReadinessBlockers()` refuses execution by design whenever the dated
corpus is absent, and even with a locally consistent corpus it returns
"needs independent archive/Git verification before execution readiness", because a
manifest with correct file hashes is not independent provenance. The gate is
honest.

## One real defect found, and why it must not be "fixed"

The boundary registry still lists `factual-research` as an external boundary even
though its live runtime executes here and the package is ready at 1.000. Removing
that entry looks like cleanup and is a trap:

`evaluationContractHash` in `skill-eval-current-contract.ts` is computed over the
sorted `materializerIds`. The stale gate materially contributed
`factual-research/external-environment-gate/...@1` to that list, so removing it
changes the contract hash and invalidates every existing `factual-research`
evidence row, sending a ready package back to insufficient-evidence until it is
re-run from scratch. Nothing in the gate uses the entry while real evidence exists,
because `executedHere` suppresses declared blockers, so the correct action is to
leave the entry and record why.

## What would actually move these packages

- `desktop-electron-tauri`: install Electron 42.9.0 and provide a real Tauri v2
  native driver, or retire the Tauri scenario as a registered boundary and
  re-derive the contract.
- `research`: capture the dated 2026-09-04 corpus with independent archive or Git
  provenance, which is exactly the evidence the runtime refuses to accept from a
  local manifest.
- The remaining twelve need hardware, a GPU, a device farm, generation media, or a
  supported desktop session. None of them can be produced by editing the library.

No thresholds, tolerances, exclusions, fixtures or scorers were changed by this
probe.
