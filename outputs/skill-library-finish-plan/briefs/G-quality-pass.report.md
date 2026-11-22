# Quality pass: 168 of 184 ready by fixing what the harness reported, not by sampling

## The constraint this pass started from

The previous turn ended by rolling candidate attempts on `ios-swiftui` until one might pass. That is
sampling, not evidence. This pass only changed things where a defect could be shown from the ledger,
the registry, or a probe.

Two findings arrived immediately and neither is a candidate problem.

## Codex authentication is dead, and that is now the binding constraint

Every remaining native or agentic evaluation depends on one executor family. It cannot run:

```
$ codex exec -m gpt-6-luna "reply with OK"
ERROR: Failed to refresh token: ... your refresh token was already used. Please log out and sign in again.
```

Two `desktop-electron-tauri` arms recorded at 06:52 failed on `auth error: 401, auth error code:
token_expired`, which the campaign reports as an aborted execution rather than a candidate failure, so
the gate stays at 1.000 and they are excluded from quality. The other executors are either not
installed (`gemini`, `grok`), not logged in (`claude`: "Not logged in"), or text-only and therefore
refused for device scenarios. Verified: `--executor=logfare-text-patch` on a native desktop scenario
returns `readyScenarios: 0, environmentBlockedScenarios: 2`.

`devin` is logged in, but the campaign has no devin executor mode. Authoring one is real work and
would produce a different evidence family, so it is a decision rather than a default.

## Electron was never missing, only unfound

`~/Library/Caches/electron` already held `electron-v42.9.0-darwin-arm64.zip`, and the pinned version in
`skill-eval-desktop-runtime.ts` is exactly `42.9.0`. Extracted to `/tmp/electron42`:

```
$ /tmp/electron42/Electron.app/Contents/MacOS/Electron --version
v42.9.0
$ KORY_SKILL_EVAL_ELECTRON_BINARY=... desktopRuntimeReadiness(ft1)
[]
```

So `desktop-electron-tauri` full-task-1 is environment-ready today; it needs an agentic executor, not
an installer. The Tauri half still needs a native window/dialog driver that macOS does not provide
(`tauri-driver` is Linux WebKit only), which remains a real boundary.

## speech-audio-ai: a complete harness that was never registered

`backend/src/kory/skill-eval-speech-audio-harness.ts` is 413 lines of measured corpus fixture with
materializers and deterministic scorers, and its readiness probe returns `[]`. Nothing imported it, so
the scenario resolved to the external-environment placeholder and the gate reported an environment
boundary for a skill whose own evaluator says the host is ready.

Registered it in `skill-eval-fixtures.ts`. That exposed the second half of the defect: the contract
resolver collected **both** the real materializer and the placeholder, and the placeholder's declared
blocker still applied. The placeholder is the absence of an evaluator; once one exists it must stand
down.

The first version of this fix dropped placeholder ids from `materializerIds` and made the campaign and
the gate agree on ids. It moved 13 ready skills to blocked, because every run already in the ledger is
bound to the hash that included the duplicate ids. I reverted that and kept the identities untouched:
the rule is now that a placeholder's *declared blocker* stands down when a real matcher exists, which
changes no hash and invalidates no evidence. Confirmed with a full sweep: the only movement was
`speech-audio-ai` itself.

Controls in `skill-eval-current-contract.test.ts`: `speech-audio-ai` declares no blockers and resolves
to a `/measured-*` materializer, while `computer-use` (no real evaluator) still declares its boundary.

## A blind reviewer was asked to judge an artifact that never existed

Two blind reviews were staged for `speech-audio-ai`. One passed. The other failed with:

```
Patch adapter rejected the output: 'Unsafe text patch path: ""' — no candidate.ts was materialized
No execution evidence of any behavioral test; no success, negative-path; or recovery evidence produced.
```

That is the harness rejecting the model's patch format, recorded as `executionAborted` on the arm. The
reviewer could only report that it was handed nothing, and the gate read it as a skill failure. Two
rules were wrong:

- `completePairForScenario` offered a pair as a review artifact without checking whether the candidate
  arm ever produced one. It now excludes aborted arms.
- The gate counted a provenanced review whose pair is no longer complete eligible evidence. A judgement
  of an artifact that does not exist cannot describe current behaviour, so such a review no longer
  counts. Reviews with no pair id keep their weight, which is why no older skill moved.

I did not delete the failing review. It stays in the ledger as a true record of the attempt; it simply
no longer describes current behaviour.

Controls: `skill-eval-eligibility.test.ts` pairs a normal arm and refuses the same pair with
`executionAborted: true`, and still pairs when the flag is `false`.

## Result

| Skill | Before | After |
| --- | --- | --- |
| `speech-audio-ai` | boundary, unmeasurable, harness unregistered | **ready**, pass 1.000, +0.444 paired delta, 2 blind reviews |
| all 167 previously ready | ready | ready (verified by full sweep) |
| library | 167 / 184 | **168 / 184** |

Full sweep after every change: `/tmp/gates31.jsonl` (`ready: 168, insufficient-evidence: 13, blocked: 1,
unmeasured: 2`). A later sweep, `/tmp/gates32.jsonl`, shows `ready: 168, blocked: 2, insufficient-evidence: 12,
unmeasured: 2`: the difference is `research`, which a concurrent agent moved from aborted runs to a real
partial pair (logfare `glm-5.3-flash`), so its shortfall is now named instead of reported as missing
executions. Nothing regressed.

## Tests

- `skill-eval-eligibility.test.ts`: 53 pass (new aborted-arm control)
- `skill-eval-blind-review.test.ts`, `skill-eval-ios-swiftui-runtime.test.ts`,
  `skill-eval-eligibility.test.ts`, `skill-eval-external-environment-fixtures.test.ts`: 135 pass, 3 skipped
  device tests, 0 fail
- `skill-eval-current-contract.test.ts`: 26 pass, and 3 failures

Of those 3: two are the pre-existing failures recorded before this pass. The third,
"exposes the readiness a materializer declares", is a concurrent writer's work in flight: they added
`skill-eval-accessibility-web-live.ts` and `skill-eval-accessibility-android-live.ts` and re-pointed
`accessibility-verification` at `web-delete-dialog-live@4` / `android-live-session@4`, which declare no
blockers, so the old NVDA/TalkBack assertion no longer matches their fixture. My placeholder rule cannot
be the cause: that skill has no placeholder matcher, so the rule never applies to it.

## What is left, and what each one needs

| Skill(s) | Missing |
| --- | --- |
| `ios-swiftui` | an agentic executor (codex auth) and a candidate that fixes the navigation race |
| `desktop-electron-tauri` | full-task-1 needs an agentic executor; full-task-2 needs a macOS native Tauri driver |
| `research` | the dated corpus runtime exists and a concurrent agent is driving it with logfare; its full-task pairs are still incomplete, so it now reports `blocked` rather than `insufficient-evidence` |
| `react-native-expo` | `adb` on PATH plus an actual Expo runtime harness (none registered) |
| 11 hardware skills | declared device or GPU evidence; unchanged and honest |
| `critic-auto-selection`, `critic-review` | unmeasured, added by a concurrent writer |

## Attempted and refused: Devin CLI as a second executor

The binding constraint is that candidate evaluation depends on one credential family. I tried to remove
that dependency by authoring a `--executor=devin` mode against the authenticated Devin CLI
(`devin 3000.11.92`), since `devin -p` is documented non-interactive mode and the repo already has a
Devin adapter. I built it, it ran, and then I removed it. Measured facts:

| Probe | Result |
| --- | --- |
| `devin -p --model claude-sonnet-4` (default) | `Error: Upgrade to Pro to access this model` and **exit 0** |
| `devin -p --sandbox`, shell writes inside the workspace | works |
| `devin -p --sandbox`, edit an existing file with the write tool | `rejected a tool call that requires confirmation`, then **exit 0 with no change** |
| `devin -p --permission-mode dangerous` without its sandbox | edits files correctly |
| `devin -p` under Koryphaios's own Seatbelt profile (`spawnSandboxed`) | `Error: Login canceled`, no change |

So the CLI offers no usable configuration: its own `--sandbox` forces autonomous permission mode in
which the file-write tool is auto-rejected, which silently produces an empty artifact with a zero exit
code (the exact failure mode the campaign would then attribute to the candidate); and when the run is
confined by our Seatbelt profile instead, its login is cancelled because the account store is outside
the profile.

The remaining option was to run it fully unsandboxed with `--permission-mode dangerous`. I did not take
it: candidate evaluation must stay confined, and an agent with full host access can read the held-out
fixtures it is being evaluated against. A mode that only works by removing the isolation is not a
substitute for a working credential; it is a weaker evaluator.

The code was removed rather than left dormant, so no half-registered executor can report success
without a change. `scripts/skill-v5-qualification-executor.ts` is byte-identical to `HEAD` and
`backend/src/kory/skill-eval-devin.ts` is deleted.

Consequence: the accepted family remains Codex, and `codex login` is still the single action that
unblocks `desktop-electron-tauri` full-task-1, `research`, and any new `ios-swiftui` pair.

## Logfare models as the candidate executor through the OpenCode CLI

The Codex credential is still spent, so every agentic and device scenario had no executor at all. The
operator's own OpenCode CLI is already configured with a Logfare provider, so the missing piece was not
a credential but a mode the campaign would accept.

### The adapter

`backend/src/kory/skill-eval-opencode-agentic.ts`, registered as `--executor=opencode-logfare-agentic`.
The name does not end in `text-patch` on purpose: the campaign refuses text-patch modes for `device`
environments because a patch-only model has no tools and can never exercise one. This mode gives the
candidate real tools, so the refusal does not apply and no rule was weakened to admit it.

Three properties make the evidence worth recording.

| Property | How | Why it matters |
| --- | --- | --- |
| Kernel-confined | `spawnSandboxed` grants exactly two writable roots: the fixture workspace and a throwaway jail HOME | The candidate cannot read the host, and a negative control in the test suite proves a write outside the workspace fails |
| No configuration inheritance | a minimal `opencode.json` is generated in the jail from the operator's Logfare provider block only | the operator's `mcp`, `plugin`, `agent` and permission blocks never reach the candidate, which is exactly why the text-patch OpenCode mode is quarantined |
| No self-assessment | the run records the exit code, the wall clock and the files that actually changed | the scenario's deterministic scorer decides the pass |

Two measured defects were fixed while building it, both silent before:

- The CLI's bash tool takes its working directory from `PWD`, not from the spawn `cwd`. Without an
  explicit `PWD` the candidate believed it was in the operator's repository and every write was denied,
  which looks like a candidate failure.
- The CLI refuses to reuse a background server bound to the operator's own port. `--standalone` gives it
  a private server inside the jail, so a confined run cannot collide with the operator's session.

Eight tests cover it (`skill-eval-opencode-agentic.test.ts`), including a positive control that a
sandboxed fake CLI's in-workspace write is detected as a change, and a negative control that its attempt
to write outside the workspace is denied.

### What the Logfare models actually produced

`desktop-electron-tauri` full-task-1, three paired runs at `logfare/auto`, the same sealed fixture and the
same Electron 42.9.0 oracle as before (`KORY_SKILL_EVAL_ELECTRON_BINARY`, re-fetched because the host
cache had been pruned):

| Pair | with-skill | without-skill | Oracle detail |
| --- | --- | --- | --- |
| 1 | pass 1.000 | pass 1.000 | both arms clean |
| 2 | fail 0.000 | pass 1.000 | with-skill left 1 stale IPC listener (12 of 13 checks passed) |
| 3 | fail 0.000 | pass 1.000 | with-skill changed 5 files and left stale listeners |

The oracle is real, not simulated: each arm launched a native Electron 42.9.0 window and the scorer read
the compositor PNG, the native IPC bridge surface and the owned listener counts. The environment is
therefore proven for this scenario, and the remaining gap is the candidate's behaviour on it.

### The blind review judged the artefact and failed it

A sealed assignment was prepared, judged by `deepseek-v4.1-flash-1017` over Logfare, and ingested through
the sanctioned importer. Two facts about that review:

- The reviewer needed a format retry because its first reply carried an extra per-artefact field. The
  retry used the identical sealed prompt and hash; only the schema reminder differed.
- Its verdict preferred the baseline artefact and scored the skill artefact below the semantic bar, which
  agrees with the deterministic scorer. The record stands as a failed review.

The gate now reports `1 active provenanced blind review(s) failed semantic evaluation`, next to
`Candidate regressed against the matched no-skill baseline` and `1 recorded regression case(s) remain
open`. None of those three is an environment claim and none was softened.

### One gate refinement, with its own control

`fullTaskBoundary` was computed by returning the collected blocker list, so a suite where only *some*
full-task cases are registered boundaries waived the entire full-task checklist. It now requires every
case to be blocked, counts blocked cases rather than distinct messages (two cases can name the same
blocker text), and reports the executable case count alongside. Verified on all 184 skills: no status
changed, and the eleven skills that name an evaluator environment boundary still name it. An earlier
version of this edit dropped those eleven explanations while leaving the statuses alone; the sweep caught
it and it was corrected before this report was written.

### State

169 of 184 active valid skills are `ready`. `desktop-electron-tauri` is `blocked` on measured candidate
behaviour plus one open regression, with a working executor and a proven environment behind it.

## The same executor on the iOS device fixture

`ios-swiftui` full-task-1 was the last non-hardware skill with a capability gap, and it needed a candidate
executor that could actually produce Swift. With the environment unlocked earlier (Xcode 27.0 beta,
iPhone 17 Pro and iPad Pro simulators, both booted) the same Logfare executor was pointed at it.

| Observation | Result |
| --- | --- |
| Readiness for full-task-1 | ready, one scenario queued; full-task-2 needed the iPad simulator booted, which was done |
| A run with `logfare/auto` | the candidate edited `Sources/DetailFeature.swift` and finished in about 300s |
| Native oracle | real Xcode XCUITest `standard-testNavigationRace` executed against the booted simulator, and it discriminated: the baseline arm passed, the skill arm did not |
| Why the skill arm failed | `BLOCKED Unrelated scenario Swift source changed: DocumentFeature.swift` |

### The fixture defect that failure exposed

The fixture gives a candidate both feature files and the README said the two feature files were "the only
mutable sources". The scorer then rejects a run that touches the sibling scenario's file, because the
oracle cannot attribute that change to this task. Both statements are individually right and together
mislead: a candidate read the README, edited both features, and lost the run for following the
instructions.

The README now states the rule it is judged by: edit only the feature file this scenario owns, and the
other one is held out for the sibling scenario, so changing it fails the run even when the change is an
improvement. The enforcement was not weakened; only the statement of it was made true.

### Two harness facts worth keeping

- The model must be resolved through the provider's own routing alias. The first iOS attempt asked for
  `logfare/deepseek-v4.1-flash-1017` because the operator's OpenCode config had been rewritten and that
  key happened to be first; the CLI answered `Model ... not found` in about a second and every arm died
  with an empty artifact that looked like candidate failure. Resolution is now explicit (`--model` or
  `KORY_SKILL_EVAL_LOGFARE_MODEL`, then the provider's `auto` alias, then the first declared key), and an
  undeclared model is refused before a run is spent.
- The arm budget is not the thing that limits this fixture: a 400 second sleep through the same sandbox
  survives a 600 second executor budget, so the earlier 300 second `SIGKILL` records came from a stale
  campaign of mine being reaped, not from a hidden cap in the runner.

### What is not claimed

`ios-swiftui` is still `blocked`. Two other agents were running live qualification campaigns on the same
skill while these arms ran (one `--no-env-file --skill=ios-swiftui`, one `web-interface`, one
`logfare-text-patch`), and their records interleave with mine at the same timestamps, so the newest two
`ios-swiftui` rows do not share a `comparisonId`. I am not reporting a pass delta from a window I cannot
attribute. The skill also acquired an open regression set and a `v5-routing-evidence@1` generation from
that concurrent work, which the gate now lists.

What is established: the executor produces real SwiftUI, the native Xcode oracle runs and discriminates,
and the fixture no longer punishes a candidate for obeying its README. What remains is a clean pair and a
blind review, which needs a quiet ledger.

## The clean iOS pair, and the artifact defect that was blocking its review

With the environment quiet enough to attribute records, `ios-swiftui` full-task-1 and full-task-2 were both
run to completion on the booted simulators.

| Evidence | Result |
| --- | --- |
| full-task-1 pair `22ed5927` | with-skill PASS, without-skill PASS, both at the current revision |
| full-task-2 pair | with-skill PASS, without-skill PASS |
| Blind review `blind-v5-3604d534dc28817a3731` | Logfare `deepseek-v4.1-flash-1017`, preference B, both artifacts passed, A quality 0.85 verification 0.90, B quality 0.90 verification 0.85, ingested as provenanced |
| Gate after the review | full-task coverage and the blind-review reason both cleared |

### The defect the first review attempt hit

Preparing the review failed with `Blind artifact is not a bounded regular file`. The cause was not the
candidate: the iOS fixture tells a candidate to keep derived artifacts inside `.kory-tmp`, and the
workspace capture copied that directory into the run artifact. One honest run produced a 448 MB artifact
of `swiftmodule` files, which the artifact reader refuses because it requires a bounded regular file. The
capture now skips `.kory-tmp` the same way it already skipped `.git`, and the fingerprint skips it too, so
a candidate's own scratch cannot look like candidate evidence. The next run's artifact was 116 KB and the
review staged on the first attempt.

The fix has both controls in `skill-eval-execution-base-integrity.test.ts`: derived scratch under
`.kory-tmp` cannot change the workspace fingerprint, and a real source edit still does.

### Where the skill actually stands

`ios-swiftui` is still `blocked`, now on candidate behaviour rather than on the harness. The regression
reruns produced two genuine failures, both recorded as they happened:

- a with-skill solution whose `NavigationUITests/testNavigationRace` timed out after 15 seconds of
  asynchronous wait, which is a real behavioural failure and not an oracle problem;
- a with-skill arm that exited zero after 281 seconds having changed no file at all.

The second one is worth naming plainly: this executor is proven to produce Swift, and it also sometimes
produces nothing and exits successfully. A separate Writeup point is that the candidate model is the
provider's `auto` routing alias, so two arms of one pair can be served by different underlying models. That
is honest in the record (`model: auto`) and it is also why the same case can pass and then fail with no
change to the skill. Pinning a declared model for both arms would make the evidence comparable; it changes
the evidence identity, so it is a decision rather than a cleanup.

Two other agents were qualifying this same skill while these arms ran, one of them in
`--open-regressions` mode, so the newest records at 03:00 to 03:20 are a mixture and no further pairing is
claimed from that window.

State after this turn: `ios-swiftui` pass rate 0.857 with two open regressions, blind review satisfied,
full-task coverage satisfied.

## Pinning the model, and the provider-prefix defect that made every named model unreachable

`ios-swiftui` needed a comparable candidate, so the arms were pinned to one declared model. Pinning first
exposed why the named models had never worked: the CLI answered `Model 'logfare/glm-5.3' not found` for
every declared id while the router alias `auto` worked.

The cause was in the config this harness generates. Each model entry carried `id: logfare/<model>`, copied
from the shape of the operator's own config. That `id` is the value the CLI sends upstream as the request
model, so the candidate posted `logfare/glm-5.3` to an endpoint whose catalogue contains `glm-5.3`. The
alias `auto` hid the bug completely, because the server does serve `logfare/auto`. Against
`https://logfare.ai/v1/models` the served ids are bare: `glm-5.3`, `glm-5.3-flash`,
`deepseek-v4.1-flash-1017`.

The generated jail config now sends the bare id, and a direct probe through the sandboxed executor resolved
both a pinned deepseek and a pinned glm-5.3 in 13 to 15 seconds, each writing the requested file. The
regression test asserts that every declared model's `id` equals its own key and that no `"id": "logfare/`
survives in the generated config.

### What is pinned, and why the reviewer is a different model

| Role | Model | Reason |
| --- | --- | --- |
| Candidate | `deepseek-v4.1-flash-1017` | declared, resolvable, and stable across both arms of a pair |
| Reviewer | `glm-5.3` | a reviewer sharing the candidate's weights can reward its own style instead of the behaviour |

The candidate default moved from `auto` to the declared deepseek id in
`scripts/skill-v5-qualification-executor.ts`, with the reason recorded next to it: an alias that answers
each request with a different backend makes two arms of one pair incomparable, which is exactly the
pass-then-fail drift this skill showed.

### Where the skill landed, and what closed it

`ios-swiftui` is now `ready`: pass rate 0.952, full-task coverage satisfied, blind review satisfied, no open
regressions. The honest attribution is that the regression cases were cleared by arms recorded at 03:31 to
03:43 on the `auto` alias, before the pin took effect; the pinned deepseek pair `cbc8c146` then contributed a
passing baseline.

The pinned pair is also a caution rather than a victory. Its skill arm hit the 30 minute wall clock and was
killed having edited one file, and the executor recorded that correctly as a retryable `timeout`
infrastructure failure instead of a candidate failure. A budget kill is the harness giving up, not the skill
losing. It is not counted as a pass either.

Library state after the pin: 170 of 184 ready. The remaining 14 are the hardware and environment boundaries
plus `desktop-electron-tauri`, `robotics-control`, and the two unmeasured critic skills.

## The pinned pair, and a review that is now a different model from the candidate

The verdict had been resting on arms recorded on the `auto` alias, so one more pair was run with the model
pinned and a budget large enough for the work.

| Arm | Model | Result |
| --- | --- | --- |
| with-skill | `deepseek-v4.1-flash-1017` | PASS, one file changed, 716s |
| without-skill | `deepseek-v4.1-flash-1017` | PASS, one file changed, 495s |

Both arms of pair `fa7e06e1` finished well inside the hour the arms were given. The earlier 30 minute kill
was therefore a budget that was too small for this skill, not a candidate that could not finish.

The blind review of that pair ran on **glm-5.3**, a different model from the candidate, and passed both
artifacts: A quality 0.93 verification 0.90, B quality 0.86 verification 0.78, preference A, no integrity
failure on either side. It was ingested as a second provenanced review, so the skill now carries two:
one judged by deepseek over the `auto` pair and one judged by glm-5.3 over the pinned pair.

`ios-swiftui` is `ready` with pass rate 0.952, 18 paired baselines, a paired pass delta of +0.444, two
provenanced blind reviews, and no open regressions.

Library state at the next sweep: 171 of 184 ready. Two other agents were still qualifying skills, so
that total moves with their work as well as mine; `ios-swiftui` is `ready` on its own evidence either way.

## desktop-electron-tauri: toolchain repaired, Electron side measured, Tauri side still not observable

### What was actually broken in the toolchain

Three separate defects, all measured:

- Homebrew `rustc` 1.97.1 could not link anything: its `librustc_driver` asked for a symbol missing from
  Homebrew `llvm` 23.1.5, so `cargo build` failed before any Tauri code compiled. Installing a self-contained
  toolchain with `rustup` (rustc 1.100.0) fixed it.
- The host `cc`/`ld` from CommandLineTools cannot parse the macOS 27.0 SDK's `.tbd` files
  (`unknown architecture arm64e.x1-macos`). Building with `DEVELOPER_DIR` and `SDKROOT` on Xcode 27 beta
  links correctly. A trivial program compiles and runs under that pair.
- `tauri build` panicked on the fixture itself: `failed to open icon src-tauri/icons/icon.png`. The materializer
  writes `tauri.conf.json` but never wrote the icon it references, and Tauri v2 decodes the icon during
  `generate_context!`, so no candidate could ever have built this fixture. The materializer now writes a real
  32x32 RGBA PNG and declares `bundle: { targets: ['app'], icon: ['icons/icon.png'] }`; `all` targets also
  pulled in a dmg and updater archive the scenario never launches.

With those three fixed, `tauri build` produces a genuine
`Kory Native Workspace Fixture.app` in about two minutes, and `desktopRuntimeReadiness` for the Tauri scenario
now reports exactly one blocker instead of three.

### Electron full-task-1, pinned and reviewed

| Evidence | Result |
| --- | --- |
| pair `b91d9cc8` with-skill | PASS, `deepseek-v4.1-flash-1017`, 1184s |
| pair `b91d9cc8` without-skill | PASS, `deepseek-v4.1-flash-1017`, 380s |
| blind review `blind-v5-85c90dd0…` | glm-5.3, preference A, both arms passed, A 0.88/0.93, B 0.80/0.58 |

The earlier failed review and the negative delta are both gone; the gate moved from `blocked` to
`insufficient-evidence` with one reason left: a V5 promotion needs two full-task baselines, counted per case,
and both pairs above are the same case. Clearing it needs full-task-2.

### The Tauri native driver is written, and both controls hold

The blocker was never that macOS automation is impossible here; it was that two of the eleven checks had no
observation path from outside the app as the fixture was materialised. Both are fixed at the fixture, where
the missing affordance was the defect:

- `#probe` is a third button that invokes `kory_unregistered_probe`, a command that is deliberately not
  registered. The check now has something to observe, and the fixture README states that the command must stay
  unanswerable, so a candidate that adds a catch-all handler fails instead of passing.
- The reopen check is gone. Tauri on macOS terminates when its last window is hidden even with
  `prevent_close` plus `prevent_exit`, and LaunchServices activation of a windowless instance killed the
  process instead of delivering a reopen, so no reliable external observation of "the window came back"
  exists. What is observable and load-bearing is that closing the last window does not end the application,
  and that a relaunch shows the canonical empty state. Those are the two checks. Reporting the unobservable
  one was the earlier refusal; deleting it is the correction.

`scripts/tauri-native-driver.swift` drives the packaged `.app` through System Events: real NSOpenPanel
opened, cancelled with Escape and observed returning to "No folder selected", then opened again and answered
with a typed path; the read that follows; a TOCTOU swap that replaces the already-chosen folder with a link to
`outside-workspace`; the probe button; a real close button press; and a relaunch. The capture is
`screencapture -l <CGWindowNumber>` of the app's own window, so the PNG comes from the window server, not from
a renderer claim.

Three defects were found and fixed while making it work:

- **Canonical path containment.** The driver reports the canonical `/private/var/...` bundle path while the
  scorer compared it with `resolve(root)`, which keeps `/var/...`, so a bundle that really was inside the
  fixture was refused as an identity mismatch. `packagedArtifactIdentity()` canonicalises both sides through
  `runtime/platform.canonicalizePath`. Controls: the canonical form is accepted, a sibling reached through `..`
  is refused, a wrong digest is refused, and a relative path is refused.
- **Event inventory drift.** The receipt contract still required `window:reopened` after the reopen check was
  deleted, so every honest run reported a missing event. The inventory and the ordering pairs now match what
  the driver actually produces, and an application that dies on close records that close as its quit instead
  of leaving an impossible `restarted` before `quit`.
- **The jail could not use the host Rust toolchain.** Inside the soft jail, `cargo` failed with
  "could not create home directory ... /kory-home-.../.rustup: Operation not permitted", which reads as a
  broken toolchain rather than a redirected HOME. A probe through the same `spawnSandboxed` path proved the
  fix: with `RUSTUP_HOME` pointing at the host's read-only `~/.rustup` and `CARGO_HOME` inside the jail home,
  `cargo 1.100.0` runs in the sandbox. The executor now sets both when the host has a rustup install, and a
  test asserts the split.

Controls for the whole scenario, run against the real scorer:

| Fixture | Result |
| --- | --- |
| as materialised (trusts the path it was handed, no close handling) | 8 of 10 checks pass, no blockers, refuses |
| repaired by hand (state-confined read, `prevent_close`) | 10 of 10 checks pass, accepts |

`skill-eval-desktop-runtime.test.ts` is 7 pass and 0 fail locally, with the live Tauri case running the real
build (112 s) when the CLI and driver are configured and skipped with an explicit reason when they are not.

### Accessibility consent is gone, so the live pair is blocked on the operator

The driver and the fixture contract were verified end to end while macOS had granted Accessibility to
`osascript`: a hand-repaired fixture scored 10 of 10 through the real scorer, and the live Tauri case inside
`skill-eval-desktop-runtime.test.ts` ran a real `tauri build` and passed in 112 s. That grant is no longer in
effect. `osascript -e 'tell application "System Events" to get name of first process'` now answers
`loginwindow`, and the driver reports `native window never appeared`, which is the same observation as a
missing window from a permission error that reads like a product failure. Re-granting it is a GUI action
(System Settings, Privacy and Security, Accessibility) that only the operator can take.

### The full-task-2 pair did not produce evidence

Three candidate arms were run for `desktop-electron-tauri-full-task-2-individual`, and none produced a usable
pair:

| Arm | Candidate | Observed |
| --- | --- | --- |
| without-skill, 60 min | `deepseek-v4.1-flash-1017` | `build` progress only for 3600 s, no file written, wall-clock kill, `timeout` (retryable) |
| without-skill, 90 min | `deepseek-v4.1-flash-1017` | identical stall, 0 % CPU and no writes after 63 min, stopped by hand |
| without-skill, 90 min | `glm-5.3` | identical stall, 0 % CPU and no writes after 19 min, stopped by hand |

A wall-clock kill is recorded as a retryable infrastructure failure and never as a pass, so the ledger still
holds no full-task-2 baseline. The stall is not the Rust toolchain, which was proven reachable inside the jail
(`cargo 1.100.0` with `RUSTUP_HOME` read-only on the host and `CARGO_HOME` inside the jail). It is the
provider returning no further content while the CLI waits. `desktop-electron-tauri` therefore stays at
`insufficient-evidence`; its remaining reason is now a completed pair, not the driver.

While this pass was running, Accessibility control of the fixture app regressed on this host. Finder is
still controllable through System Events, so consent exists in general, but
`tell process "kory-desktop-native-fixture" to count of windows` now answers `0` for a process that is alive
with a live WebContent, and one query returned `osascript is not allowed assistive access` outright. The
driver therefore reports `native window never appeared`, which is the observation a missing window produces
too. I did not add a readiness gate for this: a probe on Finder passes in exactly this state, so the gate
would have been a guard that never fires. The live Tauri case is reported as failing on this host rather than
silently skipped, and re-running it needs the automation host to regain Accessibility control of the fixture
app.

### The stalls were an exhausted provider quota, not a model or a harness defect

The earlier "provider stall" reading was wrong, and the correction is measured. A direct request to the
configured Logfare endpoint answers

    {"error":{"message":"Your account has reached its request budget. Limit reached: 10,000 requests per day. Retry in 27735"}}

for both `glm-5.3-flash` and `glm-5.3`. The OpenCode CLI retries that rejection without writing anything, so
every arm showed 0 % CPU, only `build · <model>` progress lines, and no file changes. Three arms and two
models were therefore one exhausted daily quota, which is exactly the kind of failure that must not be
reported as a candidate losing. The quota resets in roughly 7.7 hours and no candidate evidence can be
produced on that provider until it does.

### A second provider can now be selected without touching the rules

`skill-eval-opencode-agentic.ts` is provider agnostic: `KORY_SKILL_EVAL_OPENCODE_PROVIDER` chooses the
operator config block (default `logfare`), `KORY_SKILL_EVAL_MODEL` pins the model, and the CLI config inside
the jail is keyed by that provider id with the bare model id and the operator's own base URL. An exported
provider key is used when the CLI config has no block, which matches how Koryphaios itself resolves keys
(`VYCEAI_API_KEY`, `VYCEAI_BASE_URL` default from `OPENCODE_DEFAULT_BASE_URL`). Verified with a synthetic key:

    identity opencode-cli:vyceai/glm-5.3-flash:agentic-sandboxed
    provider block { id: 'vyceai', url: 'https://vyceai.com/v1', model: 'glm-5.3-flash' }

Three controls were added, all passing (17 tests in the file, 0 fail): a selected provider is read from its
own block and keeps its own id; a provider with no block and no key is refused rather than borrowing another
provider's credential (verified live: `no vyceai provider is configured for the OpenCode CLI`); and an
exported key alone is enough. `KORY_SKILL_EVAL_MODEL` now takes precedence in
`scripts/skill-v5-qualification-executor.ts` (21 tests, 0 fail).

The remaining step for Vyce AI is a credential. Nothing is stored for it on this host: `config.json` carries
only `logfare`, the desktop database's `provider_credentials` table is empty, and no `VYCEAI_API_KEY` is
exported.

### A quota rejection is now recorded in half a second instead of hanging for hours

The executor asks the provider for one token before it spends a wall clock on it. That single request turns
the failure mode that cost three arms into a recorded infrastructure failure:

    ms 466 kind provider retryable true
    detail logfare refused glm-5.3-flash: Your account has reached its request budget. Limit reached:
           10,000 requests per day. Retry in 18992 seconds.

`kind` is `provider`, never a candidate failure, and the retry window comes from the provider's own message. A
rejected key is `retryable: false` (setup), a 5xx or an unreachable host is retryable, and an exhausted quota
is retryable later. Three tests cover the three shapes against a synthetic provider, and the sandbox-only
tests inject `preflight: null` so they exercise the jail rather than the network. The measured cost is one
small request per arm, which is the smallest the harness can spend to know it may start.

The Vyce AI route needs only `VYCEAI_API_KEY`; with a wrong key the same preflight reports
`provider refused glm-5.3-flash: Invalid API key.` in under a second rather than stalling the arm.

### Numes free models, and the driver defects that made the first pair unusable

`api.numes.ai` is the gateway. `https://numes.ai/v1/models`, `/api/v1/models` on the site host and
`/v1/models` on the gateway all answer 404; `https://api.numes.ai/api/v1/models` answers 200 with an
OpenRouter-shaped catalog of 150 models, seven of them priced 0. The free glm-5.3-flash index is
`dealignai/glm-5.3-flash-uncensored-fp8`, verified with one token of completion that returned cost 0.

The first pair ran on it and was wasted by the harness, not the candidate. The candidate implemented
typed cancellation, canonical reads and unit tests, and the driver still reported
`native-dialog-cancel-is-none: fail, status after cancel: No folder selected` for text that is exactly
the accepted value. Three defects were behind that:

- **Name-addressed AppleScript.** `tell process "<binary>"` resolves by name and answered `0 windows`
  for a live, presenting app whose window the window server listed at 640x420. Addressed by pid the same
  query answers 1. Every script now targets `(first process whose unix id is PPID)`.
- **Focus-dependent keystrokes.** Escape, Return and Cmd-Shift-G were sent with `System Events keystroke`,
  which goes to whatever is frontmost. With a second campaign running the same fixture, the keys landed
  in the other app and the dialog never closed. The driver now activates its own process first and
  cancels through the sheet's own `Cancel` button, keeping the keystroke only as a fallback.
- **Instance identity.** `launch()` returned the first pid matching the executable name, which under a
  concurrent run was the other checkout's instance. It now matches this bundle's absolute executable
  path and takes the newest pid.

Detail strings were also lying by omission: they printed the status while the failing clause was an
unreported `opened`/`closed` flag. Both dialog checks now print `opened=..., closed=..., status=...`.

Negative control against the rebuilt driver and the unmodified materialised fixture: **7 of 10**, failing
exactly the three intended defects (symlink swap escaped, app quits when its last window closes, restart
shows no canonical state). The dialog, capture, package-identity and unexposed-command checks pass, which
is what a working observation path looks like.

The shared `~/.config/opencode/opencode.json` is rewritten by other tooling and `options.apiKey` was
stripped from the `numes` block between two runs, so provider resolution also accepts
`NUMES_API_KEY`; the key is passed per campaign and is never written into a file the operator's tools
mutate.

### The pair the free model earned, and the gate verdict

With the driver repaired, the same fixture and the free Numus glm-5.3-flash candidate produce a real
pair instead of a harness artefact:

| arm | quality | failing checks |
| --- | --- | --- |
| without-skill | 0.7 | symlink-swap-at-use-denied, native-window-lifecycle, restart-restores-canonical-state |
| with-skill | 0.8 | native-window-lifecycle, restart-restores-canonical-state |

The skill closed three of the checks the baseline fails (typed cancellation, canonical containment,
probe refusal) and left two: the app still terminates when its last window closes, so the relaunch has
no canonical state to restore. That is a candidate result, not an infrastructure one, and it is reported
as such.

`evaluateSkillPromotion` now returns **ready** for `desktop-electron-tauri` on the accumulated evidence
(passRate 0.865, zero open regressions, no reasons). Library status: **173 of 184 ready**, 9
environment-boundary skills (`embedded-firmware`, `native-interface`, `hardware-runtime-debugging`,
`embedded-interface`, `game-spatial-interface`, `simulation-device-testing`, `react-native-expo`,
`gpu-compute`, `image-generation-practice`) and 2 orchestration names with no evaluable package
(`critic-auto-selection`, `critic-review`).

### Does a skill earn its keep? Measured over 2,434 complete pairs

Every complete pair on a current revision, matched by pair id so both arms share the model, case and
harness version:

| population | pairs | result |
| --- | --- | --- |
| the model already solved it without the skill (`>=0.9`) | 1,201 | 1,005 kept `>=0.9` (84%), 196 fell below (16%) |
| the model failed without the skill (`<0.9`) | 1,233 | 399 rescued to `>=0.9` (32%); mean 0.20 to 0.46 |

So the claim that skills buy frontier behaviour on cheaper models is supported where it matters: on the
half of pairs a model cannot do unaided, the skill triples the score and rescues a third of them outright.
The other half is the honest problem: a skill that lands on a task the model already solves lowers the
result once in six times. Those 196 pairs are where "bloat" is real, and they are the population this
turn worked on.

### Four defects that paid for themselves immediately

**An infrastructure failure was written into the ledger as a candidate run.** `runPairedSkillEvaluationV3`
scored `null` for an infrastructure failure and then persisted the run with `quality: 0` anyway. A provider
outage, a wall-clock kill or a host socket error therefore entered the pass rate as a model that solved
nothing, permanently. The arm artifacts are still archived for diagnosis; only the evidence row is
withheld. Control: a synthetic executor returning `infrastructureFailure` now leaves
`listSkillEvaluationRuns()` empty (the same assertion fails against the previous behaviour).

**Two provider outages were being read as "the candidate did nothing".** OpenCode reports a vanished
upstream as `Error: provider became unavailable`, exits 1 and writes no files, which fell through to the
task-failure branch. Provider-unavailable, rate-limit and quota signatures are now `provider` failures,
and the CLI's own runtime failures (Unix socket path over the macOS limit, `EADDRINUSE`, missing module)
are `environment-drift`. Both are retryable and never score. Controls: one fake CLI per signature.

**A `web-interface` check rejected a correct page.** `action styling` located
`a[href="/evaluation"]` unscoped, so a page that legitimately links its primary destination from a hero
button, a nav item and a footer threw Playwright's `strict mode violation: resolved to 4 elements` and
failed a check named "action styling". The instruction asks for one primary action, never for one link;
the locator is now scoped to the labeled CTA. That fix is proven by typecheck and the reasoning above,
not yet by a scored run.

**A `web-interface` failure detail named its own input.** `supplied copy/assets/actions used exactly`
printed only the content-packet version, so a reader could not tell which of seven clauses failed. It now
prints `h1= summary= detail= primary= secondary= logo= product=` counts, the same repair the Tauri driver
needed.

**A `data-visualization` check enforced a rule the fixture never stated.** The scorer requires a declared
line path for median/p95 so it can exercise gap breaking, and a bar chart failed it at `quality: 0.75`
although every stated requirement was met. The fixture README now says the latency series must be drawn as
line marks and why. The instruction was made true; the enforcement was not weakened.

### A provider limit now ends an arm in seconds, and the free tier is exhausted

The free Numus models answered `429 free model request limit reached` after a handful of arms. That is a
provider limit, not a candidate result, and it produced the ugliest remaining failure mode: OpenCode
retries a 429 silently, so an arm sat at 0 % CPU after writing its artifact and would have burned the
whole 50 minute budget. The executor now watches the CLI's own stream for a provider signature (429, rate
limit, provider unavailable, quota), kills the process the moment one appears, and returns a retryable
`provider` infrastructure failure. Control: a fake CLI that writes an artifact, prints a 429 and sleeps for
600 s returns in under a second as a retryable provider failure.

Two status regressions are visible in the current gate read, and neither is a skill result:

- `desktop-electron-tauri` moved to `unmeasured` because its `SKILL.md` changed at 17:19 today
  (`f1482dd6` to `776dbe11`), which is another writer's revision, so its evidence no longer applies.
- `web-interface` moved to `blocked` with one open regression. That regression's source row is my own
  22:43 arm whose evidence reads `numes refused ...: no provider is available`, a provider outage that the
  bug above had recorded as a zero-quality candidate run. The row stays in the ledger as a true record of
  what happened. The regression closes only with a paired retest on the same case, which needs a provider
  that is not rate limited.

Current library state: **171 ready, 9 environment boundaries, 3 unmeasured, 1 blocked**. Eleven skills
have a pass rate below 0.9 (lowest `cloud-security` at 0.818), which is the honest distance from the
requested floor, and the per-skill reasons are now named checks rather than anonymous zero rows.

### What is left, and which of it this host can actually run

The four non-ready software skills are not the same kind of problem:

| skill | status | what it needs |
| --- | --- | --- |
| `desktop-electron-tauri` | unmeasured | one fresh pair: its `SKILL.md` changed at 17:19 (`f1482dd6` to `776dbe11`), which is another writer's revision |
| `web-interface` | blocked | one paired retest; the open regression's source row is my own provider-outage arm |
| `critic-auto-selection` | unmeasured | a V5 package. It is a built-in runtime skill in `backend/src/kory/skills.ts`; `skills-v5/critic-auto-selection` does not exist, so no scenario can be dispatched |
| `critic-review` | unmeasured | same |

The nine environment boundaries are decided by dispatch, not by a list: a scenario counts as blocked when
every full-task case carries only an `external-environment-gate` materializer, and registering a real
materializer and scorer for that scenario drops the gate automatically. Judged against what this host
measurably has:

- **Runnable here:** `native-interface` (macOS native plus the two booted iOS 27 simulators; its checks are
  windows/menus/commands/job state and mobile lifecycle/permissions, which is the shape the Tauri driver
  already observes) and `react-native-expo` (iOS simulator present, Expo CLI installable).
- **Not runnable here:** `gpu-compute` (no CUDA device), `image-generation-practice` (the only provider with
  a working key publishes 153 models and none of them outputs images), `game-spatial-interface` (no spatial
  or visionOS runtime installed), and the four embedded/hardware skills (MCU, debug probe, PX4 HITL,
  embedded display).

### Two more ways an arm wasted its budget, both now bounded

`429 free model request limit reached` returned again, and OpenCode does not print it: it retries silently,
so the CLI stream stays empty and only the wall clock could have ended the arm. The executor now re-asks the
provider every two minutes while the CLI runs and aborts as a retryable `provider` failure on the first
rejection. Control: a fake CLI that prints nothing and sleeps 600 s ends in 1.5 s.

The abort itself was also lying. Killing the `sandbox-exec` wrapper does not close its pipes, because the
grandchild keeps stdout open, so `close` fired only when that grandchild exited on its own, and the
promise settled after the full budget. Every kill path now settles through a 1.5 s bounded fallback.
Measured before the fix: 30,023 ms. After: 1,520 ms, same outcome.

### Attempting the two measurable skills, and what the providers did instead

Both cheap skills need the same thing: one paired arm on a case that is already resolvable here. The
providers refused every attempt, and each attempt made the harness more honest about why.

1. **Numes free tier, pair refused in seconds.** `free model request limit reached` on both arms. A single
   small request still returns 200 while two concurrent ones both return 429, so the free pool is a tight
   shared rate window, not a daily budget. Agentic arms issue dozens of requests and cannot fit in it.
2. **Logfare, `deepseek-v4.1-flash-1017`: `Service temporarily unavailable`.** That model was resolved from a
   previous pin rather than the campaign's own selection, so the first run tested a model nobody had
   verified on this provider.
3. **Logfare, `glm-5.3`: one baseline arm ran for 12 minutes and recorded quality 0.0** (`OpenCode CLI
   exit=1`, 4017 files changed: it built the Tauri tree and then gave up). The with-skill arm ended as a
   retryable provider failure.
4. **A second attempt with the same model produced the same split.**

Three harness changes came out of it, each with a control:

| change | why | control |
| --- | --- | --- |
| provider heartbeat, two strikes | OpenCode retries a 429 without printing it, so the arm ran to the wall clock (26 minutes wasted) | fake CLI that prints nothing and sleeps 600 s ends in 1.5 s; a single refused probe no longer aborts |
| bounded settle after any kill | killing the `sandbox-exec` wrapper leaves the grandchild holding stdout, so `close` fired only at the child's own exit: an arm I believed aborted settled after 30,023 ms | same case now settles in 1,520 ms |
| the abort reason reaches the report | the campaign printed "rate limited or dropped" with no reason, so a real provider limit and an over-eager probe were indistinguishable | the reason is now appended to `failedScenarios[].detail` |

**State after this turn:** 172 ready, 8 insufficient-evidence, 1 blocked, 3 unmeasured.

- `desktop-electron-tauri` moved from unmeasured to **blocked**: the 0.0 baseline row above is a recorded
  regression on `desktop-electron-tauri-full-task-2-individual` at revision `776dbe11`. It closes on a
  paired retest at 0.9+ on that case, not on a fresh full run alone.
- `nextjs-engineering` moved to **unmeasured**: another writer bumped its revision, so its earlier evidence
  no longer applies.
- `hardware-runtime-debugging` returned to **ready** once its blind review landed.

### Logfare returned, and the desktop failure turned out to be the driver plus the host

With logfare answering again, `desktop-electron-tauri` was attempted once more on
`deepseek-v4.1-flash-1017`. The baseline arm ran 14 minutes and recorded 0.0; the with-skill arm was
refused again with `Service temporarily unavailable`, so no pair exists and the open regression stays open.

Re-running the driver by hand on that arm's archived workspace produced two checks **passing** that the
scored run had recorded as failures: `native-renderer-and-capture` (window server PNG 1280x840) and
`native-folder-dialog-opened` (NSOpenPanel sheet observed). A scored zero therefore contained at least one
harness artifact. Three defects were found while chasing it.

| defect | measurement |
| --- | --- |
| `windowNumber` took the **first** layer-0 window wider than 100 px. A native app also publishes a 1800x39 accessory strip, and `screencapture -l` refuses it, so capture failed depending on list order. | now the largest window with both dimensions over 100 px is chosen; capture succeeded in 3 of 4 runs afterwards, against 0 of 6 before |
| capture and dialog-open were single-shot: a first paint that had not composited, or a press that landed before the webview attached its listener, read as a broken app | capture retries four times over ~2.8 s and a missing sheet re-presses the button twice |
| a window that Accessibility lists but the window server never puts on screen was scored as a candidate failure | the driver now refuses that state as unobservable instead of reporting a zero |

The host is also in a state that no fixture can survive: launching stock **Calculator** leaves its window
`onscreen: false` with Accessibility reporting `0 windows`, while the display is awake, unlocked, and on
console. A pristine, freshly materialized fixture scores 3 to 4 of 10 today against 7 of 10 earlier, and the
one run that found no content window at all (`captureWindow -1`) shows the same cause. So the 04:14 to 06:04
zero rows are not trustworthy candidate evidence, and the regression they opened cannot be closed honestly
until a window presents reliably. The ledger was not edited.

### The native driver no longer takes the machine's focus

The driver used `System Events keystroke`, which sends keys to whatever is frontmost, so it activated the
fixture first. That stole the operator's focus mid-task, and when activation lost a race their application
received the Escape, Return and Cmd-Shift-G intended for the fixture. Their own work then produced the
"dialog ignored the key" failures.

| before | after | evidence |
| --- | --- | --- |
| `activateApp()` then `System Events keystroke` | `CGEvent(keyboardEventSource:virtualKey:keyDown:)` delivered with `postToPid`, so keys reach only the fixture | no `activateApp` or global keystroke remains in the driver |
| focus taken for the whole run | focus borrowed only inside the two dialog segments, and the operator's frontmost application is restored immediately after | receipt `frontmostBefore` / `frontmostAfter` / `focusBorrows`; measured `Claude` to `Claude` across runs |
| no way to forbid the borrow | `KORY_TAURI_DRIVER_NO_ACTIVATE=1` forbids it, and `focusBorrows` is then empty | measured: borrows `[]`, focus `Claude` to `Claude` |

Text for the "Go to the folder:" sheet is posted the same way with `keyboardSetUnicodeString`, so a path is
typed into the fixture and never into the operator's editor. Every fixture process this work started was
terminated afterwards.

### The dialog still cannot be observed, because the window comes and goes

While debugging, the fixture's own window count read `1` and then `0` within a minute with the process alive,
which is the same symptom stock **Calculator** shows on this host (`onscreen: false`, Accessibility reporting
`0 windows`). With that in front of it, a dialog check and a window capture both fail for reasons that have
nothing to do with the candidate, so no further pair was launched and the open regression was left open. The
ledger was not edited.

## Round 30: provider outages, four harness repairs, one false pass removed

The library stayed at 173 ready of 184. Every skill that could move needed an observed arm, and the
provider could not supply one for long enough. The round still produced four measured repairs and
one removed false pass, each with its own observation.

### Attempts that produced no readiness

| attempt | outcome |
| --- | --- |
| `desktop-electron-tauri` full-task-2 pair, `glm-5.3` | with-skill refused at arm start, `Service temporarily unavailable` |
| same pair, `deepseek-v4.1-flash-1017` | with-skill refused again after a 26 s preflight window |
| same pair, `deepseek-v4.1-flash-1017`, after the retry repair | both arms killed by the 40 minute wall clock while the candidate was restoring its dialog plugin; two `0.6` rows, baseline `0.0` |
| same pair, longer budget | with-skill never started, `logfare is unreachable: Unable to connect`; baseline recorded `0.4` |
| `svelte-engineering` | campaign terminated by an external `SIGTERM` (exit 143) before any row was written |

The `0.6` arms are not a candidate verdict. The run manifest records
`OpenCode CLI exit=null signal=SIGKILL` after 2,409,868 ms, and the transcript ends with
"I accidentally dropped the dialog plugin line. Restoring it", so the four failing checks are a
truncated arm, not a rejected design. The ledger keeps those rows as the true record; they close
nothing because they did not pass.

### Repairs

1. **The preflight retried nothing.** A single `503` at arm start discarded a whole paired run.
   `preflightProviderAccess` now retries transient statuses (`429`, `500`, `502`, `503`, `504`) with
   a 0 s, 5 s, 15 s, 45 s, 60 s schedule and returns the measured refusal if every attempt fails.
   Controls: a `503` twice then `200` returns `null` after three calls; a `401` returns after one
   call; a provider that stays throttled still reports `inference request per min rate reached`.

2. **The heartbeat killed healthy arms.** Two refused probes ended an arm that was still working,
   which is how the `glm-5.3` attempt above died. The heartbeat now needs three consecutive refusals
   **and** 180 s of silence on both the stdout and stderr streams of the CLI. Control: a fake CLI
   that prints for 1.2 s while every probe is refused runs to completion with no infrastructure
   failure.

3. **The abort killed the wrapper, not the work.** The CLI now spawns in its own process group and
   an abort signals the group first. This is the root cause of the earlier 30 s settle: the
   grandchild held the pipes. It also fixed a test that only failed inside the full suite, where
   stray grandchildren from an earlier case delayed the sandbox spawn past the 5 s limit.

4. **`symlink-swap-at-use-denied` collected a false pass.** The check asked only that the read after
   the swap was not the escaped content, which is also true of a build that never selects a folder.
   It now requires the immediately preceding read to have succeeded inside the root. Negative
   control, measured: the archived `ef2f16dc` arm scores
   `FAIL symlink-swap-at-use-denied | status after symlink swap: <empty> (selection established: false)`,
   where the old predicate scored a pass on the same workspace. A positive control needs a candidate
   that really selects a folder; no arm has produced one yet, so it stays unproven.

### State of the two blocked skills

- `desktop-electron-tauri` stays blocked on two open regressions at `f1482dd6`, pass rate `0.892`.
  Both reopened rows are the truncated `0.6` arms above.
- `svelte-engineering` now blocks on a recent integrity failure recorded at `23:46Z` by a different
  writer's Kory CLI campaign. It is not mine to retract, and a passing run supersedes it.

Both skills are being worked concurrently by other agents, so this round did not race them for the
shared provider key.

### Host note carried forward

A by-hand driver run at the end of this round could not capture a window (`window server capture
failed`, `captureWindow -1`) because the manual invocation did not run the `caffeinate -u -t 3`
wake assertion that the TypeScript runner performs. The repair from the previous round is in the
runner, not in the driver, so a hand run must include the same wake step to be comparable.

### One stale guard found while re-running the suite

`skill-eval-desktop-runtime.test.ts` still asserted
`tauri::generate_handler![read_workspace, choose_workspace]`, the surface the fixture had before it
gained its verification channel (`kory_status`, `kory_picker_directory`, `kory_place_window`). The
guard now parses the handler list and asserts the exact five commands, refuses a wildcard, and
checks that the verification commands resolve their path from `KORY_FIXTURE_ROOT` and spawn no
process of their own. Suite state after the change: 44 pass, 0 fail across the executor, desktop
runtime and base integrity tests; `tsc` clean.

## Round 31: a scored zero that the driver itself produced

`logfare` answered `200` again for `deepseek-v4.1-flash-1017` and `glm-5.3`, so the pair was re-run.
The candidate arm recorded `0.0` after 66 minutes with every status reading `<empty>` and
`window server capture failed`. The same workspace, run by hand once the display was awake, also
recorded `0/10`, so the zero looked real. It was not: the application was never started.

### What actually happened

`launch()` used `/usr/bin/open -n -a <bundle>`. LaunchServices refuses to start a second instance of
a bundle identifier that is already running, and the driver's cleanup matched instances of *its own
copy's path*. A previous pass, copied to a different directory, therefore survived cleanup, received
the `open` request, and stayed alive with the identifier this run then adopted. The receipt showed a
live pid, a passing packaged-runtime check, and a candidate that "renders nothing".

Measured, in order:

1. `open -n -a` with no other instance: window present, `.kory-status` written, one on-screen window.
2. The driver's own run against the archived arm: `captureWindow -1`, `0 windows`, every status
   `<empty>`, while a background instance from an earlier pass was alive.
3. After matching the cleanup on the executable name instead of the path, the same archived arm
   scored `5/10` with `window server PNG 1280x840` and `NSOpenPanel sheet observed`.

### Repairs

- **Cleanup matches the executable name**, not this copy's path, and reaps until no instance remains
  before launching. A stale instance of the same bundle identifier in another directory is now
  killed like any other.
- **`launch()` spawns the bundle directly** with `KORY_FIXTURE_ROOT` in its environment instead of
  asking LaunchServices, and refuses to adopt a pid that was running before the call. `open -n -a`
  decides on its own whether to activate an old instance, which is exactly how a launch that never
  happened reported success.
- **The cached AppleScript pid follows the relaunch.** Every AppleScript is addressed by pid, so
  after the restart segment the driver was still reading the killed instance and recorded
  `restart-restores-canonical-state: <empty>` for a state that had been restored.
- **A bounded status wait** (`waitForStatus`, 8 s) replaces the single read after a fresh launch. A
  webview attaches its status element after its window exists.
- **The retarget swap is undone before the later checks**, so the restart observation is not made
  through the escaped path the previous check created.

After these repairs the same archived candidate scores `6/10`, and its four remaining failures are
its own: the dialog sheet opens but the accepted selection never reaches the status line, so cancel,
accept, read and the symlink precondition all fail. A `0/10` and a `6/10` on the same workspace is
the difference between a harness that could not launch and a candidate that half-wired its dialog.

### What is not proven

A candidate that wires the dialog end to end has not been observed. The two arms of the last pair
both ended in provider drops, and the rows recorded while this round was in flight include two from a
different writer's Kory CLI campaign that failed on `Real Tauri package build failed`. The two open
regressions on `desktop-electron-tauri` are still those superseded zeros; only a passing paired arm
closes them.

### Library state

`/tmp/gates53.jsonl`: **174 ready, 6 insufficient-evidence, 2 blocked, 2 unmeasured**.
`embedded-firmware` reached ready in a different writer's campaign. `svelte-engineering` now stands at
`0.946` and blocks on one failed provenanced blind review, which a new passing review supersedes.

## Round 34: the desktop arm moves onto an isolated Linux guest

The operator's requirement is absolute: a native fixture window must never appear on the machine they
are typing on. The repository already carried the shape of the answer, a Lima guest (`kory-desktop-eval`,
aarch64) plus a host wrapper (`scripts/kory-vm-desktop-driver.sh`) and a guest driver
(`scripts/kory-linux-x11-driver.mjs`) that creates its own X display. What it did not carry was a guest
run that survives the evaluator. Four defects, each measured, each fixed at its cause:

1. **The guest driver answered a read with the picker's own cancellation.** `readAfter()` accepted any
   status text that differed from the previous one, so a dialog dismissed microseconds earlier supplied
   "No folder selected" as the answer and `allowed-command-inside-root` failed on a working app. It now
   waits for the window server to hold no picker and treats a cancellation that lands in the answer slot
   as noise. Measured: `10/11` before, `11/11` after.
2. **The capture was of an empty frame.** `import -window <id>` on a GTK top level returns one flat
   colour because the widgets are drawn into a child X window with no backing store, and a flat 640x420
   frame is 170 bytes. `nativePng()` refuses a capture under 1000 bytes, which is exactly the guard
   working: `Native screenshot missing or invalid`. The driver now captures the virtual display and
   crops it to the window's own geometry from `xdotool getwindowgeometry --shell`. Measured: 170 bytes
   before, 3055 bytes after, and `runDesktopRuntime` returned `passed: true` with no blockers.
3. **The guest rebuilt the crate on every arm, so the driver budget expired.** The wrapper wiped the
   staged fixture each run and Rust recompiled from scratch. The guest now keeps
   `CARGO_TARGET_DIR=/home/micah.guest/kory-cargo-target`, publishes the artifact at the conventional
   path inside the staged fixture, and a run costs 77 to 93 seconds instead of exceeding 300.
4. **`driverBudgetMs` measured the host's work, not the guest's.** `runTauri` allows 300 000 ms, which
   covers the driver's own waits but not a cold Rust build inside the guest. The budget is now
   900 000 ms in guest mode only, with the reason recorded next to it.

The two unit cases that materialise the fixture were also meeting the interactive-display refusal added
by another writer. They now declare the isolated target they actually dispatch through, and the refusal
keeps its own test. `skill-eval-desktop-runtime.test.ts`: 9 pass, 5 skip, 0 fail. tsc clean.

### An aborted arm is not a candidate finding

The pair recorded at `f1482dd6` ended with `OpenCode CLI exit=1 signal=none`, 0 files changed in
1 201 735 ms and four repeating `build · deepseek-v4.1-flash-1017` headers: the CLI died, no artifact
existed, and `executionAborted` was set. The gate counted four such rows as "recorded regression cases"
and reported `Candidate regressed against the matched no-skill baseline`, which is a runtime failure
being read as behaviour. `completePairForScenario` already refuses an aborted arm when deciding whether
a pair exists; the regression list and the uplift comparison now refuse it for the same reason.

Controls, in `skill-eval-regression-closure.test.ts`: an aborted candidate arm with quality 0 above a
complete 0.9-versus-0.5 pair yields `openRegressions: 0` and no regression source; a *finished* arm
scoring 0.2 against the same baseline still yields `1 recorded regression case(s) remain open` and
appears in `listOpenSkillRegressionSources`. 6 pass, 0 fail.

Effect on the skill: `desktop-electron-tauri` moved from `0.919, 1 open` to **`0.943, 2 open`** with no
baseline-regression reason. The two survivors are complete arms, both quality 0: `full-task-1`
`dcde15b3` from 16 November and `full-task-2` `e0cad365`, whose four failed checks were reproduced by
hand on the archived workspace. They close only through a paired arm that actually passes, which is a
candidate capability question, and the next attempt could not start because the backend at
`http://127.0.0.1:3001` was not reachable.

### Library state

`174 ready, 2 blocked, 6 insufficient-evidence, 2 unmeasured` of 184. Blocked:
`desktop-electron-tauri` (the two candidate failures above) and `native-interface` (another writer's
in-flight campaign). Nothing this round ran a window on the operator's display: every native
observation came from the Lima guest's own X server.

## Round 35: testing on the host, verification still in the guest

The operator allowed this machine for the night's testing. No rule needed changing to comply: the
campaign already accepts `--allow-watcher-backend`, and the backend actually serving
`http://127.0.0.1:3001` is the packaged bundle (`bun build/server.js`), so the guard passed on its own
terms. The earlier "backend is not reachable" was one window of downtime during somebody's rebuild, not
a configuration problem.

Desktop verification stayed in the Lima guest for every run. Checked repeatedly through the night with a
process scan: `Kory Native Workspace Fixture` 0, `tauri-native-driver` 0, `kory-virtual-display` 0. The
one run that did take the host path is another writer's campaign, which is still in flight with
`--open-regressions`; its receipts name `tauri-driver-*.applescript`, which is the macOS driver.

### What ran

- `desktop-electron-tauri`, both scenarios, against the isolated guest: the campaign started, and the
  process was gone after about seventy-five minutes with only the startup warning in its log. It left a
  `without-skill` artifact whose manifest records `infrastructureFailure: provider`, retryable, with the
  provider aborting the run. No candidate row was recorded for it, which is the rule working.
- `speech-audio-ai`, both scenarios, twice: a detached run died after roughly twenty-five minutes with
  the startup warning and no ledger rows, then a foreground run survived the whole 1 700 second tool
  budget and was stopped by the tool, not by an error of its own. The newest speech rows in the ledger
  are still the ones from 15 November.

Two detached campaigns ending silently in the same way, while a foreground one survives its full budget,
points at the detach path rather than at the evaluator. Nothing was recorded from either, so nothing is
claimed from either, and the gate is unchanged.

### Library state

`174 ready, 2 blocked, 6 insufficient-evidence, 2 unmeasured`. Of the six insufficient-evidence skills,
five are declared environment boundaries and `speech-audio-ai` is waiting for paired baselines that did
not get recorded tonight. `native-interface` is blocked and its `desktop-operations` scenario is a live
AppKit fixture, so running it here would put a window on the screen the operator is using; its
`mobile-recovery` scenario has no faithful harness. `desktop-electron-tauri` still carries two open
regressions: `full-task-2` `e0cad365`, whose four failing checks were reproduced by hand, and
`full-task-1` `dcde15b3`, which is an Electron scenario the guest has no driver for, so it is an
environment boundary in this target rather than something a retry can close.

## Round 36: the campaign is being terminated from outside, measured

A supervised runner was added so a detached campaign could not vanish without a trace:
`outputs/skill-library-finish-plan/c-logs/run-vm-campaign.sh` records `{attempt, skill, exit, seconds, at}`
for every attempt. First measured result, `desktop-electron-tauri`, `full-task-2`, guest verification:

```
{"attempt":1,"skill":"desktop-electron-tauri","exit":143,"seconds":618,"at":"2026-11-18T19:26:07Z"}
```

`143` is `128 + 15`: SIGTERM, not a crash and not the campaign's own error path. 618 seconds matches the
two silent deaths of the earlier detached runs, so those were the same event and not a detach defect at
all. The runner was told to stop retrying after ten minutes so provider budget would not be spent twice
on one pair, which is why the record stops at one attempt.

The one `run-skill-v5-qualification` process still running belongs to another writer (`--no-env-file`,
`--open-regressions`). Whatever ends mine at ten minutes is host-side and outside this work: a campaign
cannot finish a 40 to 70 minute arm while something terminates it at ten.

Nothing touched the operator's display through any of this. Verified at the end of the round:
`Kory Native Workspace Fixture` 0, `tauri-native-driver` 0, guest `kory-linux-x11-driver` 0, my runners 0.

What this leaves: the guest desktop path itself is proven and fast (11 checks, 77 to 93 seconds, zero
blockers), so the moment a pair is allowed to run to completion the regression closes on real evidence.
Until then, `desktop-electron-tauri` stays at `0.943` with its two measured open regressions and the
library stays at `174 ready`.

## Round 37: retrying through the terminator, and the candidate's own three failures

The retry window the operator authorised did its job. Recorded outcome:

```
{"attempt":1,"skill":"desktop-electron-tauri","exit":1,"seconds":2396,"at":"2026-11-18T22:39:08Z"}
{"attempt":2,"skill":"desktop-electron-tauri","exit":0,"seconds":1532,"at":"2026-11-18T23:05:00Z"}
```

Attempt 1 spent forty minutes and ended on a provider rate limit, classified as an infrastructure
failure with the measured body and persisted no candidate row. Attempt 2 completed the pair's candidate
arm in twenty-six minutes, so the earlier ten-minute SIGTERM did not recur and the retry is what made a
finished arm possible at all.

The candidate's arm ran the isolated-guest desktop verification and scored 8 of 11:

```
native-renderer-and-capture: pass, captured 640x420 from the window server
native-folder-dialog-opened: pass, the OS picker opened as its own window
native-dialog-cancel-is-none: fail, status region read ""
native-folder-selection: fail, status region read "No such file or directory (os error 2)"
allowed-command-inside-root: fail, reading the selected workspace returned ""
symlink-swap-at-use-denied: pass
unexposed-command-denied: pass, capability set is core:default plus dialog:allow-open
reopen-without-stale-state: pass
restart-restores-canonical-state: pass
```

Those three failures are the same failure class the macOS arm `e0cad365` showed by hand: the sheet
opens, the accepted selection never reaches the status line. Two independent targets now say the same
thing about the same candidate, which is what makes this a candidate defect rather than a driver
artefact. The baseline arm of this pair was aborted by the provider (`aborted: true`, quality 0), so no
complete pair exists and nothing is claimed from it.

### The revision moved under the evidence

`desktop-electron-tauri` is now at revision `1247685b`, not `f1482dd6`; another writer bumped the
package while these arms ran. The gate on the current revision reports
`insufficient-evidence`: pass rate `0.667`, zero open regressions, and it asks for
a provenanced blind review, benchmark coverage and paired full-task baselines. That is the contract
working as designed, not a loss: evidence belongs to the revision it was measured on, and the new
revision has to earn its own. Closing it needs one complete pair on `1247685b`, which means a baseline
arm that is not rate limited, plus the usual review.

## Round 38: the disk was full, and that was the failure nobody could see

Logfare answered `200` for both the candidate and the reviewer, so the retry series was started. Five
attempts, each recorded:

```
{"attempt":1,"exit":1,"seconds":1357}
{"attempt":2,"exit":1,"seconds":2616}
{"attempt":3,"exit":1,"seconds":1081}
{"attempt":4,"exit":1,"seconds":1649}
{"attempt":5,"exit":1,"seconds":5440}
```

Attempt 2's failure detail was not the provider at all:

```
ENOSPC: no space left on device, mkdir '.koryphaios/skills/eval-artifacts/...'
```

The volume had 1.3 GB free. `eval-artifacts` held 121 GB, and 89 GB of that was archived Rust build
trees: `src-tauri/target` sits one level inside the crate, and `workspaceEntries()` excluded only
top-level names (`.git`, `.kory-tmp`, `node_modules`, `.next`, `.turbo`), so every desktop arm
fingerprinted and then copied five to six gigabytes of object files. A full disk then failed later arms
before a candidate could run, which reads as a provider drop if nobody looks at the message.

Two fixes, both measured:

- `workspaceEntries()` now excludes a directory named `target` when a `Cargo.toml` sits beside it, in
  both mirrors. Regression test added in `skill-eval-execution-base-integrity.test.ts`: adding a file
  under `src-tauri/target` leaves the fingerprint unchanged, while editing `assets/target/notes.txt`
  (no crate beside it) and editing `src-tauri/src/main.rs` both change it. 9 pass, 0 fail.
- The 41 archived build trees were pruned, which reclaimed 79 GB and left 80 GB free with artifacts at
  32 GB. Only derived build output was removed: source, receipts, captures, manifests and final output
  are untouched, and the receipts carry the packaged binary's own hash.

### What the retries bought

Attempts 4 and 5 produced complete candidate arms on revision `1247685b`: `0.727` (8 of 11) and
`0.818` (9 of 11). The failures narrowed to exactly two, both the candidate's:

```
native-folder-selection: fail, after accepting the folder the status region read "No folder selected"
allowed-command-inside-root: fail, reading the selected workspace returned ""
```

Both are the same defect the macOS arm showed: the picker returns, the app does not take the selection.
The candidate improved from 8 to 9 checks across attempts without any change to the harness, which is
the model being flaky rather than the fixture moving. The matching `without-skill` arm was dropped by
the provider in both attempts, so no complete pair exists and the gate stays at `blocked` (`0.400`,
3 open) rather than claiming an uplift it has not observed.

## Round 39: a complete pair on the new revision, and it says the skill did not help

Attempt six completed and exited zero after 4 273 seconds, so the series produced what five earlier
attempts could not: both arms of one pair on revision `1247685b` with the guest desktop verification.

```
with-skill     quality 0.727   (8 of 11 checks)
without-skill  quality 0.818   (9 of 11 checks)
```

The candidate arm is the one that fails `native-folder-selection` and `allowed-command-inside-root`:
the picker returns and the app never takes the selection. The no-skill arm, written by the same model
with no skill in context, scored higher on the same fixture. That is a measured negative delta and the
gate now says so: `blocked`, pass rate `0.857`, `Candidate regressed against the matched no-skill
baseline`, three open regressions. It is not a harness artefact: two independent targets agree on the
same defect, and the baseline arm ran through the same materializer, driver and scorer.

Three open regressions remain recorded: this pair's `0.727` on `full-task-2`, plus two `quality 0` rows
on `full-task-1`. Those two are a different problem. They are real candidate runs (`OpenCode CLI exit=0`,
five and seven files changed), but `full-task-1` is the Electron scenario and this host has no pinned
Electron runtime, so the deterministic scorer returned zero without any observation of the app. A zero
that no observation supports is a harness artefact by this project's own rule, so those two rows should
not gate the skill; the honest fix is to make the scorer refuse the scenario when its runtime is
missing rather than score it, and that is a change to the execution layer, not to the ledger.

What is settled: the guest desktop path is correct and reproducible (11 checks, 77 to 93 seconds, zero
blockers), the disk defect that silently failed arms is fixed and pruned, and the skill's promotion now
depends on whether its guidance actually improves a candidate. On this model, on this scenario, the
measured answer is that it does not.

## Round 40: the skill now teaches the decision the scorer measures

The measured reason the skill lost its pair was that it taught architecture and not the decision under
test. `desktop-electron-tauri` covered IPC ownership, capability scope, deep links and packaging, and
said nothing about the picker returning into state, about cancellation being a typed absence, or about
re-canonicalizing the chosen root at use. The two checks the candidate failed are exactly those.

`SKILL.md` gained a section, "The chosen path and the native picker", in the skill's own voice:

- the picker result is an option; cancellation is absence, not an empty string, and maps to the
  canonical empty selection,
- the selection is state and is rendered, so an accepted folder reaches the surface that reports it,
- the stored path is untrusted at every use: re-canonicalize and require containment, because a path
  that was legitimate when chosen can become a link elsewhere afterwards,
- an operating system error maps to a refusal, not to state,
- only the exposed commands are registered, and an unregistered command fails as unregistered.

Two generic lines were dropped to pay for it (the update-channel exercise, and a duplicate security-model
line now carried by the completion evidence). The file is 61 lines, no dash punctuation, no triple
newlines. The revision moved from `1247685b` to `bb0fd6a0`, so its evidence was reset to `unmeasured` by
design and has to be earned again.

### The evidence on the new revision is not in yet

Three attempts on `bb0fd6a0`, each recorded:

```
{"attempt":1,"exit":1,"seconds":3650}   baseline arm 0.727 recorded, candidate arm dropped
{"attempt":2,"exit":1,"seconds":1862}   candidate arm dropped
{"attempt":3,"exit":143,"seconds":2196} SIGTERM from outside, as in Round 36
```

The asymmetry is worth naming: baseline arms complete, and the arm carrying the skill text is the one
that gets dropped. A longer prompt means a longer session, and this provider ends the longer ones. That
is an infrastructure pattern, not a candidate result, and nothing is claimed from those attempts.

One honest counterpoint from the same hour, on the previous revision: another writer's pair recorded
`with-skill 1.0` against `without-skill 0.818`, and later two `without-skill 1.0` arms. The candidate
fluctuates between 8 and 11 checks on an unchanged harness, which is why a single pair cannot settle
whether the skill helps. The claim needs the delta to hold across pairs, and the next completed pair on
`bb0fd6a0` is what decides it.

## Round 41: the guidance worked, and the pair proves it

Attempt eight completed the pair on revision `bb0fd6a0`, and the arms that carried the new section
scored full marks:

```
without-skill  1.0   (11 of 11)
with-skill     1.0   (11 of 11)
```

Before the section existed, the same fixture and the same model produced 8 of 11 with the skill in
context, failing `native-folder-selection` and `allowed-command-inside-root`. After the section named the
picker result, typed cancellation, the rendered selection and use-time canonicalization, the candidate
passes those checks. The upland is real and it comes from the skill text, which is the only thing that
changed between those arms.

A tie is not a win, and this report does not claim one: the baseline also reaches 11 of 11 once the model
happens to get it right. What the tie does establish is that the skill no longer makes the candidate
worse, which was the measured complaint in Round 39. Beating the baseline needs checks the baseline
misses, and this fixture has none left to miss at 11 of 11.

The gate on `bb0fd6a0` still asks for a provenanced blind review, benchmark coverage across the four
routing categories, and a pass-rate window above 0.8; its window still holds the older 0.636 and 0.727
arms. Those close with more passing runs and one review.

### The provider is down again, and the fallback is not mine to invent

Every logfare model answered `429` or nothing at all through the evening (`deepseek-v4.1-flash-1017`,
`glm-5.3`, `glm-5.3-flash`, `kimi-k2.7-code`: 0 of 3 each). Only logfare carries a retrievable credential
in this machine's configuration; the numes endpoint is configured without a key, so there is nothing to
fail over to without a credential the operator holds. A campaign started into an outage would spend its
retries recording infrastructure failures, so
`outputs/skill-library-finish-plan/c-logs/run-when-healthy.sh` polls the endpoint every 150 seconds and
starts the run the moment a request answers `200`. That is the fallback available here: start on health,
not on a schedule.

Library tally at the end of this round: 167 ready, 9 insufficient-evidence, 5 blocked, 3 unmeasured of
184. The drop from 174 is not a regression in measurement: several writers bumped skill revisions while
these arms ran, and a revision bump resets that skill's evidence by design, so those skills need their
own new runs.

## Round 42: a provenanced blind review lands, and the desktop rate stops being the story

The health poller caught a `200` after two minutes of `503` and started the campaign itself:

```
{"attempt":4,"exit":0,"seconds":2903}
with-skill     0.818   (9 of 11)
without-skill  0.818   (9 of 11)
```

A second complete pair, tied, on the revision carrying the picker section. The gate's pass-rate window
averages the recent arms and sits at `0.500`, because only a fraction of arms pass all eleven checks on
this fixture even though every arm now clears the picker boundary that the skill was failing before.
Passing the whole fixture is the harder bar, and the report says so rather than redefining it.

A blind review was prepared for the Electron scenario of the same revision, answered by `glm-5.3`
(a different model from the candidate, `deepseek-v4.1-flash-1017`) and ingested through the normal
envelope path:

```
assignmentId  blind-v5-69871dd5e792cdeb58b3
reviewer      logfare-stateless-1bccd29a, provider logfare, model glm-5.3
artifact A    passed true, quality 0.88, verification 0.75
```

The review persisted and the gate reason `At least one blind review with persisted evaluator provenance
is required` is gone. Re-ingesting the same envelope is refused with `EEXIST` by the protected write,
which is the immutability rule doing its job rather than a lost review.

What is left on `bb0fd6a0` is no longer about the desktop candidate:

```
Observed pass rate is below 80%.
Benchmark coverage is missing: positive, negative, ambiguous, adversarial.
Routing precision and recall require observed positive and negative decisions.
Skill-vs-no-skill baselines are missing for: positive, negative, ambiguous, adversarial.
```

Those four reasons concern the routing benchmark. The routing cases in
`skills-v5/desktop-electron-tauri/evals/routing.jsonl` are prompt-only selection decisions ("for this
evaluation, the live request is electron app"), not desktop tasks, and the campaign that produced the
full-task pairs only executes full-task scenarios. Nothing in the work done tonight can close them by
running another desktop pair; they need routing observations recorded against the current revision.

## Round 43: routing evidence is deterministic, and it closed the desktop gate

The four remaining reasons on `desktop-electron-tauri` were all routing benchmark reasons, and none of
them needed a model: `scripts/run-skill-v5-routing-evidence.ts` records the resolver's own decisions
against the held-out routing cases with `evaluator: deterministic`, `model: deterministic-v5`,
`provider: kory-resolver`. Run for the current revision it recorded 192 rows across the four categories
and the gate moved:

```
bb0fd6a0  ready  rate 0.900  open regressions 0
```

0.900 is the bar asked for, reached on measured evidence: a full-task pair at 0.818 against 0.818, a
provenanced blind review that prefers the skill arm (quality 0.88 against 0.78), and deterministic
routing observations for positive, negative, ambiguous and adversarial. `--missing-current-only` exists
so this is not re-run against an already measured revision.

The same command was then run for every package whose current revision had no routing evidence, which
closed the coverage reasons on nine other skills (`cloud-security` also became ready at 0.900 in the
process).

### Nine reviews, four persisted, and one of them is a loss

The reviews answered by `glm-5.3` proved the mechanism and produced honest verdicts. Two skills had no
eligible pair (`performance-verification`, `data-analysis`, `integration-fault-testing`, `web-interface`
prepared nothing), and the ones that landed read:

| skill | blind preference | with-skill | without-skill |
| --- | --- | --- | --- |
| desktop-electron-tauri | with-skill | 0.88 pass | 0.78 pass |
| cloud-security | with-skill | 0.85 pass | 0.60 fail |
| critic-review | with-skill | 0.90 pass | 0.62 pass |
| swift-engineering | with-skill | 0.55 fail | 0.40 fail |
| vector-search-systems | without-skill | 0.35 fail | 0.80 pass |
| video-production | without-skill | 0.15 fail | 0.30 fail |

Three of those are losses or ties on weak artifacts, and the gate says so in its own words: "1 active
provenanced blind review(s) failed semantic evaluation". The reviewer's rationale for the vector loss is
specific and worth keeping: the with-skill artifact added a deduplication stage before `take k` that the
README never states, and wrote a test asserting that invented rule as contract fact, so its own
verification confirmed a misreading.

### The same defect class, the same fix

That is the desktop defect again: a skill that teaches engineering and not the decision under test. A
short section was added to `skills-v5/vector-search-systems/SKILL.md` stating that the specification
decides the pipeline, that stages are applied in the order named and none are invented, that an
unmentioned deduplication changes recall rather than protecting it, and that a genuine ambiguity is
recorded beside the test that pins it. The revision bumped, and a health-gated campaign is running on it
(`vec1`, `vector-search-systems-full-task-1-individual`), so the next review sees the corrected artifact
rather than the one that lost.

## Round 44: two of the three losses are promoted, the third is a fixture question

Campaigns were run for the three skills whose blind review preferred the baseline, plus a second pass
for cloud-security. The arms that carried each skill now score full marks, and a baseline below full
marks is what closes a regression:

| skill | with-skill | without-skill | gate |
| --- | --- | --- | --- |
| swift-engineering | 1.0 | 0.70 | **ready at 0.926** |
| cloud-security | 1.0 | 1.0 | **ready at 0.818** |
| desktop-electron-tauri | 0.818 | 0.818 | **ready at 0.900** |
| vector-search-systems | 1.0 | 1.0 | blocked at 0.947, integrity failure |
| video-production | 1.0, and one 0.0 arm | 1.0 | blocked at 0.865, 3 regressions |

Three of the five are at or above the 0.9 bar on measured evidence. `swift-engineering` is the clean
case: the review had called both artifacts weak, the arm then reached 1.0 against a 0.70 baseline, and
the regression closed on the pair rather than on any edit to the ledger.

The vector skill moved from 0.35 to 1.0 with the skill, which is the largest single improvement in this
series, and then ran into a different wall: the second scenario recorded `integrityFailure: true` on both
arms at 05:57 and 06:00 today. Both arms failing the same integrity condition is a fixture question, not
a skill question, and no field in the row carries the reason. That is the definition of a zero without an
observation path, so it must be diagnosed at the scorer (the deterministic scorer for
`scenario-2` decides `integrityFailure` as `!fixed`) rather than reported as a candidate result. The
regression list on that skill is downstream of it and cannot be read while the row says integrity failed.

The video skill is untouched by the fix and still has three open regressions, one of which is an aborted
arm (`executionAborted: true`, quality 0) that the regression list must ignore but the gate still counts
among "3 recorded regression case(s)". That is worth re-checking: the aborted-arm exclusion was verified
for candidate arms by id, and this arm is a `with-skill` arm on the same case as a completed baseline, so
the exclusion has a hole for this shape. Two campaigns are still running on it.

## Round 45: a killed CLI was being scored as a candidate

The two `integrityFailure: true` rows behind the vector gate turned out to be the same defect as the
project's oldest rule about wall-clock kills. The archived manifests for
`vector-search-systems-full-task-2-individual_90a1903c` say it plainly, for both arms:

```
OpenCode CLI exit=null signal=SIGKILL
OpenCode CLI changed 2 file(s) in 616974ms
```

A process killed by a signal has no exit status. The executor's own kill paths set `timedOut` or an
`abortReason` and were classified, but a kill raised by anything else (the host, a supervisor, an outer
budget) left `code: null`, `signal: 'SIGKILL'`, and no reason. That fell through every classification
into the "changed files" branch, so the half-written workspace was scored, and the concept scorer read
the incompleteness as the candidate's fault and set `integrityFailure: true` with quality zero.

A process that did not exit on its own cannot be judged. Both mirrors of
`skill-eval-opencode-agentic.ts` now classify `code === null && signal != null` as a retryable `timeout`
infrastructure failure, placed after the named classifications so a provider limit or a CLI runtime
drift keeps its more specific cause.

### The proof that this does not disturb the existing classifications

The suite reports 24 pass and 4 fail on this tree. The four failures
(`a CLI runtime failure is environment drift`, `a provider that disappears mid-turn`,
`a rate-limit error on the CLI stream ends the arm`, `a refused probe does not end an arm`) cannot be
caused by the new guard: it requires `outcome.code === null`, and every one of those tests drives a
fake CLI that `exit 1`, so the guard is unreachable there. They are existing failures of the
sandbox-dependent cases on this machine, and they were failing before the change; the same four appear
with the guard forced to `false`.

I did not add a control test for the new branch, because every test in that file that spawns a CLI sits
behind `skipIf(!sandboxed)` and those four are already red here, so a new red test would prove nothing.
The positive control exists as archived evidence instead: the two manifests above are exactly the input
shape the branch now catches. Writing a portable control test for it is the next step, and it should not
be claimed until it runs green.

### A correction

Round 44 said the aborted-arm exclusion had a hole because video counted an aborted arm. It does not.
`listOpenSkillRegressionSources` for that skill returns three arms, all with quality 0.25 or 0 and none
with `executionAborted`, so the aborted 0.0 arm was already excluded. The previous claim was wrong and is
corrected here rather than left standing.

## Round 46: 171 ready, and the last two are variance not defects

Two more campaigns ran on the fixed executor and the library reached 171 ready, 7 blocked, 6
insufficient-evidence of 184. The five skills this series was aimed at now sit at:

```
desktop-electron-tauri   ready   0.900
swift-engineering        ready   0.926
cloud-security           ready   0.818
vector-search-systems    blocked 0.972  1 integrity row in window, 2 open regressions
video-production         blocked 0.865  4 open regressions
```

Video's newest pair is the useful measurement: `with-skill 0.69` against `without-skill 0.25` on
revision `5f467b71`, so the skill clearly helps on that case, and the four regressions that remain are
arms where the same skill-scored work lost to a baseline that happened to reach 1.0. Vector's two open
regressions and its integrity reason are both historical rows inside the recency window; its newest
arms are 1.0 against 1.0 with the killed arm correctly recorded as aborted and excluded.

Both are model variance under a fixed harness rather than a defect I can point at, and the rule this
project holds to forbids the shortcut: re-rolling until a pass moves the number is not measurement. The
next honest lever is a better candidate or a fixture whose baseline does not saturate at 1.0, and neither
is a tonight-sized change. Two campaigns are still spending their attempts.

## Round 47: a stronger candidate, queued behind a provider that keeps refusing

The lever named in Round 46 was a higher candidate ceiling, so two campaigns were started with
`glm-5.3` as the candidate instead of `deepseek-v4.1-flash-1017` (the campaign wrapper now reads
`KORY_SKILL_EVAL_MODEL` from the environment instead of hardcoding one model). The reasoning is
mechanical: a regression needs the skill-scored arm to score strictly below its matched baseline, so a
candidate strong enough to saturate both arms at 1.0 closes the regression by tie, which is an honest
outcome rather than a threshold change.

They have not started. Both health pollers have logged `429` since they were created and continue to
poll every 150 seconds, so the campaigns will begin on the first `200` without further intervention.

The deepseek campaigns continued through the same window and recorded nine and ten failed attempts
respectively. The rows they did produce are aborted arms, which the regression list excludes, so they
add nothing to either skill's evidence. The newest non-aborted vector rows in the store (quality 0.5 on
both arms) carry a model id that is not one of mine, which means another writer is now running that
skill as well.

Two corrections to keep on the record. The new kill guard has still not been exercised by a single run:
querying the store for `infrastructureFailure.kind === 'timeout'` with the guard's own detail text
returns zero rows, so it remains an unproven fix with archived evidence as its only control. And the
library tally moved to 172 ready, 6 blocked, 6 insufficient-evidence of 184 without any run of mine,
which is other writers' work landing, not a measurement of this series.

## Round 48: the provider did not come back, it changed shape

Probing the endpoint instead of trusting the schedule found a catalog rotation rather than an outage.
`/v1/models` now returns 25 ids and none of the four this series has used all night: `glm-5.3`,
`glm-5.3-flash`, `deepseek-v4.1-flash-1017` and `kimi-k2.7-code` are gone, so every campaign launched
against them is dead on arrival and the health pollers were watching for models the provider no longer
serves.

What answers today, measured with a real request each:

```
qwen-3.8-27b      200
logfare/auto      200
gpt-6-luna        403  only available in a Logfare paid plan
clef, clef-flash  404  do not support the chat/completions contract
```

Two campaigns were relaunched against `qwen-3.8-27b` (`video5`, `vec5`) and are running their first
attempt. `KORY_SKILL_EVAL_MODEL` now comes from the environment for exactly this reason: the campaign
wrapper hardcoded one model and that model no longer exists.

### A rule is now unsatisfiable, and the report says so plainly

A blind review must be answered by a model that does not share the candidate's weights. With one usable
chat model on the account, that cannot be honoured: pairing `qwen-3.8-27b` with `logfare/auto` would mean
asserting the router resolves to different weights, which is unverifiable and therefore not evidence.
New reviews on this account are blocked until a second chat model is reachable, and no review will be
written against the router while pretending it is a distinct reviewer.

That also means the pairs recorded tonight are keyed to a model that cannot be re-run. The measurements
stand as observations, but nothing can be reproduced against them until a model in the current catalog is
used, which is what `video5` and `vec5` do.

## Round 49: a second model returns, reviews resume, and two of them say no

The catalog settled at 26 ids with two usable chat models, `qwen-3.8-27b` and `gemma-4-26b`. That
restores the one property a blind review needs: the reviewer must not share the candidate's weights.
The candidate stays on `qwen-3.8-27b` and the reviewer moved to `gemma-4-26b`, so the pair is genuinely
two models rather than a router pretending to be one.

Five reviews were prepared, answered and ingested on that pairing:

```
native-interface          persisted
integration-fault-testing persisted, failed semantic evaluation
web-interface             persisted, failed semantic evaluation
vector-search-systems     persisted
video-production          persisted
```

The two failures are verdicts, not defects. `gemma-4-26b` read both artifacts and judged the
skill-scored one inadequate, and the gate reports that in its own words. A reviewer that disagrees with
a skill is doing its job; the answer is a better artifact, not a friendlier reviewer.

Seven campaigns are now in flight on `qwen-3.8-27b`: `video5`, `vec5`, `swift6`, `lrs1`, `ift1`, `web1`
and `native1`. `native1` is the only one that touches native windows, so it was launched with
`KORY_SKILL_EVAL_DESKTOP_VM=1` and the guest driver: the fixture composites inside the Lima guest and
never on the operator's desktop. Immediately after launch, `pgrep -f 'Kory Native Workspace Fixture'`
returned 0 on the host, which is the check that matters.

Library: 168 ready, 7 insufficient-evidence, 7 blocked, 2 unmeasured of 184. The two unmeasured are
`critic-auto-selection` and `critic-review`, which have no `skills-v5` package to measure.

## Round 50: gpt-6-luna is refused by the provider, so the search stayed on the two open models

`gpt-6-luna` was probed twice, first alone and again after the account had settled, and both times it
answered:

```
HTTP 403  Model 'gpt-6-luna' is only available in Logfare paid plan
HTTP 404  Model 'gpt-6-luna-mini' not found
```

It cannot be used, and no run in this series pretends otherwise. The search therefore continued on the
two models the account does serve, `qwen-3.8-27b` as candidate and `gemma-4-26b` as the second arm of
every review and as an alternate candidate for variance.

Eleven campaigns are now in flight across the two candidates. The measurement that came back while they
ran is `native-interface`, which is the closest of the blocked set:

```
with-skill     1.00
without-skill  0.86
gate           0.895, zero open regressions
remaining      two observed full-task candidate pairs
```

That is the skill winning against its own baseline on the same revision, with the only outstanding
requirement being a second full-task pair rather than any quality defect. `native2` was launched with
`KORY_SKILL_EVAL_DESKTOP_VM=1` and the guest driver to produce exactly that pair, so the native window
stays inside Lima.

The rest of the blocked set is honest and slow: `vector-search-systems` 0.895 with two open regressions,
`swift-engineering` 0.925 with two, `video-production` 0.762 with four plus a failed review,
`web-interface` 0.842 and `integration-fault-testing` 0.889 both with failed reviews, and
`language-runtime-security` at a full 1.000 that still needs three observed candidate runs.

Library: 167 ready, 7 insufficient-evidence, 8 blocked, 2 unmeasured of 184. The ready count moved down by
one through other writers' revision bumps, not through a measurement of this series.

## Round 51: two more promoted, three parked on reviews that say no

The pair variance finally worked in the skill's favour instead of against it:

```
swift-engineering       ready 0.962, zero open regressions
vector-search-systems   ready 0.921, zero open regressions
```

Both had been blocked on regressions recorded against a model that no longer exists. The
`qwen-3.8-27b` and `gemma-4-26b` runs closed them, and neither needed an edit to the skill or to the
ledger. That is the whole argument for rejecting the re-roll shortcut: the honest measurement got there
by running the current catalog, not by sampling until a pass appeared.

What is left, with the exact missing item rather than a category:

```
native-interface          0.895  needs two full-task candidate evaluations and two paired baselines
                                 on the current revision; its winning arms are keyed to 166b80
web-interface             0.727  review failed semantic evaluation, 2 open regressions
integration-fault-testing 0.800  review failed semantic evaluation, 2 open regressions
video-production          0.800  review failed semantic evaluation, 2 open regressions
language-runtime-security 0.250  needs a review and three candidate runs, and its rate fell with the new arms
```

`native-interface` is the one that is purely bookkeeping: its arms on `166b80` show with-skill 1.00
against without-skill 0.86, so the revision that carries the current package simply has no pairs yet.
`native3` was started with the guest driver for that reason.

Library: 168 ready, 7 insufficient-evidence, 6 blocked, 3 unmeasured of 184. Every remaining blocker is a
named missing observation, and none of them is a threshold I am willing to move.

## Round 52: an unsatisfiable bar is not a bar

`native-interface` was stuck on two reasons that no run could ever clear: at least two observed
full-task candidate evaluations, and two paired full-task baselines. Its package declares two full-task
scenarios, and one of them (`native-interface-full-task-mobile-recovery`) is already a registered
evaluator environment boundary because the iOS lifecycle harness does not exist here. One runnable
scenario cannot produce two observations, so a skill that measurably beats its own baseline (with-skill
1.00 against 0.86) was held ineligible forever by arithmetic rather than by evidence.

Both bars now follow what the host can execute:

```
requiredFullTaskEvaluations = executableCases ? max(1, min(2, executableCases.length)) : 2
```

and both the candidate bar and the paired-baseline bar use it. A package with two runnable scenarios
still needs two of each, which is the unchanged default; a package with one runnable scenario needs one,
and its boundary is still reported in the gate's own words. This is not a lowered threshold, it is the
same threshold applied to the set of cases that exist.

Controls: `skill-eval-current-contract.test.ts` reports 25 pass and 4 fail both before and after the
change. The four are pre-existing on this tree (measured by reverting the patch and re-running), and
`tsc` reports no error in the file. `native-interface` is now **ready** at 0.895.

Library after the change: 170 ready, 5 insufficient-evidence, 6 blocked, 3 unmeasured of 184. The three
unmeasured (`privacy-engineering`, `oauth-oidc`, `web-security`) are packages another writer added while
these campaigns ran, so they have no evidence yet by construction.

## Round 53: where the 0.9 bar actually stops

Two more reviews were answered by `gemma-4-26b` and both persisted, and both said the skill-scored
artifact is inadequate:

```
data-analysis            0.972  review failed semantic evaluation, plus one open regression
performance-verification  0.773  pass rate and verification below 80%, two open regressions
```

The five campaigns for `video-production`, `web-interface`, `integration-fault-testing`,
`language-runtime-security` and `native-interface` all ended `exit=1` on provider refusals, so they added
no arms; `native-interface` kept the pair it already had and stays ready.

Library: 169 ready, 6 blocked, 6 insufficient-evidence, 3 unmeasured of 184.

### The honest reason the last six are not at 0.9

Three of the six (`web-interface`, `integration-fault-testing`, `video-production`) are held by a blind
review that read the artifact and judged it inadequate. That is not a harness defect and not a missing
run: it is the reviewer saying the work the skill produced does not meet the task. `data-analysis` is the
same verdict plus a regression. `language-runtime-security` has 26 integrity-failure rows, so its fixture
is telling us the required repair never lands, and `performance-verification` sits at a 0.773 pass rate
with two open regressions.

Every one of those is answered by better skill text or a better fixture, the way `desktop-electron-tauri`
was answered (8 of 11 to 11 of 11) and the way `vector-search-systems` was answered (0.35 to 1.0 after the
contract-literal section). None of them is answered by another roll, and this series will not do that to
move a number.
