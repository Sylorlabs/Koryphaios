# Native Electron V5 environment

This environment provides a shallow, standalone smoke fixture for a real macOS
arm64 Electron runtime extracted from the existing Electron distribution cache.
The executable and all generated evidence live **outside `skills-v5/`** to avoid
the bundled skill resource depth limit enforced during `seedDefaultSkills()`.
Never extract an Electron app, Chromium profile, or generated evidence beneath
this skill package, even in a Git-ignored directory.

The example below records a historical host-local extraction. `/private/tmp`
may be cleaned by macOS, so confirm the executable exists and passes the
evaluator's version/header preflight before treating it as available. To use a
verified local extraction in an evaluator process launched from the repository
root:

```sh
export KORY_SKILL_EVAL_ELECTRON_BINARY="/private/tmp/kory-v5-electron-runtime-20261010/runtime/electron-v42.9.0-darwin-arm64/Electron.app/Contents/MacOS/Electron"
```

The executable must pass its `--version` check and the evaluator's
`ELECTRON_RUN_AS_NODE=1` Electron/Chromium version check. A standalone GUI check
can then be run with:

```sh
export KORY_ELECTRON_SMOKE_OUTPUT_DIR="/private/tmp/kory-v5-electron-runtime-20261010/evidence"
"$KORY_SKILL_EVAL_ELECTRON_BINARY" "$PWD/skills-v5/desktop-electron-tauri/evals/environment/native-smoke"
```

The smoke check opens a visible native `BrowserWindow`, verifies the isolated
renderer and native window handle, captures compositor pixels, closes the
window, and records `receipt.json`, `window.png`, and `user-data/` in the
external output directory. The existing receipt was preserved during relocation
and still contains its original screenshot path; use the relocated PNG and its
SHA-256 hash to identify that artifact. These outputs establish only local
Electron GUI capability; they are **not**
qualification reports and do not establish packaged application behavior.

The external `runtime/` folder contains 292 MB extracted from the local
`electron-v42.9.0-darwin-arm64.zip` cache. `/private/tmp` is machine-local and
may be cleaned by the OS; restore the runtime **outside `skills-v5/`** and
update `KORY_SKILL_EVAL_ELECTRON_BINARY` if that happens. Keep evaluator drivers
and their user data outside the skill package as well.

Tauri remains unavailable for native V5 qualification until a real Tauri v2
CLI and a trusted external `KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER` can build and
drive a packaged app, including actual dialogs, restart, and native capture.
