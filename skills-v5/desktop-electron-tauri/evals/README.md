# Native desktop V5 evaluator

## Electron scenario 1

The evaluator in `backend/src/kory/skill-eval-desktop-runtime.ts` materializes
`desktop-electron-tauri-full-task-1-individual`. The starting application is
intentionally broken: each settings window registers another global IPC
listener and never removes it. The existing `settings.save(settings)` and
`settings.onSaved(callback)` preload API must survive the repair.

The native runner requires an **actual Electron 42.9.0 executable**, not a
shell script, version-only launcher, headless browser, mocked IPC channel, or
screen image supplied by the candidate. Its preflight checks the native
executable header and exact reported version. The definitive proof is a
separate real Electron process with visible native `BrowserWindow` instances.

On the October 10, 2026 Apple Silicon host, the extracted runtime was recorded
at:

```text
/private/tmp/kory-v5-electron-runtime-20261010/runtime/electron-v42.9.0-darwin-arm64/Electron.app/Contents/MacOS/Electron
```

That `/private/tmp` path is a historical, host-local location and may have been
removed by macOS. Verify that the executable exists and passes the harness
preflight before using the command below; the recorded path alone is not
runtime evidence.

To run the **targeted tests only** on that host, with complete native check
details emitted for inspection:

```sh
KORY_SKILL_EVAL_ELECTRON_BINARY=/private/tmp/kory-v5-electron-runtime-20261010/runtime/electron-v42.9.0-darwin-arm64/Electron.app/Contents/MacOS/Electron \
KORY_SKILL_EVAL_PRINT_NATIVE_SMOKE=1 \
bun test backend/src/kory/__tests__/skill-eval-desktop-runtime.test.ts --timeout 180000
```

On another host, provide the absolute path to its trusted native Electron
42.9.0 executable through `KORY_SKILL_EVAL_ELECTRON_BINARY`. An unavailable,
incompatible, or simulated runtime blocks materialization and yields zero
verification credit.

The evaluator drives three open/close cycles, a renderer reload, two
simultaneous windows, and native app quit. It checks IPC write counts and
per-window ownership, zero lingering listeners, visible native window handle,
isolation preferences, the exact preload bridge surface, and a real renderer
attempt to invoke a forbidden IPC API. It captures pixels through
`webContents.capturePage()` and checks the native bitmap, PNG dimensions and
content hash. The receipt must include every required check, exact native
version, Chromium identity, current child process ID, fresh challenge, ordered
window/quit events, and no process errors. Missing, mismatched, or tampered
evidence fails closed.

The tests assert that the broken starting app scores red, a repaired app
scores green, and a subsequent preload change exposing a generic IPC method
scores red again. They also cover runtime spoofing, fixture identity tampering,
unsafe source symlinks, and absence of the native Tauri driver.

## Integration boundary and limits

Consumers can register `DESKTOP_SKILL_EVAL_MATERIALIZERS` and
`DESKTOP_SKILL_EVAL_SCORERS` from the evaluator with the skill evaluation
execution pipeline. This standalone fork does not modify the central
registration, promotion ledger, immutable scenario definitions, or scoring
campaign.

The Electron test uses the native **unpackaged fixture** launched through the
trusted Electron application binary on macOS ARM64. It does not prove a
signed/distributed packaged build, cross-OS behavior, updates, or the
skill/no-skill blind evaluation. Those need separate qualification evidence.
Native receipts and captures are made in disposable temporary directories.

Tauri scenario 2 remains unqualified until an actual Tauri v2 build toolchain
and trusted native window/dialog driver are provided. It cannot inherit
Electron's result.
