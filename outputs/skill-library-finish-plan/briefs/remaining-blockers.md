# The 13 packages that are still not ready

Measured on this host at library revision 169 ready / 12 insufficient-evidence /
1 blocked / 2 unmeasured. Every statement below is an observation made here, not
an assumption carried over from an earlier note.

## What each package actually needs

Each package declares its own blocker in
`backend/src/kory/skill-eval-external-environment-boundaries.ts`. The blocker is
suppressed only when a real materializer and scorer register for the scenario, so
the blocker text is the contract, not a comment.

| Package | Environment kind | Blocker |
|---|---|---|
| computer-use | device | first-party desktop adapter, sacrificial targets, permission race |
| desktop-electron-tauri | device | Electron 42.9.0 binary, Tauri v2 native driver |
| embedded-firmware | repository | MCU brownout persistence and ISR overrun |
| embedded-interface | device | embedded display/input runtime |
| game-spatial-interface | device | VR/AR spatial runtime |
| gpu-compute | repository | CUDA kernel, memory, synchronisation, profiling |
| hardware-runtime-debugging | synthetic | faithful target/driver debugger behaviour |
| image-generation-practice | synthetic | actual generated images plus media evaluation |
| ios-swiftui | device | booted iPhone and iPad simulator |
| native-interface | device | representative native desktop and mobile runtimes |
| react-native-expo | device | React Native/Expo simulator runtime |
| robotics-control | repository | robot or faithful simulator runtime |
| simulation-device-testing | device | Zephyr/STM32 or PX4 HIL/SITL simulator |

## What the host does and does not have

| Tool | Present |
|---|---|
| Xcode | yes, 27.0 beta at `/Applications/Xcode-beta.app` (Command Line Tools alone is not enough) |
| iOS simulators | yes, iOS 27.0 runtime; iPhone 17 Pro and iPad Pro 13-inch (M5) already booted |
| `dotnet` | `/opt/homebrew/bin/dotnet` |
| `qemu-system-arm` | `/opt/homebrew/bin/qemu-system-arm` |
| `lldb` | `/usr/bin/lldb` |
| `arm-none-eabi-gcc` | absent |
| `gdb` | absent |
| `mujoco`, `pybullet`, `gazebo`, `nvidia-smi`, `adb`, `emulator` | absent |
| Electron 42.9.0 | absent |

With `DEVELOPER_DIR`, `KORY_IOS_EVAL_DEVELOPER_DIR`, `KORY_IOS_EVAL_IPHONE_UDID`
and `KORY_IOS_EVAL_IPAD_UDID` set to the booted devices, the iOS scenarios
themselves report `readinessBlockers: none`. The iOS *environment* is therefore
available on this host, contrary to an earlier note in this workstream.

## The real remaining constraint

The environment is not what stops these packages now. The executor is.

`applySkillEvalExecutorReadiness` in `scripts/skill-v5-qualification-executor.ts`
(rules at lines 309 to 322) refuses any executor whose mode ends in `text-patch`
for an environment kind outside `synthetic`, `repository` and `cli`, with the
message "cannot execute device environments". Every provider-backed executor
available here is a text-patch executor: logfare, openrouter and native stateless
are text-patch, opencode and local-llama are quarantined by name, and omnirush is
dead. The only executors that may touch a device scenario are the full CLI ones,
and codex is the only one of those that is installed. Its credential is dead
("refresh token already used", expired id token), and refreshing it is an
interactive login.

So the eight device packages plus `desktop-electron-tauri` are one executor away,
not one machine away. `ios-swiftui` is the clearest case: it has two passing
full-task runs, so `full-task` coverage reads 2, but those runs sit at older
contract hashes and every pair at the current hash failed both arms. The blind
review campaign correctly refused to grade a pair where both arms failed
(`availableAssignments: 0`), so the package stays at insufficient-evidence.

The four repository and synthetic packages have a different problem: no faithful
harness is registered for them, and the tools their own contracts name are absent.
`embedded-firmware` is explicit that host-only simulation cannot certify brownout
and ISR behaviour, so QEMU being installed does not help. `gpu-compute` needs a
CUDA-capable device, which this machine does not have. `image-generation-practice`
needs real generated media and a media evaluator. `robotics-control` is the only
one whose own contract allows a simulator, and no physics engine is installed.

## Session update: what the Koryphaios CLI executor and Logfare models changed

The subject for this round was the backend itself: `--executor=kory-cli-agentic`
drives `scripts/kory-cli.ts run`, which creates a chat in the running backend and
follows one agent turn to completion inside the pair directory, with
`--model=logfare/deepseek-v4.1-flash-1017`. A one-line smoke turn returned `OK`
in 6 s, so the route was verified before any full task was attempted.

`svelte-engineering` reached `ready` during this round with coverage
`{positive:5, negative:5, ambiguous:3, adversarial:3, full-task:2, regression:0}`,
one persisted blind review and no open regressions. The earlier inventory row that
called it blocked was a stale snapshot taken while another agent's rows were still
being written; the gate reads the ledger, not the CSV.

`desktop-electron-tauri` was measured against a real pinned runtime rather than a
declared one:

- `npm install electron@42.9.0` in a scratch directory produced
  `/tmp/electron-pin/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  which reports `v42.9.0`, and `KORY_SKILL_EVAL_ELECTRON_BINARY` pointed at that
  absolute path. Both desktop scenarios then passed the readiness probe
  (`readyScenarios: 2`, `environmentBlockedScenarios: 0`) with
  `KORY_SKILL_EVAL_TAURI_NATIVE_DRIVER=scripts/kory-tauri-native-driver.ts`.
- The package is still `blocked`, and the only reason is its two open regressions.
  A regression closes only through a newer passing run carrying that source id and
  a matching paired no-skill baseline, so the Electron binary alone cannot close it.
- Two distinct failures were observed and are not the same class. Some rounds ended
  as infrastructure failures, `The Kory backend produced no assistant message for
  this turn (terminal)` while the backend was restarting on this shared host; those
  are excluded rather than scored. Other rounds are scored candidate failures, and
  the Tauri arm failed inside the candidate's own manifest:
  `Real Tauri package build failed: thread '<unnamed>' panicked at
  crates/tauri-cli/src/interface/rust.rs:1166:14: called Option::unwrap() on a
  None value`. A candidate that breaks `Cargo.toml` fails its own build.
- One earlier Tauri run reached every native check (packaged bundle launched,
  1280x840 window-server capture, native folder sheet, cancel-is-none, selection,
  in-root read, symlink swap denied, unexposed commands, reopen, restart) and was
  still scored zero on `Native verification check inventory is incomplete or
  duplicated`. The receipt in that run is gone with its temporary directory, so
  that specific mismatch is recorded as unresolved rather than diagnosed.

The remaining six are unchanged in kind, and the reason each is unchanged was
re-measured instead of assumed:

| Package | What was tried here | Result |
|---|---|---|
| embedded-interface | Cortex-M4 device on `mps2-an386`, expecting a UART-fed encoder stream and a RAM panel read back by the harness | the SoC models neither a display controller nor a rotary-encoder line, and the CMSDK UART delivers nothing host to guest: with a socket chardev attached, a guest polling `STATE` at 1 kHz received 0 of 64 bytes, and every UART register read 0 at reset. No faithful device harness can be built on this machine |
| simulation-device-testing | same Cortex-M toolchain is available, but the scenario names Zephyr v4.4.0, Renode v1.16.1 and PX4 v1.16 fixtures | none of the three is installed, and a substitute target would not be the declared environment |
| native-interface | macOS AppKit and a booted iOS simulator are both present | no fixture exists for either arm yet; the desktop arm needs a real Cocoa app plus an accessibility driver, the mobile arm an XCUITest build |
| react-native-expo | readiness probe exists and checks Expo CLI, a booted simulator and adb | needs an Expo project, Metro, and touch injection on the simulator; not built |
| game-spatial-interface | nothing on this host models a VR/AR runtime | no headless spatial runtime exists to drive |
| gpu-compute | `nvidia-smi` and CUDA are absent | a CPU substitute is explicitly not equivalent per the scenario's own requirement text |

Nothing in this round weakened a check, moved a threshold or edited a fixture to
make a candidate pass. The Electron runtime is pinned at the exact version the
harness requires, installed rather than imitated, and the two packages that did
reach `ready` did so on evidence the gate itself re-derived.
