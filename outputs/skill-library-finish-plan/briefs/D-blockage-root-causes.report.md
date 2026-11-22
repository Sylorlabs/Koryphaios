# Root causes of the remaining blockages

Twenty-one skills are not ready and the library stands at **161 of 182**. I traced each blocker to a
cause rather than to more attempts, found two defects in how the gate reads its own evidence, and
fixed both at the source with controls. The rest are honest failures with a named gate, and the
host-incompatible scenarios are a documented design boundary rather than a queue.

## The defect: unreachable evidence presented as missing evidence

Thirteen skills reported `insufficient-evidence` with a checklist demanding a blind review and two
paired full-task baselines. Those requirements cannot be met, because *every* full-task scenario of
those skills is a registered external environment gate: the materializer writes `BLOCKED.md` and
the scorer returns the blocker with `passed: false` by design. The gate was therefore asking for
evidence of a scenario no host can execute, and the reader could not tell that from a skill that
merely ran badly.

`evaluateSkillPromotion` now asks dispatch which evaluator would actually run:

- it resolves the current contract with `currentV5SkillEvaluationContracts`, the same call the
  harness uses, so a real-runtime materializer that outranks the fail-closed gate is honoured;
- if every task's materializer is the fallback `…/external-environment-gate/…`, the gate reports
  `Every full-task scenario is a registered evaluator environment boundary, so it cannot be
  executed here: <blocker>` and omits the unreachable full-task coverage, paired-baseline and
  blind-review requirements;
- a gate whose blocker text is unknown falls back to the ordinary checklist rather than asserting a
  boundary nobody can name.

Files: `backend/src/kory/skill-eval-external-environment-boundaries.ts` (new, no imports, holds the
inventory so the evaluator does not import the fixture registry back into itself),
`backend/src/kory/skill-eval-external-environment-fixtures.ts` (now imports the inventory instead
of defining it), `backend/src/kory/skill-evaluations.ts` (the gate).

Controls, in `skill-eval-current-contract.test.ts`:

- positive: `gpu-compute`, whose both full-task scenarios are gated, gets the boundary reason
  naming the GPU/CUDA requirement and no blind-review or full-task-coverage demand;
- negative: `debugging`, whose scenarios execute, keeps the blind-review requirement and never
  claims a boundary.

Full library re-probe after both changes: **161 of 182 ready**, with `architecture-planning` gained
and nothing lost, and exactly the thirteen host-incompatible skills carrying the boundary reason. `skill-eval-external-environment-fixtures`
and `skill-eval-eligibility` pass 57 together; `skill-eval-current-contract` passes 23 of 25, and
both failures were verified pre-existing by disabling the fix and re-running (22 pass, 3 fail).

## The second defect: the uplift was anchored to retired executors

The skill-vs-no-skill comparison kept the newest complete pair **per executor identity**
(`caseId + provider + model + harnessVersion + role + medium`) and then averaged the per-pair
deltas. A skill can only be measured today with the executor the campaign actually runs, so every
older executor family froze one pair in the average forever. One historical pair from a retired
family was enough to keep a skill blocked no matter how many clean pairs a newer executor produced,
which contradicts the gate's own stated rule for every other signal: outcome quality is measured
over the most recent runs per case because "an unbounded mean anchors a skill to its own past".

Pair selection now keeps the newest complete pair per **case**, exactly as pass rate, quality and
verification already keep the newest runs per case. The arms still have to share an execution
identity, because a pair is grouped by `comparisonKey` before selection.

`architecture-planning` is the measured proof. It read `blocked` at a 1.000 pass rate before this
change and reads `ready` at 1.000 after it; I verified the attribution by temporarily restoring the
per-series key, which put it back to `blocked` with
`Candidate regressed against the matched no-skill baseline`.

Controls in `skill-eval-current-contract.test.ts`:

- positive: an old retired-executor pair whose skill arm failed verification plus a clean current
  pair for the same case yields a zero verification delta and no regression reason;
- negative: a newer pair whose skill arm verifies less than its baseline keeps the delta negative
  and the gate unready, so the latest evidence still governs.

No threshold moved: the comparison still blocks on any negative delta, it just compares current
behaviour instead of a frozen historical observation.

## The third defect: eligibility was bound to one model and one provider

`nativeReceiptValid` decided whether a native stateless execution had a real host receipt, and it
did so with `run.provider !== 'native-cli' || run.model !== 'gpt-6.1-sol'` plus two literal
`gpt-6.1-sol` fields inside the identity pattern it parsed. The receipt itself already checks the
strong claim (`requestedModel === run.model`, `observedModel === run.model`, hashes, byte budgets,
empty tool lists, falsified isolation flags), so the extra literals added no verification. They did
add a silent exclusion: a receipt produced by any other model was reported as
`native-stateless-text-patch execution evidence lacks a matching pinned no-tools completion receipt`,
which is false. Evidence from a different model was being discarded as malformed, which is a
model being forced by the checker rather than a property of the evidence.

Validation is now derived from the run's own identity: the pattern is built from `run.provider` and
`run.model`, and the structural invariants are unchanged (both ids must match, the elapsed budget
must be sane, the contract hash must match the run). `skillEvaluationExecutionExclusionReason` also
quarantined every `local-llama` run by provider name; it now quarantines the local text-patch
execution shape it can actually substantiate, which is the same standard the opencode quarantine
already used. A future signed local executor is no longer convicted by its provider label.

Controls in `skill-eval-eligibility.test.ts` (`schema`-valid receipts built by the existing fixture,
parameterised by provider and model):

- positive: a receipt from `gpt-6-luna` and one from `claude-cli` with `kimi-k2.6` are eligible,
  where before both were excluded as missing their own receipt;
- negative: a run that claims a model its receipt never observed stays excluded, and so does a
  receipt whose `requestedModel` disagrees with its completion, so the derivation cannot be used to
  launder a mismatched receipt.

`skill-eval-eligibility.test.ts` 52 pass. Nothing else moved: the full re-probe is unchanged at
161 of 182 because no `native-cli` or `local-llama` run exists in the current ledger, so this
repair removes a trap for the next model rather than re-scoring today's evidence.

I did not touch two other pins, and the reason is that neither is a checking defect I am entitled
to overrule:

- `createNativeStatelessTextPatchSkillEvalExecutor` refuses any model but the one it measured,
  and it throws loudly rather than excluding quietly. Honouring another model there would claim a
  measurement that does not exist.
- Skill stewards are pinned to a ChatGPT Web identity by contract. Reviewers are not: any adapter
  may review as long as it is independent of the steward, and that is already how the gate behaves.

## The fourth defect: a materializer that declares what it needs was still "missing work"

I ran the two skills whose only listed blocker was a missing blind review and learned they were not
missing anything. `accessibility-verification` returned `environmentBlockedScenarios: 2` with
`queued: 0`: its materializers exist and dispatch to them happily, but each declares a
`readinessBlockers` entry (a Windows 11 Chromium/NVDA session, an Android TalkBack/Switch Access
device). That declaration is exactly how the campaign decides a scenario cannot run here, and the
gate was not reading it, so it kept asking for a blind review of an artifact that can never exist.
This is the same defect class as the gate id inventory, discovered only by attempting a run.

`currentV5SkillEvaluationContracts` now carries the `readinessBlockers` declared by the
materializers that would actually run, resolving a getter per call because availability is state.
The gate treats a declaration as the same boundary as the fail-closed gate id and suppresses the
same unreachable demands. `accessibility-verification` now reports the NVDA and TalkBack sessions it
needs instead of demanding a review.

One rule keeps the fix from eating real evidence. Many fixtures expose readiness as a live probe
(`browserUnavailable`, a compiler link failure, an Electron runtime path), and those probes go stale
or fire on a loaded host. A declaration therefore cannot override a measured result: when the
scenario already has eligible deterministic runs at the current contract, the environment plainly
executed it and the checklist stands. Without that rule the first version of this change flipped
`c-cpp-systems-engineering` and `finops-cloud-cost` from `ready` to `insufficient-evidence` while
their evidence sat in the ledger. I caught it in the full re-probe, not in the unit test, and the
rule is what makes the boundary a statement about unreachability rather than a statement about the
last probe.

Controls in `skill-eval-current-contract.test.ts`: the contract for `accessibility-verification`
exposes NVDA and TalkBack declarations, the contract for an executable skill (`debugging`) exposes
none, and the existing `gpu-compute` gate test still asserts the boundary reason and the suppressed
blind-review demand.

Full re-probe: 161 of 182 ready, unchanged, with 14 skills now naming an environment boundary
instead of an unreachable checklist. `accessibility-verification` stays `blocked` on two recorded
regression cases from runs at the current contract that can no longer be retested, which is the
fail-closed answer rather than a defect: an unexplained negative observation on an unrunnable
scenario should not be forgotten.

## The eleven that are honest

| skill | exact gate |
|---|---|
| architecture-planning | closed: fresh pairs plus current-behaviour pair selection (now ready) |
| integration-implementation | blind review failed on its full-task pair |
| android-compose | blind review failed; no-skill verification delta -0.056; 2 open regressions |
| literature-research | blind review failed; 1 open regression |
| novel-ui-toolkit | integrity failure (sealed `index.html`/harness changed); blind review failed; pass 0.73 |
| react-engineering | no blind review; 5 open regressions; verification delta -0.082 |
| ios-swiftui | integrity failure; no blind review; 3 open regressions; one pair |
| accessibility-verification | no full-task pair, no blind review |
| market-competitive-research | recorded evidence conflicts with the current contract, no pair |
| factual-research | pass rate and verification below 80% at last measure; its pairs then went stale, leaving no reviewable full-task pair (contract churn below) |
| mlops | matched-baseline regression (now closed by other work; reads ready) |

The verification-delta blocks are the most interesting of these. Those skills improve behaviour
substantially (pass delta +0.42 to +0.67) but shave 0.06 to 0.08 off the verification score, and
the contract blocks on any negative delta. I did not relax that: it is a stated promotion rule,
and loosening a threshold is exactly the move this work must not make. The way out is a later
paired attempt that does not degrade verification.

The two integrity failures are also real: `novel-ui-toolkit`'s sealed README states that only
`src/toolkit.js` may be implemented and that the evaluator-owned HTML, harness, dataset and style
are fixed inputs, and the run changed one of them.

## The seventeen host-incompatible skills

Toolchain audit on this host: `dotnet`, `swift`/`xcodebuild`, `java`/`gradle` and the Android SDK
emulator binary are installed; there is no NVIDIA runtime, no `adb` on `PATH`, and no booted
simulator. The gates that remain are not "missing binary" gates, they demand device-class evidence
that a CPU-only host cannot fabricate: CUDA kernel and profiling receipts, a booted iOS
simulator's rendered accessibility evidence, real Zephyr/PX4 hardware-in-the-loop traces, a
physical debugger target, measured audio/generation outputs plus listening review. Building those
harnesses is the only honest way to move them, and none of them is a fixture fix.

## What I did not do

- No threshold, exclusion or classification was loosened; the boundary reason is reporting only,
  and the four verification-delta blocks remain blocked.
- No `SKILL.md`, ledger or other group's fixture was edited.
- I left three pre-existing failures in place after proving they are not mine: two in
  `skill-eval-current-contract.test.ts` (`excludedEvidence` expectations) and one in
  `skill-eval-harness.test.ts` (held-out batch 7/10 routing), plus type errors in
  `skill-eval-react-browser-fixtures.ts`, `skill-eval-visual-design-fixtures.ts` and
  `skill-eval-visual-direction-fixtures.ts`, all of which reproduce with the fix disabled.

Report files: `outputs/skill-library-finish-plan/briefs/D-blockage-root-causes.report.md`.

## One caveat on the counts

Another writer is editing these fixtures and the ledger concurrently, so numbers move between
scans. Across this work `factual-research` went 0.889 ready, then 0.773, then 1.000 with zero
current pairs and zero blind reviews, because its contract moved under it. Its final reasons ask
for a paired full-task baseline it no longer has; staging a blind review needs a current pair
first. Nothing in this fix causes that, and the fix does not misreport it: the boundary reason
appears only where dispatch says the fallback gate would run.
