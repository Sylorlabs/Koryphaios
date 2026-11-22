# native-interface: a real AppKit runtime for the desktop operations task

## What was refused before

`native-interface` sat in `insufficient-evidence` with a registered environment
boundary: no faithful native harness existed for
`native-interface-full-task-desktop-operations` or
`native-interface-full-task-mobile-recovery`. The gate therefore had no full-task
scenario it could execute, and the package could not reach `ready` however good
the skill text was.

The original boundary was honest. A native desktop task is only measurable if
something renders a real window and reports what the toolkit actually did. A
transcript that says "focus moves to Retry" is a claim, not evidence.

## What was built

`backend/src/eval/skills/skill-eval-native-interface-runtime.ts` supplies a real
macOS/AppKit harness for the desktop arm:

- The evaluator owns `main.swift`, an AppKit application that creates a titled
  key window, installs an application menu, instantiates the candidate's
  `OperationsModel`, lays out one `NSView` per reported element, and captures the
  live window through `cacheDisplay(in:to:)` rather than a synthetic renderer.
- The window's actual `firstResponder` is read after the window is key and the
  responder chain has settled. The report names the responder's element id, or
  `content-view` when nothing was focused.
- Element frames come back as the geometry the window rendered, so a control that
  sits outside the content rect is measurably outside.
- The durable payload the model asks to persist is written to disk by the shell,
  and a second launch is run against that file. Restoration is therefore observed
  across two real processes, not asserted in prose.
- `build.sh` fails closed when the Xcode toolchain is absent, and
  `nativeInterfaceToolchain()` discovers `swiftc` and the SDK by absolute path.
  A PATH hit on CommandLineTools' `swiftc` cannot compile against the Xcode SDK on
  this host, and treating that compiler error as a candidate fault would be wrong.

The candidate owns `OperationsModel.swift` and `verification/desktop-result.json`.
`main.swift`, `build.sh` and `README.md` are immutable, and the scorer refuses a
workspace where any of the three changed.

## What is measured

Six checks, all read from the capture reports:

| Check | Measurement |
| --- | --- |
| `desktop-native-platform-contract` | A real build, an unchanged evaluator shell, no WebView in the candidate source, a live window titled `Kory Operations` with at least two menus, at least seven elements, a capture above 5 KB, and all ten required state ids present |
| `desktop-native-job-state` | Per state, the status text the window shows; at least eight distinct texts; cancel enabled while running and disabled after cancellation; start disabled in the disabled state |
| `desktop-native-input-focus` | The window's first responder in the error state is the retry control, and that control is enabled |
| `desktop-native-resize-scaling` | Every element inside the content rect at 900x700, 640x420 and 640x420 at text scale 1.35, with a reachable primary action and no overlap between it and the status line |
| `desktop-native-restoration-proof` | Three or more durable keys persisted by the first launch, and the second launch reporting a restored state |
| `verification artifact matches the window` | `verification/desktop-result.json` claims `verified`, `macos-appkit`, a state matrix identical to the measured one, three durable keys, and at least three excluded browser patterns |

The last check exists because the scenario asks for a verification contract, and a
contract that disagrees with the window it describes is worthless.

## The harness never appears on the host screen

The first version of the shell called `makeKeyAndOrderFront` and
`activate(ignoringOtherApps:)`, which takes over the host display and steals
keyboard focus from the user while an evaluation runs unattended. That is not
acceptable beside someone's own work, so the shell now sets the activation policy
to `.prohibited` and never orders the window front. The window object still exists,
so it keeps a real responder chain and renders its subviews through `cacheDisplay`
into an offscreen bitmap. Capture size and geometry are unchanged (25,016 bytes for
the reference, 22,955 for the starter), the first responder is still read from
`NSWindow.firstResponder`, and both the starter (1 of 7) and the reference (7 of 7)
score exactly as before. No evaluation in this repository should open a visible
window; a harness that needs one belongs in a VM.

## Discrimination, measured

The shipped starter is a plausible bad implementation: a footer placed at
`x = width - 40`, cancel always enabled, cancellation and disabled states that
print the running text, focus left on the content view, and `saveableState()`
returning an empty dictionary.

- Starter: 1 of 7 checks. `primary-action` sits at 860,640 inside a 900 px
  window and at 600,360 inside a 640 px window; `detail` at 760x200 overflows
  640x420; four state texts are wrong; first responder is the job list; nothing
  is persisted.
- Reference: 7 of 7. Every frame is inside the content rect at both sizes and at
  scale 1.35, the error state focuses retry, six durable keys survive a relaunch,
  and the state matrix in the artifact matches the window byte for byte.

Two harness defects were found by measurement and fixed rather than tolerated:
the cancel-enabled assertion originally read the error-state capture (where cancel
is legitimately disabled), and the narrow-size capture originally ran in a state
whose primary action is legitimately disabled, so a correct layout scored zero.
The narrow captures now run in the partial-results state, where starting a job is
legal.

## What is still gated, and why

The iOS arm, `native-interface-full-task-mobile-recovery`, stays a registered
environment boundary. It needs a booted simulator lifecycle run: background the
app, foreground it, deny a permission, and read the rendered state. The repository
already contains a real XCUITest harness for the `ios-swiftui` scenarios, so the
machinery exists, but a recovery-flow fixture with its own XCUITest suite has not
been authored and measured yet. Claiming the mobile arm works because the desktop
arm does would be exactly the fabrication this work refuses.

Because one of the two full-task scenarios is still blocked, the gate no longer
reports "every full-task scenario is a boundary": it now counts an executable
case. Two passing full-task runs of the desktop scenario are required, and this
brief records whether they were observed.

## Qualification attempts, recorded

The harness is registered and the macOS scenario is executable. The package moved
from `insufficient-evidence` to `blocked`, which is the honest state: the gate now
counts one executable full-task case and names what it still needs.

| Attempt | Budget | with-skill | without-skill | Outcome |
| --- | --- | --- | --- | --- |
| 1 | 180 s | timeout | n/a | Infrastructure, retryable |
| 2 | 600 s | timeout | n/a | Candidate built the window and swept 57 captures, never wrote the artifact; scored 3 of 7 including a shell edit |
| 3 | 1200 s | timeout | n/a | Infrastructure, retryable |
| 4 | 900 s | 1 of 7 | 5 of 7 | with-skill turn died terminally after exploring, no model edit |
| 5 | 1500 s | 5 of 7 | 2 of 7 | Discrimination observed; with-skill failed `desktop-native-job-state` on cancelled, disabled and recovered |
| 6 | 1500 s | 1 of 7 | 2 of 7 | After the 5.1.0 revision the candidate rewrote the immutable shell and produced code that does not compile |
| 7 to 9 | 1500 s | 1 of 7 | 1 of 7 | Provider terminal errors, then a turn that returned a written plan instead of edits |

Attempt 5 is the informative one. With the skill present the candidate fixed
focus, geometry, persistence and the verification artifact, and without it the
same model left the overflow, the unfocused error state and the empty
`saveableState()` in place. The remaining gap was the state matrix: the window
still printed "Running: cancellation requested" for a cancelled job and
"Job complete" for a recovered one. That is a skill gap, so the skill changed
(5.0.0 to 5.1.0) rather than the check.

After the revision the candidate rewrote `main.swift`, which the contract calls
evaluator owned, and the replacement did not compile. Two later attempts returned
plans instead of edits. The fixture refuses to score those as passes, which is the
behaviour this work wants; the consequence is that two passing full-task runs have
not yet been observed for revision 5.1.0.

## What the gate reports now

- Status: `blocked`.
- Pass rate 0.889, verification 0.911, quality 0.913.
- Coverage: 5 positive, 5 negative, 3 ambiguous, 3 adversarial, 1 full-task, 0 regression.
- Reasons: no provenanced blind review yet, fewer than two full-task candidate
  evaluations, fewer than two paired baselines, and one open regression from the
  failed full-task pair.

None of those is an environment objection any more. They are evidence the route
has not yet produced, and the harness can measure them the moment a with-skill turn
edits the model instead of the shell.

## Refusals kept

- The iOS arm stays gated. No recovery-flow fixture exists for it.
- The window is never shown on the host, and no visible-window substitute is used
  to claim a stronger observation than an offscreen toolkit capture supports.
- A turn that returns a plan instead of an edit is scored as an unchanged
  workspace, not as a pass.
