# Drive: 165 of 182 ready, and why the rest needs hardware or a policy call

## Where the library stands

165 of 182 skills are `ready`. The remaining 19 split three ways, and only one part of that split is
work.

| Group | Count | State |
| --- | --- | --- |
| Ready | 165 | verified at the current contract |
| Evaluator environment boundary | 14 | cannot execute on this host at all |
| Reachable in principle, blocked on artifact quality | 5 | named gate below |

Started this overnight pass at 161. `integration-implementation` and `react-engineering` reached
`ready` during it.

## What QEMU can and cannot do here

I checked this rather than assumed it. QEMU is installed (`qemu-system-aarch64`, `qemu-system-x86_64`)
and could boot a Linux or Windows guest, but none of the remaining blockers is a guest-OS problem:

- **GPU/CUDA group** (`gpu-compute`, `image-generation-practice`, `speech-audio-ai`,
  `video-production`, `hardware-runtime-debugging`, `simulation-device-testing`): there is no NVIDIA
  device on this host to pass through, and CUDA cannot be emulated. A guest would report the same
  absence the host reports.
- **Windows 11 plus NVDA** (`accessibility-verification`, part of `computer-use` and
  `native-interface`): the fixture's blocker is a static declaration that the scenario requires
  independently observed screen-reader announcements. A headless guest has no audio session to
  observe, and I will not manufacture an announcement transcript.
- **iOS** (`ios-swiftui`): needs a booted simulator, which needs full Xcode, which is not installed
  and cannot be fetched without an Apple ID on this machine. A macOS guest under QEMU on Apple
  Silicon is not supported either.
- **Tauri half of `desktop-electron-tauri`**: needs a trusted native window and compositor driver
  outside the fixture. That is evaluator code somebody has to author, not an environment to boot.

What QEMU therefore changes tonight is nothing, and I would rather say that than boot a guest to
produce evidence that means less than the evidence already in the ledger.

## The machine I stood up

The host had no Android environment at all, which is why `android-compose` and its siblings read as
unreachable. It now has one:

- SDK at `/tmp/androidsdk` (platform-tools 37.0.1, platforms;android-37.0, build-tools;36.0.0,
  emulator 37.2.13, system image `android-37.0;google_apis_playstore;arm64-v8a`), licences accepted
  through `sdkmanager`;
- Gradle **9.6.0** unpacked at `/tmp/gradle96/gradle-9.6.0`, because the readiness probe requires
  that exact version and the host ships 9.8.2;
- JDK 27 wired through `KORY_SKILL_EVAL_ANDROID_JAVA_HOME`;
- the host's default SDK is `MacOSX27.0.sdk`, whose `libSystem.tbd` the installed linker cannot
  read (`unknown architecture: arm64e.x1-macos`), so every clang and swiftc call fails; pointing
  `SDKROOT` at `MacOSX26.5.sdk` restores both toolchains. That defect is why
  `c-cpp-systems-engineering` and `swift-engineering` reported compiler blockers while their
  evidence was already valid, and both are `ready`;
- the dedicated AVD `kory-v5-android37-isolated` booted headless on `emulator-5554`, reporting
  `sys.boot_completed=1`, `ro.build.version.sdk=37`, `ro.kernel.qemu=1`, with
  `com.google.android.marvin.talkback` installed and its accessibility service enabled.

`androidComposeNativeReadiness` returns `[]` for both scenarios, and two real qualification pairs
then executed on the emulator: `android-compose-full-task-1-individual` produced a passing review at
version 2026-11-14T19:08, superseding the failure that blocked that case, and the full-task-2 pair
came back with both arms passing at 1.00.

`android-compose` is still `blocked` on its older full-task-2 adjudication. `--prepare-only
--retry-failed` lists that clean pair as eligible, but the campaign reports
`availableAssignments: 0` and `skippedExistingReviews: 1`, so it will not stage a second
adjudication for a case that already has a sealed assignment. That is a review bookkeeping limit
rather than an artifact problem, and I am not deleting sealed assignments to get around it.

Two of the remaining classes cannot be fixed by any VM on this hardware: there is no NVIDIA device
to pass through, and a Windows guest needs the NVDA session observed through real audio, which no
automation here can honestly attest.

## The 14 that cannot reach ready here

`computer-use`, `embedded-firmware`, `embedded-interface`, `game-spatial-interface`, `gpu-compute`,
`hardware-runtime-debugging`, `image-generation-practice`, `native-interface`, `react-native-expo`,
`research`, `robotics-control`, `simulation-device-testing`, `speech-audio-ai`, plus the newly
identified `accessibility-verification`.

Each one's materializer declares what it needs and none of it exists on this machine: an NVIDIA GPU
with CUDA, a Windows 11 session with pinned Chromium and NVDA, an Android device with TalkBack, a
booted iOS simulator, robotics and embedded hardware, or a capture device. The campaign refuses to
queue them and the gate now says so in one sentence instead of demanding a blind review and two
paired baselines that can never exist. Raising this ceiling needs different hardware, not more
agent hours, and inventing the evidence is the one thing this work does not do.

## The 5 that need better artifacts or a runnable scenario

| Skill | Pass rate | What actually blocks it |
| --- | --- | --- |
| `android-compose` | 0.921 | clean current pair on a real emulator, but the campaign refuses a second adjudication for a case with a sealed assignment |
| `desktop-electron-tauri` | 1.000 | both full-task scenarios declare an unavailable Electron/Tauri runtime, and one unpaired run blocks the boundary branch |
| `ios-swiftui` | 0.941 | candidate edited evaluator-owned `Sources/DocumentSupport.swift` and an unrelated scenario source; its reruns no longer queue |
| `literature-research` | 0.762 | needs a fresh pair at its new contract, then a review; four campaigns from another agent are running against it |
| `novel-ui-toolkit` | 0.727 | sealed harness changed and the newest pairs fail on their own merits |

For these five the honest next action is artifact improvement, not more review: a review cannot pass
what the scorer already fails.

## What I fixed instead of grinding

Four defects in how the gate reads its own evidence, each with positive and negative controls:

1. The skill-vs-no-skill uplift kept the newest pair per executor identity, so a retired executor
   family anchored a skill to its own past forever. It now keeps the newest pair per case, exactly
   as pass rate and quality already did. Proof: `architecture-planning` read `blocked` at a 1.000
   pass rate before and `ready` after; restoring the old key puts it back.
2. Scenarios whose materializer is the fail-closed environment gate reported unreachable evidence as
   missing work. They now name the boundary and drop the impossible demands.
3. Native stateless eligibility pinned one model and one provider by name, so a receipt from any
   other model was discarded as malformed. Validation is now derived from the run's own identity.
4. A materializer that declares what it needs (a Windows/NVDA session, an Android TalkBack device)
   was still reported as missing a review. Declarations now count as the same boundary, unless the
   scenario already has eligible runs at the current contract, in which case the environment plainly
   executed it and the checklist stands.

A correction to my own earlier note: `failedProvenancedBlindReviews` reads the newest review per
case, so a later passing review does supersede an earlier failure. The previous claim that a failure
was unretirable was wrong, and it is why `integration-implementation` reached ready tonight.

## Tests

`skill-eval-eligibility` 52 pass, `skill-eval-external-environment-fixtures` 7 pass,
`skill-eval-evidence-contract-regressions` and sealed fixtures 125 pass together,
`skill-eval-current-contract` 26 pass with 2 failures proven pre-existing by disabling every change
of mine. Typecheck clean in every file I touched.

## What would move the number next

One Windows 11 machine with NVDA and pinned Chromium takes `accessibility-verification` and half of
`desktop-electron-tauri`. One Android device with TalkBack takes `android-compose` and the other
half. A GPU host takes the CUDA group. Everything else is artifact quality, which needs the candidate
to write better code, not a different reviewer.
