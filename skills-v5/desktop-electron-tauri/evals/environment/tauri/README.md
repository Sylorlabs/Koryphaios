# Tauri V5 scenario 2: host readiness and evidence contract

This directory supports `desktop-electron-tauri-full-task-2-individual`.
It provides host-contract tests, prerequisite checks, and an **opt-in native
run supervisor** for a separately reviewed external scenario driver. It is
not the qualification writer or a device evaluator. Tests never emit a
successful native-device verdict. Nothing here modifies the scenario,
the evaluator, scoring, fixtures, promotions, or the evaluation ledger.

## Run without a Tauri device, CLI, or network

From the repository root:

```sh
sh skills-v5/desktop-electron-tauri/evals/environment/tauri/run-tests.sh
node skills-v5/desktop-electron-tauri/evals/environment/tauri/readiness.mjs
node skills-v5/desktop-electron-tauri/evals/environment/tauri/native-run.mjs
```

The tests require Node 20+ and a local Rust compiler. They use temporary
directories outside `skills-v5/`. The environment probe runs read-only
`--version` commands and checks executable paths; it does **not** install
packages, build an app, start a device, invoke the evaluator, or write evidence.

For a CI gate on prerequisites, append `--strict`: exit 2 means blocked,
not test failure. A normal preflight exits 0 so diagnostics can be collected
even when Tauri is missing. Its `nativeAttemptReady` field means only that
toolchain and an external driver path were found. Its
`nativeDeviceVerified` field is always `false`.

`native-run.mjs` is also safe to invoke when prerequisites are absent: it
reports `status: blocked`, lists missing tools, and exits 2 **before launching
any process, building a fixture, or writing a run directory**. It adds a
mandatory reviewed-driver fingerprint and macOS OS-witness prerequisites.

## Supervised native attempt (only with real packaged runtime)

The supervised driver protocol is executable when a real Tauri v2 CLI and a
separately reviewed, native UI-capable **external driver** are available on
macOS. It cannot convert the bundled host tests into native proof, and does
not install a CLI or manufacture a driver. Read/review the external driver
before using it; an executable bit alone is insufficient evidence of trust.

```sh
export KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER=/absolute/path/to/reviewed-driver
export KORY_SKILL_EVAL_TAURI_REVIEWED_DRIVER_SHA256=<reviewed-driver-sha256>
# Optional if the CLI is not in desktop/node_modules, root node_modules or PATH:
export KORY_SKILL_EVAL_TAURI_CLI=/absolute/path/to/tauri-v2
node skills-v5/desktop-electron-tauri/evals/environment/tauri/native-run.mjs
```

The SHA-256 must match the **independently reviewed** driver bytes, not just
an arbitrary file selected for this run. An absent or mismatched pin blocks
execution. The driver is invoked with a fresh random challenge and an isolated
directory under the system temporary directory. Only the minimal environment
needed for a native build is forwarded. The supervisor does not edit the repo
or evaluation files.

The driver must implement this line-delimited JSON protocol over standard
input and output. It receives these command arguments:

```text
--scenario desktop-electron-tauri-full-task-2-individual
--tauri-cli /absolute/path/to/tauri-v2
--challenge <fresh-64-hex-character-challenge>
--run-dir /absolute/external/isolated-run-directory
```

It must build the scenario **as a packaged Tauri v2 `.app`**, run its real
window, operate the real native folder dialog, test cancellation, root
selection, symlink retarget and denied IPC, reopen the dialog, stop the app,
relaunch and verify restored state. The build must use bundle ID
`dev.koryphaios.v5.tauri.scenario2`, and the executable must live beneath
`<run-dir>/*.app/Contents/MacOS/`. It must inspect the generated capabilities,
command list, and bundle metadata rather than relying on a dev-server window.

The driver sends **one JSON line per checkpoint** and waits for the
supervisor's `{ "checkpoint": ..., "proceed": true, "challenge": ... }`
acknowledgement before taking further action:

```json
{"checkpoint":"packaged-launch","pid":4211,"executablePath":"/absolute/run-dir/Scenario.app/Contents/MacOS/scenario"}
{"checkpoint":"app-quit","pid":4211}
{"checkpoint":"packaged-relaunch","pid":4212,"executablePath":"/absolute/run-dir/Scenario.app/Contents/MacOS/scenario"}
{"checkpoint":"complete","receiptPath":"/absolute/run-dir/receipt.json"}
```

At `packaged-launch`, the process and its window must already be visible.
At `app-quit`, the first process must actually have exited. At
`packaged-relaunch`, the second process must be running **with restored
state already displayed**. The supervisor independently checks the process
executable through macOS `ps`, the Mach-O header and bundle metadata, and
the current window through System Events; it brings the application to the
front and captures compositor pixels with `screencapture`. These operations
require a logged-in desktop with Accessibility and Screen Recording access.
Permission refusal, headless sessions, wrong process identity, or missing
windows cause explicit failure. Linux/Windows return `blocked` until a
reviewed host-specific witness is implemented.

The driver must write the v1 receipt schema documented below to exactly
`<run-dir>/receipt.json`. Its `package.executablePath` must name the same
binary witnessed at both checkpoints; `capture.path` and `capture.sha256`
must match the **supervisor-produced** `relaunch.png` screenshot. The
`packaged-launch`, `app-quit` and `packaged-relaunch` receipt PIDs must match
the observed processes. The driver must wait for completion acknowledgement
and clean up the application it launched before exiting. Any malformed
checkpoint, mismatched challenge/receipt, bad hash, missing event, process
still alive at quit, or timeout fails the attempt.

The supervisor emits three nonzero exit codes:

| Exit | `status`                 | Meaning                                                                                                                     |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 2    | `blocked`                | Prerequisite missing; driver never started.                                                                                 |
| 1    | `native-attempt-failed`  | Driver or independent OS witness failed.                                                                                    |
| 3    | `native-window-observed` | Packaged process, native window, relaunch and OS screenshots were witnessed; receipt passed **structural inspection only**. |

Even at exit 3, `nativeDeviceVerified: false` and
`scenarioQualified: false` remain mandatory. Dialogue interaction, symlink
denial and restoration are **driver-reported** and require independent
review; a screenshot file's header does not prove its visible content.
Full V5 qualification additionally requires the evaluator's actual scenario
runtime, paired skill/no-skill attempts and blind review. The supervisor
does not write or unlock those results.

The probe checks the effective evaluator-style Tauri CLI path in this order:
`KORY_SKILL_EVAL_TAURI_CLI` (if set), the project-local
`desktop/node_modules/.bin/tauri` and root `node_modules/.bin/tauri`,
then a `tauri` executable on `PATH`. The CLI must respond with Tauri v2.
`cargo tauri --version` is reported for diagnosis only; it does not satisfy
the evaluator's direct `tauri --version` probe.

A native driver must be explicitly configured using
`KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER` as an absolute path to a regular,
executable file outside the bundled skill tree. Symlinks and group/world
writable drivers are rejected. Existence and permissions are necessary but
**do not establish driver trust, actual GUI access, or executed evidence**.

## Host-level security regressions exercised

`host-boundary.rs` models the Rust command boundary with no Tauri dependency:

- A picker returns a typed `Cancelled` or `Selected(path)` result.
  Cancellation does not silently choose the user's home directory.
- Only a host-owned canonical root is authorized. A relative renderer path
  is canonicalized and checked at each use. A symlink retargeted after
  selection cannot silently escape the selected root.
- Absolute and traversal inputs fail closed. Selecting a different root on
  reopen revokes the previous root.
- A new guard must restore a host-owned saved pin and revalidate the root
  before any read. A missing or redirected root causes the cold-start
  simulation to deny access.

These are host filesystem **contract tests** on real temporary files and
symlinks. The restart test reconstructs state in a fresh guard object; it is
not an app restart. `fs::canonicalize` followed by `fs::read` is not a
complete defense against a hostile concurrent rename of a canonical ancestor.
Actual app integration needs a handle-relative open and native checks under
the target OS, plus Tauri v2 capabilities and a restricted command registry.
This reference model is deliberately not wired into generated scenario
fixtures.

## Evidence accepted for structural review

A **trusted external native driver** can produce a JSON receipt in an external
temporary run directory. The standalone inspector checks schema, challenge,
freshness, event order, a packaged executable's existence/hash, and a native
capture's existence/hash/plausible PNG header. To inspect a receipt:

```sh
node skills-v5/desktop-electron-tauri/evals/environment/tauri/readiness.mjs \
  --receipt /absolute/external/run/receipt.json --challenge "<fresh challenge>"
```

The receipt schema is:

```json
{
  "schemaVersion": 1,
  "scenarioId": "desktop-electron-tauri-full-task-2-individual",
  "runtime": "tauri",
  "launchMode": "packaged",
  "challenge": "<fresh externally generated challenge, at least 16 characters>",
  "startedAt": "<ISO 8601 timestamp>",
  "finishedAt": "<ISO 8601 timestamp>",
  "nativeEvents": [
    { "kind": "packaged-launch", "atMs": 0, "pid": 4211 },
    { "kind": "dialog-cancel", "atMs": 1, "selection": null, "outcome": "cancelled" },
    { "kind": "dialog-select", "atMs": 2, "workspaceRoot": "/absolute/workspace" },
    { "kind": "allowed-read", "atMs": 3, "outcome": "allowed" },
    { "kind": "symlink-retarget", "atMs": 4 },
    { "kind": "escaped-read-denied", "atMs": 5, "outcome": "denied" },
    { "kind": "dialog-reopen", "atMs": 6 },
    { "kind": "app-quit", "atMs": 7, "pid": 4211 },
    { "kind": "packaged-relaunch", "atMs": 8, "pid": 4212 },
    { "kind": "state-restored", "atMs": 9, "pid": 4212, "workspaceRoot": "/absolute/workspace" },
    { "kind": "native-capture", "atMs": 10, "pid": 4212, "source": "os-compositor" }
  ],
  "package": {
    "executablePath": "/absolute/external/packaged-app-executable",
    "sha256": "<64-character lowercase SHA-256 hex>"
  },
  "capture": {
    "path": "/absolute/external/native-capture.png",
    "sha256": "<64-character lowercase SHA-256 hex>"
  }
}
```

All required native events must occur exactly once, in the shown order with
nondecreasing `atMs` timestamps. The launch and relaunch must identify distinct
process IDs; quit, restored state, and capture must refer to the appropriate
process. The restored root must match the selected root. Cancellation must have
a null selection, and the captured denial must report a denied outcome. The inspector rejects stale/mismatched
challenges, missing denial or restart evidence, changed artifacts, symlink
artifacts, paths inside `skills-v5/`, and non-executable package paths.

**Structural receipt validity is never native proof**: anyone could fabricate
the JSON and a picture. The inspector therefore returns one of
`classification: rejected` or `classification: structural-only`, always
with `nativeDeviceVerified: false`. Receipt inspection always exits 2
(including for structurally consistent inputs) so a CI pipeline cannot
accidentally treat an unverified receipt as successful device proof. Do not feed a structural-only result into
qualification or use it to record a promotion or a pass in the evaluation
ledger. Receipts are not cryptographic attestation.

## Requirements for a future actual native run

The external driver, separately reviewed and trusted, must build a
**packaged** Tauri v2 scenario fixture, then directly witness a host window,
real picker cancellation and folder selection, an allowed command, an escaped
read denied after symlink retarget, a dialog reopen, complete app exit and
relaunch, and restoration of persisted state. It must capture actual OS
compositor pixels and bind the executable identity, image digest, and fresh
challenge to that run. Inspect the generated `tauri.conf.json`,
`capabilities/default.json`, and Rust `generate_handler!` command list for
the exact exposed commands and window scopes before asserting least
privilege. Tests of native dialogs, WebView command permissions, OS
filesystem handles, state restoration, packaging, updates, and multiple
windows still require that independent native execution.

The built-in scenario runtime has its own challenge and driver interface;
this standalone receipt format does not claim compatibility with it. Adapt a
reviewed driver to both contracts explicitly rather than treating
`structural-only` as approval.

## Observed host snapshot (2026-10-10, Pacific)

- macOS arm64; `rustc 1.97.1` and `cargo 1.97.1` installed.
- Native `Koryphaios.app` executables exist in `/Applications` and in the
  user's Applications directory; they are **not the scenario fixture**.
- Repo declares `@tauri-apps/cli ^2.11.4`, but no installed local
  `node_modules/.bin/tauri`, `tauri` on `PATH`, or `cargo tauri` CLI
  was detected in the fork.
- `KORY_SKILL_EVAL_TAURI_CLI` and
  `KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER` were unset. No trusted driver was
  identified, so packaged-device proof was **unavailable**.

When a CLI and driver are available, rerun preflight before any native attempt.
It is deliberately possible for all offline tests to pass while the native
qualification remains blocked.
