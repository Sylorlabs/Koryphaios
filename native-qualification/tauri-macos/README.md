# Packaged macOS Tauri qualification probe — partial evidence

This directory contains a **real, executable Tauri v2 arm64 fixture**
and packaged WebView-to-Rust IPC smoke test for
`desktop-electron-tauri-full-task-2-individual`. It does **not** contain a
trusted independent external native *scenario driver*, so it must never be
used to set `nativeDeviceVerified` or `scenarioQualified` true.

The fixture deliberately lives outside
`skills-v5/desktop-electron-tauri/evals/environment/tauri/`. None of the
scenario, scorer, ledger, or shared main checkout is modified.

## Reproduce the measured partial run

Requirements: macOS arm64, logged-in desktop able to launch the fixture,
Node 20+, npm, rustc/cargo, and macOS Command Line Tools. In this directory:

```sh
npm ci --ignore-scripts
CARGO_TARGET_DIR="$PWD/.build/target" npm run package:fixture
CARGO_TARGET_DIR="$PWD/.build/target" cargo test --locked --manifest-path fixture/src-tauri/Cargo.toml
npm run smoke:packaged
```

The package script invokes pinned `@tauri-apps/cli@2.11.4` and creates a
**packaged, ad hoc signed** `.app` under
`.build/target/debug/bundle/macos/`. Generated targets, vendored tools,
native build products, and Tauri generated schemas are ignored by Git.
The `package-lock.json` includes npm integrity fields. Rust dependencies
are locked via `Cargo.lock` (`tauri=2.12.3`,
`tauri-build=2.7.2`, `tauri-plugin-dialog=2.8.2`).
The app is a disposable test fixture, not a deployable product build.

`native-smoke.mjs` creates a fresh temporary filesystem outside the repo,
checks the Mach-O arm64 bundle executable and bundle identifier, launches
the packaged binary, checks its live process identity through `ps`, and
waits for events actually emitted by the Rust host command handlers after
calls from the packaged WKWebView. It quits each process before the next
launch, with different PIDs.

| Packaged process | State source | Rust IPC state and file observations |
| --- | --- | --- |
| Clean start | No saved selection | Root null; `marker.txt` and `linked.txt` denied |
| Restart | **Explicitly seeded** canonical workspace path | Root restored; marker and in-root symlink allowed |
| Third start | Same seeded state, symlink retargeted outside selected root **between launches** | Root restored; marker allowed; escaped symlink denied |

This demonstrates native packaged startup and WebView-to-Rust IPC,
filesystem denial, symlink retarget before a subsequent launch, and
revalidation of a seeded persisted path. It **does not** demonstrate:
clicking a native folder picker, typed cancellation, native folder
selection, retarget during one live process, a native window screenshot,
or restoration resulting from a real picker choice. The Rust
`canonicalize` then `read_to_string` approach is susceptible to hostile
concurrent rename races; production needs handle-relative file opens.

The partial JSON report is written only to its unique temporary `runDir`
as `partial-native-result.json`, explicitly marked
`nativeDeviceVerified: false` and `scenarioQualified: false`.
Do not submit it as a driver receipt. There is no attempt to satisfy or
spoof the native checkpoint protocol.

### Observed host evidence: October 10, 2026 PDT

- Successful arm64 ad hoc signed packaged `.app` build; bundle identifier
  `dev.koryphaios.v5.tauri.scenario2`.
- Packaged executable SHA-256:
  `857df3a962c33317dedea8e76df591beb5b40bac670257289da721f475f437a2`.
- Three distinct packaged application PIDs: `40488`, `40508`, `40525`;
  each wrote a Rust setup event, state query, and filesystem read outcomes.
  Host process match, required outcomes, app exit, and bundle identity
  were checked by the smoke supervisor; exit code 0.
- Local fixture: 1 Rust unit test passed. Existing harness: 7 Rust and 27
  Node tests passed. A readiness preflight with the pinned npm Tauri CLI
  confirmed CLI v2 but `nativeAttemptReady: false` because no external
  trusted scenario driver was supplied.
- The complete event evidence for this observed smoke is in the external
  temporary run directory:
  `/var/folders/kf/5y26484x0571_3cq5b2hfk3w0000gn/T/kory-tauri-packaged-smoke-bfvOsR`.
  This absolute location is host-specific and may be cleaned by macOS.

## Independent native driver options, with feasibility on this host

| Option | Can drive macOS Tauri? | Current constraint |
| --- | --- | --- |
| [WebdriverIO `@wdio/tauri-service`](https://tauri.app/develop/tests/webdriver/) embedded driver | Yes, for real WKWebView DOM/IPC through [`tauri-plugin-wdio-webdriver`](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup) | External package can be pinned in lockfiles, but an embedded HTTP server is **not** an independent macOS OS-window or folder-dialog witness. The attempted 1.5.0 integration never completed its tests (initial WebdriverIO 10 mismatch; pinned WebdriverIO 9 then `Tauri core.invoke not available after 5s timeout`). It is **not retained** as a working driver. |
| [Appium Mac2](https://appium.github.io/appium-mac2-driver/v4/getting-started/) | Yes, XCTest-based black-box macOS UI | Needs full Xcode 13+ and Xcode Helper Accessibility permission; this host has Command Line Tools but no Xcode.app. |
| [BlueM/cliclick](https://github.com/BlueM/cliclick) | Sends physical mouse/keyboard events; needs custom scenario orchestration | Built CLI 5.1 from upstream tag commit `d786bc5faf8830dd30584e731b166e504927dbad` in an **ignored** vendor directory; local arm64 binary SHA-256 `6718fe99095c61f239827593a5365a1e41601e6b46222b485f56251a3b2cf25f`. The CLI alone is not a reviewed scenario driver. macOS Accessibility was denied to `osascript` with OS error `-25211`. |
| [CrabNebula's driver](https://tauri.app/develop/tests/webdriver/) | Advertises a cross-platform driver with macOS support | Requires a separate paid macOS driver credential; none was provided or tested. |
| [Tauri's standalone `tauri-driver`](https://tauri.app/develop/tests/webdriver/) | Windows and Linux | Cannot drive macOS WKWebView directly. |

A GUI automation source addition was explicitly refused by automatic safety
review; it was not retried through an alternate tool. Other follow-on
WebDriver bridge work was also refused and not retried. No reviewed
external scenario driver was created or silently substituted.

## Remaining gates

The existing [native harness](../../skills-v5/desktop-electron-tauri/evals/environment/tauri/README.md)
requires a separately reviewed executable, an independently pinned SHA-256,
real native picker cancel/select/reopen, symlink retarget and denied IPC,
packaged process+window observations, compositor screenshots, quit/relaunch,
and restored state. The current host also needs Accessibility and Screen
Recording authorization for the harness's System Events/compositor witness.

Even a structurally accepted receipt only produces
`native-window-observed` with `nativeDeviceVerified: false`.
Full V5 qualification must be performed by the independent evaluator with
paired skill/no-skill runs and blind assessment. None of those gates was
attempted or marked passed by this worktree.
