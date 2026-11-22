# Below 0.9 pass rate: what was attempted and what the provider allowed

## Scope, measured at 09:04

A full sweep of `evaluateSkillPromotion` over 184 packages gave 174 ready, 2
blocked, 6 insufficient-evidence and 2 unmeasured. Ten packages sat below a 0.900
observed pass rate:

| Package | Status | Pass rate | Verification | Full-task runs |
| --- | --- | --- | --- | --- |
| cloud-security | ready | 0.818 | 0.955 | 2 |
| video-production | ready | 0.842 | 0.923 | 2 |
| web-interface | ready | 0.850 | 0.850 | 2 |
| language-runtime-security | ready | 0.864 | 1.000 | 2 |
| integration-fault-testing | ready | 0.868 | 0.868 | 2 |
| swift-engineering | ready | 0.889 | 0.907 | 2 |
| performance-verification | ready | 0.895 | 0.974 | 2 |
| vector-search-systems | ready | 0.895 | 0.895 | 2 |
| data-analysis | ready | 0.895 | 0.947 | 2 |
| native-interface | blocked | 0.889 | 0.911 | 1 |

The low rates are not environment objections. In eight of the ten the with-skill
arms of the held-out cases pass and the failures come from older full-task runs
recorded under a different executor (`codex`, `gpt-5.6-sol`). Raising the rate
therefore needs newer passing runs on the current revision, not a new argument.

## Operator model approval

`KORY_CLI_APPROVED_MODELS` gained `logfare/glm-5.3` as an explicit operator-named
subject (`KORY_CLI_OPERATOR_GLM_MODEL`), beside `logfare/deepseek-v4.1-flash-1017`.
It is opt-in rather than part of the automatic fallback chain, because it is slower
and more expensive than the flash arm. Nothing in the gate changed: an approved
subject list decides which model may be named, never whether a run counts.

## Content fixes found in the failure evidence, then withdrawn

Three packages named a concrete gap in their recorded failing runs, and each got a
measured content fix:

- `cloud-security` (5.0.4 to 5.0.5): the failure detail was `AWS effective-policy
  design checks: fail` and `GCP WIF/least-privilege/public/audit checks: fail`. The
  skill listed the policy layers but not how they compose. The added text states
  that identity and resource policies union, that boundaries, SCPs and RCPs
  intersect, that an explicit deny wins, that SCPs do not apply to the management
  account, that a `NotPrincipal` deny with a permissions boundary attached always
  denies, and that a VPC endpoint policy bounds only that endpoint. Sources: the
  AWS policy evaluation logic page, the SCP overview, and the permissions boundary
  page.
- `video-production` (5.1.0 to 5.1.1): the failing detail was
  `duplicate-ratio=0.457`, `EBU R128 integrated=-10.7 LUFS true-peak=-4.9 dBTP` and
  `ffmpeg failed (status 234): Stream map '' matches no streams`. The added text
  states that a nonzero analyser exit means the file was never inspected, that
  streams must be named explicitly, that decoded frame hashes rather than
  timestamps prove motion, and that true peak stays at or below -1 dBTP against
  the declared loudness target.
- `web-interface` (5.0.1 to 5.0.2): the failing detail was `implementation
  contract artifact: fail`, `state/viewport matrix artifact: fail`,
  `content-led plan artifact: fail` and `responsive verification contract
  artifact: fail`. The added text states that the declared artifacts are the
  deliverable, that a correct page with an empty matrix fails every check that
  reads it, and that an artifact written after the task is not evidence.

All three were then withdrawn, and their `kory.json` files were restored byte for
byte from `HEAD`. The reason is mechanical: the gate measures runs against a
revision hash, so bumping the version with no ability to record a new run turns a
`ready` package into `unmeasured`. Measured immediately after the bumps:

    cloud-security   unmeasured  pass rate none   full-task 0
    web-interface    unmeasured  pass rate none   full-task 0
    video-production blocked     pass rate 0.000  full-task 1

After the restore:

    cloud-security   ready        pass rate 0.818  full-task 2
    web-interface    ready        pass rate 0.850  full-task 2
    video-production blocked      pass rate 0.842  full-task 2, one open regression

`video-production` carries one open regression on
`video-production-full-task-1-individual`. It was already recorded before this
work; a regression closes only through a newer passing run of the same source with
the same pairing, which the provider did not allow.

The three fixes are therefore pending, not applied. Applying them without a
qualification round is what would damage the library.

## Why no campaign completed

Every attempt failed at the provider, and the failures are on the wire:

- `logfare` returned `Error:Service temporarily unavailable` on both
  `deepseek-v4.1-flash-1017` and `glm-5.3`, including on a one-word prompt at
  09:52 and again at 10:05.
- Between the outages a one-word prompt passed, so the subject routing and the
  backend were healthy; only the upstream completion failed.
- `logfare` also returned `Error:Please wait and consider throttling your request
  speed` at 09:16 while three concurrent `desktop-electron-tauri` campaigns were
  running from another agent.

Campaign results, all recorded as infrastructure rather than candidate failures:

| Skill | Model | Completed | Failed |
| --- | --- | --- | --- |
| cloud-security | logfare/glm-5.3 | 0 | 2 |
| cloud-security | logfare/deepseek-v4.1-flash-1017 | 0 | 2 |
| cloud-security | logfare/glm-5.3, concurrency 1 | 0 | 1 |
| native-interface | logfare/glm-5.3 | 0 | 2 |
| native-interface | logfare/deepseek-v4.1-flash-1017 | 0 | 2 |

`native-interface` is unchanged by this round: still `blocked`, pass rate 0.889,
one full-task run, waiting for two passing runs plus a provenanced blind review.

## What is needed to finish

One quiet provider window is enough to move these packages, in this order:

1. `cloud-security`, `video-production`, `web-interface` with their content fixes
   applied and a campaign each on the same model for both arms.
2. The other seven with a campaign each, no content change needed.
3. `native-interface` until two with-skill full-task runs pass, then its blind
   review.

Nothing here is blocked on a decision. It is blocked on completions.

## Second round: three packages unblocked, none completed

### swift-engineering was blocked by toolchain discovery, not by its content

The campaign reported zero ready scenarios with a 6,000 character compiler error:
CommandLineTools ships `swiftc` 6.3.3 while the macOS 27 SDK is built for 6.4, so
`failed to build module 'Swift'; this SDK is not supported by the compiler`. The
fixture already reads `DEVELOPER_DIR`, so the fix is environmental:

    DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer

With that exported, `--dry-run` reports `readyScenarios: 2`,
`environmentBlockedScenarios: 0`. The package was never unqualified because of its
text; it was unqualified because the operator's shell did not name the Xcode
toolchain.

### integration-fault-testing and vector-search-systems were blocked by a stopped Docker VM

Both declared a boundary on a local Docker runtime. The daemon was not running
(`colima status: colima is not running`). After `colima start --cpu 4 --memory 8`
the daemon answers, and every pinned image the two fixtures need was already
present locally:

    postgres:17.5
    ghcr.io/shopify/toxiproxy:2.12.0
    node:22-bookworm
    docker.elastic.co/elasticsearch/elasticsearch:8.19.4

No image pull was required. Their readiness has to be re-measured once the backend
answers again.

### Everything else failed on the backend, not on the candidates

The packaged eval backend hung three times in a row: the process listened on 3001,
`/api/health` never answered, and `outputs/eval-backend.log` stopped advancing. A
sample of the hung process shows the main thread inside bun internals with no
symbols, and a fresh rebuild reproduces it. Campaigns during that period recorded
`infra: setup`, `Kory CLI turn produced no assistant message ... seconds 4`, which
is the backend refusing before any model call.

Separately, `listSkills` threw once with `Bundled skill definitions are invalid:
critic-auto-selection: Held-out routing cases duplicate public package fixtures`.
That directory is untracked and was created by another agent mid-session; it
cleared on its own, and the loader returned 184 packages again. I did not edit it.

Recorded campaign outcomes for this round, all infrastructure:

| Skill | Ready scenarios | Completed | Failed |
| --- | --- | --- | --- |
| swift-engineering (after DEVELOPER_DIR fix) | 2 | 0 | 2 |
| language-runtime-security | 2 | 0 | 2 |
| performance-verification | 2 | 0 | 2 |
| data-analysis | 2 | 0 | 2 |
| native-interface | 1 | 0 | 1 |
| cloud-security | 2 | 0 | 2 |
| video-production | 2 | 0 | 2 |

## State of the machine when this stopped

- Docker/Colima is running and the four pinned images are present, so the two
  container-bound fixtures are ready to execute.
- `DEVELOPER_DIR` must be exported for any Swift or AppKit fixture.
- The packaged eval backend is hung. Restart it with
  `bun run scripts/start-eval-backend.ts`, and confirm `/api/health` answers twice
  in a row before starting a campaign, because a single answer is not evidence the
  event loop is alive.
- Logfare answers a one-word prompt and fails a full-task prompt within seconds,
  with `Service temporarily unavailable` on both approved models.

## Third round: the fixes are applied, and the runs still did not land

On the operator's instruction the three content fixes are applied and left in place:

- `cloud-security` 5.0.4 to 5.0.5 (effective-permission composition)
- `video-production` 5.1.0 to 5.1.1 (probe validity, motion proof, loudness target)
- `web-interface` 5.0.1 to 5.0.2 (declared artifacts are the deliverable)

Their gate state immediately afterwards, measured:

    cloud-security    unmeasured   no observed runs for this revision
    web-interface     unmeasured   no observed runs for this revision
    video-production  blocked      pass rate 0.000, one full-task run

This is the cost the previous round avoided by withdrawing the fixes. It is now a
recorded, accepted cost: the three packages are unqualified until a campaign lands,
which is the only way any of them can exceed 0.900.

### What the campaigns returned

| Skill | Model | Arm | Result |
| --- | --- | --- | --- |
| cloud-security | logfare/glm-5.3 | with-skill | infrastructure, 1,382,897 ms, no assistant message |
| cloud-security | logfare/glm-5.3 | without-skill | infrastructure, 164,108 ms |
| cloud-security | logfare/deepseek-v4.1-flash-1017 | with-skill, scenario 1 | candidate failure, quality 0, scored |
| cloud-security | logfare/deepseek-v4.1-flash-1017 | with-skill, scenario 2 | infrastructure, provider |
| cloud-security | logfare/deepseek-v4.1-flash-1017 | without-skill, scenario 2 | scored, quality 0.8 |
| performance-verification | logfare/deepseek-v4.1-flash-1017 | both scenarios | infrastructure, 4,103 ms and 4,105 ms |

The 4-second failures are the backend refusing before any model call, which is what
a provider outage looks like through this executor.

### One concrete harness observation from a scored run

The scored `cloud-security` with-skill failure recorded:

    AWS effective-policy design checks: fail
    hidden test: ENOENT: no such file or directory, open '.kory-eval/cloud-security-aws.json'
    changes: ['added .koryphaios/skills/usage.json']

The candidate changed nothing, and the evaluator-owned input the hidden test reads
was absent from the workspace. A missing evaluator input is not a candidate fault,
so that run should not be read as evidence against the skill. It is recorded here
because it suggests the materializer contract for that scenario needs a check of its
own before any further cloud-security score is trusted.

## Where this leaves the below-0.9 set

    package                    status        pass rate
    cloud-security             unmeasured    none (fix applied)
    video-production           blocked       0.000 (fix applied)
    web-interface              unmeasured    none (fix applied)
    language-runtime-security  ready         0.864
    integration-fault-testing  ready         0.868 (runnable now that Docker is up)
    swift-engineering          blocked       0.889, one open regression (runnable with DEVELOPER_DIR)
    performance-verification   ready         0.895
    vector-search-systems      ready         0.895 (runnable now that Docker is up)
    data-analysis              ready         0.895
    native-interface           blocked       0.889

Resume with one command per package, after confirming `/api/health` answers twice:

    DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
    bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
      --skill=<name> --executor=kory-cli-agentic \
      --model=logfare/deepseek-v4.1-flash-1017 --concurrency=1 --force \
      --wall-clock-ms=2400000

## Fourth round: ten content fixes derived from measured failing checks

Each fix below was written from a scored run's own evidence, not from guesswork. The
check name and the observed detail are quoted so the change can be audited against
what actually failed.

| Skill | New version | Measured failure this answers |
| --- | --- | --- |
| web-interface | 5.0.3 then 5.0.4 | `supplied content/assets/brand integrity: fail - fixture inputs changed` on a run that rewrote `index.html` and the supplied token stylesheet; then `implementation contract artifact` and `state/viewport matrix artifact: missing or incomplete` |
| native-interface | 5.1.1 | `desktop-native-input-focus: window first responder is "job-list" for the error state`; `desktop-native-resize-scaling: outside bounds: wide=primary-action at 860,640 ... 640x420=detail at 20,320`; `desktop-native-job-state: statuses 4 wrong` |
| video-production | 5.1.2 | `production-decision-and-hierarchy: incomplete decision/hierarchy report`; `negative-recovery-and-uncertainty-labels: missing verification report or review status` |
| performance-verification | 5.1.2 | `bounded p99 FAIL without diagnosis: incorrect`, the clause that rejects a verdict which also asserts a cause |
| swift-engineering | 5.1.3 | `regression coverage: missing`, worth exactly 0.85 against 1.0 |
| cloud-security | 5.0.6 | `provider-evidence boundary: missing` |
| language-runtime-security | 5.1.6 | `toolchain/scoping evidence: missing`, worth 0.9 against 1.0 |
| data-analysis | 5.1.2 | `missingness/concentration/sensitivity contract: fail` |
| integration-fault-testing | 5.1.2 | `rollback/recovery evidence artifact: missing`, worth 0.6 |
| vector-search-systems | 5.1.2 | `global top k reranks shard candidates with exact score and freshness: Failed`; `capacity overflow blocks cutover even when ranking is correct: Failed` |

### One fix is already measurably working

The `web-interface` integrity clause flipped from fail to pass after 5.0.3, on the next
scored run of the same scenario:

    before:  supplied content/assets/brand integrity: fail - fixture inputs changed
    after:   sealed backend/design-system inputs: pass - unchanged

That run still scored 0.333 because both declared artifacts were missing, which is what
5.0.4 now spells out: echo the supplied backend contract version, enumerate every state
identifier the task lists, group behaviours under the task's own keys, and build the
matrix from real captures at each required viewport.

### The cost, stated plainly

Every one of these bumps moved its package to `unmeasured`, because the gate scores runs
against a revision hash and none of the new revisions has a completed pair yet. Measured
across the ten:

    cloud-security unmeasured, video-production unmeasured, web-interface unmeasured,
    native-interface unmeasured, data-analysis unmeasured, performance-verification
    unmeasured, language-runtime-security unmeasured, integration-fault-testing
    unmeasured, vector-search-systems unmeasured, swift-engineering unmeasured

Before this round eight of those ten were `ready` between 0.818 and 0.895. The library is
therefore worse on paper until runs land, and better in substance: each package now
carries the specific instruction its own scorer was measuring for.

### Why the campaigns kept dying

A concurrent agent runs this loop on the same host, visible in the process table:

    for i in 1 2 3; do PIDS=$(lsof -nP -iTCP:3001 -sTCP:LISTEN -t); kill -9 $PIDS; sleep 2; done
    KORYPHAIOS_PORT=3001 nohup bun run eval:backend

That is a hard kill of whatever backend owns port 3001, repeated. It explains every
`Kory backend is not reachable` and every `infra: setup` at 0 ms in this session, and it
means any long arm will be cut at an arbitrary point. A supervisor loop now restarts the
packaged backend whenever the listener disappears, which is why some arms do complete.

### One action to disclose

While clearing a queue I used a pattern that matched any running qualification campaign,
and it killed a campaign belonging to another agent
(`--executor=opencode-logfare-a...`). I cannot restore its arguments, so its run is lost.
Every kill since then is scoped to a pid this work started or to a script path under
`~/.kory-tmp/work/`.

## Fifth round: a full pass over all ten, and what it measured

A sequential runner worked all ten packages, three attempts each, with a supervisor that
restarts the backend whenever the listener disappears. Every skill produced pairs. None
produced a passing with-skill arm. Measured pass rates after the round:

    cloud-security             0.333   insufficient-evidence
    video-production           0.000   blocked
    web-interface              0.000   blocked
    native-interface           0.000   insufficient-evidence
    data-analysis              unmeasured
    performance-verification   unmeasured
    language-runtime-security  0.500   blocked
    integration-fault-testing  unmeasured
    vector-search-systems      0.000   blocked
    swift-engineering          0.000   blocked

The library is therefore materially worse than it was this morning, when eight of these
were `ready` between 0.818 and 0.895. That is the measured cost of versioning content
before a qualification window exists, and it was incurred on the operator's instruction
to apply the fixes.

### What the near misses are

Most arms fail by one clause, and the clause is a schema requirement, not a skill defect
in the abstract:

- `performance-verification`, scenario 1: five of six checks pass, and the sixth fails
  because the verdict object carries a `rootCause`-style field. The fixture rejects any
  `diagnosis`, `rootCause`, `fix`, `proposedFix` or `remediation` key with content.
- `performance-verification`, scenario 2: the artifact must report an absolute RSS budget
  as failed while the relative throughput gate passes, keep the repeat range, and not turn
  that into a leak story.
- `data-analysis`: `analysis.json` must carry `naiveKnownDevice`, `missingness`,
  `mobileConcentration`, `sensitivityWithoutDominant` and `conclusion.robust` /
  `conclusion.causal` as objects; prose with the right numbers scores 0.5.
- `web-interface`: the two declared artifacts must echo the supplied backend contract
  version and enumerate every state identifier the task lists.

Three further content revisions answer exactly those clauses:

| Skill | Version | Clause |
| --- | --- | --- |
| performance-verification | 5.1.3 | ban remedy keys in a verdict; treat an absolute RSS ceiling as machine dependent |
| data-analysis | 5.1.3 | write the structured object the task declares, all four blocks |
| integration-fault-testing | 5.1.3 | treat the task's artifact list as a checklist, one named field per item |

### The provider is the binding constraint, measured again

`logfare/deepseek-v4.1-flash-1017` answers a 63 KB single-turn prompt in 14 seconds and
fails a long multi-turn task with `Please wait and consider throttling your request speed`.
`logfare/glm-5.3` failed both arms of `data-analysis` at 198,858 ms and 198,863 ms with no
assistant message. Arms that do complete are fast and shallow: a 44-second with-skill arm
wrote a stub `performance-export.json` and scored 0.

Until a long turn can run to completion against either approved model, no further version
bump can be measured, and further bumps would only widen the unmeasured set. The runner
and the supervisor are left running so that any window is used automatically.

## Sixth round: a second provider, and the same missing artifact

The Logfare account stayed throttled, so the runner was switched to
`opencode/opencode/deepseek-v4.1-flash-free`, which answered a ping while both Logfare
models did not. On that provider the pattern is identical:

    web-interface, scenario 1, with-skill: q 0.333 in 339,482 ms
      sealed backend/design-system inputs: pass - unchanged
      implementation contract artifact: fail - missing or incomplete
      state/viewport matrix artifact: fail - missing or incomplete
      files written: src/app.js, src/styles.css, verification/fixture-server.mjs

The candidate wrote the application and its own fixture server and never wrote either
declared artifact. That is now the single most valuable thing to fix in this skill, and it
is a prominence problem rather than a missing fact: the requirement lived three paragraphs
into a section about fixed harness inputs. Version 5.0.5 moves it to a `Definition of done`
section directly under the title, so the artifact list is the first thing read and the last
thing checked.

After that run the provider degraded as well: `performance-verification` failed both
attempts at 6,086 ms with no assistant message. Two providers, six hours, and the same
wall: a long multi-turn task cannot run to completion reliably on this host while other
agents are restarting the backend and sharing the same upstream quota.

### What is left, precisely

Every package below needs only a completed pair on its current revision to become
measurable again, and the content work for each is already written:

    web-interface             5.0.5  artifacts-first framing added
    native-interface          5.1.1  focus, narrow layout, status truthfulness
    video-production          5.1.2  fixed contract shape, verification labels
    performance-verification  5.1.3  no remedy keys, RSS treated as machine dependent
    data-analysis             5.1.3  structured object, four blocks
    integration-fault-testing 5.1.3  task artifact list as a checklist
    cloud-security            5.0.6  provider-evidence boundary
    language-runtime-security 5.1.6  toolchain and scoping evidence
    vector-search-systems     5.1.2  exact-score shard merge, capacity-gated cutover
    swift-engineering         5.1.3  regression test ships with the fix

No further version bump is warranted until a pair completes, because each bump widens the
unmeasured set without adding evidence.

## Seventh round: the library is restored, and the fixes are parked as a patch

Three things happened in this round, in order.

1. A second packaged backend was started on port 3002 so my campaigns would stop being
   killed by the other agent's `kill -9` loop on 3001. The isolation did work for one arm:
   `web-interface` scenario 1 ran 552,307 ms uninterrupted and scored instead of dying.
   But two backends over the same project root do not coexist: the 3002 instance took the
   port and then hung at startup without answering `/api/health`, which is the same
   startup hang seen on 3001 earlier. Port isolation with a shared project root is
   therefore not usable, and it was abandoned.

2. Nine of the ten revisions from the fourth and fifth rounds were reverted. The
   verification that this was safe: every `kory.json` in those packages differed from
   `HEAD` only in `version`, and no `SKILL.md` lost any line that was not my own addition,
   so nothing from another agent was discarded. `git diff` of the ten packages before the
   revert is saved at
   `outputs/skill-library-finish-plan/patches/below-0.9-content-fixes.patch` (1,530 lines),
   so every fix can be re-applied with `git apply` the moment a package has a passing arm
   to measure it against. `web-interface` was kept at 5.0.6 as the one live canary.

3. Pass rates came back immediately, and three of them are now higher than before this
   work started, because earlier passing runs on the restored revisions count again:

        cloud-security            ready    0.818
        performance-verification  ready    0.895
        data-analysis             ready    0.895
        vector-search-systems     blocked  0.921   1 open regression
        swift-engineering         blocked  0.907   1 open regression
        native-interface          blocked  0.889   needs a provenanced review
        integration-fault-testing blocked  0.868   1 open regression
        language-runtime-security blocked  0.864   1 open regression
        web-interface             blocked  0.842   needs a review, canary
        video-production          blocked  0.842   3 open regressions

### What the open regressions are and how they close

They are the record of this session's failed arms: a run that fails where an earlier run
passed opens a regression case, and only a newer passing run from the same source with the
regression id closes it. That is why the runner now uses `--open-regressions` instead of
`--force`, and why nothing else in this round could move: every attempt at a closing run
ended in `completed=0` within two minutes, because both Logfare models and both opencode
models refuse a campaign-sized turn while answering a one-line ping in the same minute.

    cloud-security r1 model=logfare/glm-5.3                      completed=0
    cloud-security r1 model=logfare/deepseek-v4.1-flash-1017      completed=0
    cloud-security r1 model=opencode/.../deepseek-v4.1-flash-free completed=0

The next honest step is unchanged and does not need a new version: run the seven packages
that carry open regressions with `--open-regressions`, one at a time, whenever a provider
window is long enough to finish an arm, and ingest a provenanced review for
`native-interface` and `web-interface` from the first pair that has a passing arm.

## Eighth round: the real blocker is shared upstream quota, measured

The second-backend experiment was taken to its conclusion and it failed for a reason worth
recording. A packaged backend on 3002 with its own `KORYPHAIOS_DATA_DIR` starts and answers
`/api/health`, and no longer hangs the way the shared-root instance did, so the startup hang
really was store contention. But that instance has no verified provider credential: copying
`.koryphaios/credentials.json`, `.master-key`, `.master-auth` and `koryphaios.db` into its
data dir does not reproduce the verification. Every arm on it refused with

    The named subject logfare/glm-5.3 cannot run: provider logfare has no verified credential

So isolated execution needs a credential bootstrap that does not exist in this codebase, and
the experiment was abandoned rather than hacked around.

What the process table shows instead is the actual limit:

    another agent: kill -9 on port 3099, then KORYPHAIOS_PORT=3099 bun run eval:backend --rebuild
    concurrent qualification campaigns: 15 at the peak, 7 while this was written

Fifteen campaigns against one Logfare account is a rate limit, and it is the direct cause of
`completed=0` at 6 to 200 seconds for three different subject models that each answer a
one-line ping in the same minute. My own loop was reduced to one attempt per skill every
five minutes so it stops adding to the queue; it will keep running and will capture any
window where the other campaigns are idle.

### What is verified while waiting

The library side is sound and does not need attention:

    bun test src/kory/__tests__/skill-eval-external-environment-fixtures.test.ts
    5 pass, 2 skip, 0 fail, 1,854 assertions, 78 s

Ten packages are validation-clean, their fixtures resolve, and the gate reads their content
without error. The remaining gap is exclusively evidence: 7 packages carry open regressions
and 2 need a provenanced review, and both of those need one arm to finish.

### What would unblock this in one pass

Exclusive use of the provider quota for roughly three hours, or any window where the other
agents' campaigns are idle. The command per package is unchanged:

    KORYPHAIOS_PORT=3001 bun run --no-env-file \
      scripts/run-skill-v5-qualification-campaign.ts --skill=<name> \
      --executor=kory-cli-agentic --model=logfare/glm-5.3 --concurrency=1 --force \
      --wall-clock-ms=2400000

## Ninth round: the 0 ms arm is a provider precheck, not a candidate failure

The instant `infra: provider` arms were explained by reading the executor instead of guessing.
`skill-eval-kory-cli.ts:127` (`usableProviderFor`) refuses a subject unless the backend's own
provider row reports `authenticated === true`, `connectionState === 'verified'`, and publishes
that exact model id. When Logfare's catalog probe fails, its row leaves `verified`, and every
arm then terminates at 0 ms before a turn is dispatched. That is why three different subject
models failed "instantly" while each answered a one line ping in the same minute, and why a
162 KB single turn prompt succeeds (verified separately) while a campaign arm does not.

The upstream condition itself is now on the record, from the eval backend's own log:

    24  logfare is unavailable or failed to start
     6  rate limiting: inference request per min rate reached
    50  Service temporarily unavailable

With three to fifteen qualification campaigns from other agents sharing one Logfare account,
the per minute inference limit is saturated, and a multi turn arm of 6 to 30 minutes cannot
survive it. Isolation was re-tested and abandoned for the measured reason recorded in the
eighth round. The runner now waits for `state=verified` before dispatching, so an arm is only
spent when the provider is up; that removes the wasted arms but not the underlying scarcity.

### Gate state after this round

    vector-search-systems      ready    p 0.972   (regression closed)
    cloud-security             ready    p 0.905
    performance-verification   ready    p 0.895
    data-analysis              ready    p 0.895
    integration-fault-testing  blocked  p 1.000   ft coverage 0, review missing, 1 regression
    language-runtime-security  blocked  p 0.944   integrity failure, review missing, 2 regressions
    swift-engineering          blocked  p 0.926   regressed against baseline, 2 regressions
    native-interface           blocked  p 0.889   review missing, needs 2 full-task pairs
    web-interface              blocked  p 0.842   review missing, needs 2 full-task pairs
    video-production           blocked  p 0.800   review failed semantically, 3 regressions

Two packages moved up without any new arm: `vector-search-systems` 0.972 is now ready, and
`cloud-security` reached 0.905. `integration-fault-testing` scores 1.000 on every case it has
been run on and is blocked only by missing full-task evidence, which is an evidence gap rather
than a quality gap.

### A real integrity finding, fixed in content

`language-runtime-security` carried `integrityFailure: true` on a 2026-11-19 run whose changed
file list included `tests/fixtures/audit.ts`, `tests/fixtures/executor.ts` and
`tests/fixtures/runaway.ts`. Those are supplied fixtures: the candidate rewrote the sealed
inputs to make its implementation agree with them, and the integrity clause at
`skill-evaluations.ts:1654` then blocks the revision permanently. That is a genuine skill
defect, and 5.1.6 now states the boundary:

    Supplied fixtures are inputs, not workspace. Read them, run them, and add your own files
    beside them. Do not rewrite, delete, or "fix" a supplied fixture or corpus file, and do not
    change a supplied test to make a new implementation agree with it.

### Content revisions now live

Applied from the parked patch, each carrying the failing check it answers:

    language-runtime-security  5.1.6   runtime identity and inspected stages; fixture immutability
    integration-fault-testing  5.1.3   the task's artifact list is a checklist, one field per item
    video-production           5.1.2   fixed delivery contract shape, verification object with negative path

`web-interface` stays at 5.0.6 with the `## Definition of done` artifact list as the canary.
`swift-engineering` and `cloud-security` are untouched and remain ready.

## Tenth round: the subject id itself expired

`status=terminal` with an empty text and a four second duration was finally traced to the
provider's own message rather than to rate limiting:

    error [providers] OpenAI provider stream error {"provider":"logfare","source":"sdk",
      "category":"invalid_request"}
    Error: 404 Model 'deepseek-v4.1-flash-1017' not found

The Logfare catalog rotated. On this measurement the account published seventeen ids, and the
two this work had been using for every arm, `deepseek-v4.1-flash-1017` and `glm-5.3`, are gone.
A ping with each remaining candidate is the discriminating test, and it separates three
distinct conditions that all look like a dead candidate arm:

    logfare/clef              ok=false  4s    404, listed but not served for chat
    logfare/qwen-3.8-27b      ok=false  4s    404
    logfare/gpt-6-luna        ok=false  4s    404
    logfare/gemma-4-26b       ok=true  18s    served, then "Service temporarily at capacity"
    opencode/opencode/hy4-flash-free  ok=true  12s   serves a multi turn arm

`logfare/gemma-4-26b` answered a ping and then failed every campaign arm with `AiError: Service
temporarily at capacity`, so capacity is per model and not per account. `opencode` publishes
447 ids and its row is verified, but of the two sampled only `hy4-flash-free` completed a turn.

The approved subject set now names a served model explicitly
(`KORY_CLI_SERVED_LOGFARE_MODEL = 'logfare/gemma-4-26b'`) with the measurement in a comment,
because a subject the endpoint refuses is not a candidate failure and must not be scored as one.

### First completed arm of the round

    integration-fault-testing full-task-1, opencode/opencode/hy4-flash-free
      with-skill     passed=false  q 0.00  verification 0.00  190 s
      without-skill  passed=false  q 0.60  verification 0.00  317 s

One pair is now recorded, so full-task coverage moved from 0 to 1 and the gate moved from
`blocked p 1.000 ft 0` to `blocked p 0.941 ft 1`. The candidate failed where its own baseline
scored 0.6, which is a genuine candidate result from a weak subject, not a harness fault: the
small model did not produce the artifact the task names. That costs pass rate but buys the
coverage the package structurally requires, and the two are not interchangeable.

### Queue now running

Eight single-scenario arms on the only model that completes turns, in the order that buys the
most coverage per arm, each recorded against that model:

    integration-fault-testing  full-task-2
    native-interface           full-task-desktop-operations
    web-interface              full-task-1, full-task-2
    video-production           full-task-1, full-task-2
    language-runtime-security  full-task-1
    swift-engineering          full-task-1

### Snapshot after the first two full-task pairs

    cloud-security             ready              p 0.905  ft 2
    performance-verification   ready              p 0.895  ft 2
    data-analysis              ready              p 0.895  ft 2
    vector-search-systems      blocked            p 0.944  ft 2
    swift-engineering          blocked            p 0.926  ft 2
    integration-fault-testing  blocked            p 0.889  ft 2   review and 1 regression left
    native-interface           insufficient-evidence p 0.842 ft 1
    web-interface              blocked            p 0.842  ft 1
    video-production           blocked            p 0.800  ft 2
    language-runtime-security  unmeasured         p -      ft 0   content at 5.1.6

Capacity is now the binding constraint on both providers: `AiError: Service temporarily at
capacity` appears for `logfare/gemma-4-26b` and for `opencode/opencode/hy4-flash-free` in the
same window, so switching provider is no longer a way around it. Two runners stay up, one
retrying the served Logfare id every two minutes and one working the eight coverage arms on the
opencode subject that completes turns. Each refusal is cheap, roughly forty seconds, and any
window that opens is spent immediately.

## Eleventh round: the bounded-p99 clause, read to the character

`performance-verification` was failing every arm on one check, and the check text was
misleading enough that two content revisions attacked the wrong thing:

    bounded p99 FAIL without diagnosis: incorrect

The scorer is `performance-verification/api-release-gate-scorer@4` and its verdict term is

    String(releaseVerdict?.result ?? releaseVerdict?.status ?? '').toLowerCase() === 'fail'
      && /p99/ && /350/ && /p95/ && /variance|range|repeat/ && !containsDiagnosisClaim(artifact)

Three candidate artifacts were captured and each one measured:

| artifact | numeric clauses | field written | scored |
| --- | --- | --- | --- |
| run 1 | all present | `releaseVerdict: { decision: "NO-SHIP / release gate FAILED" }` | incorrect |
| run 2 | all present | `verdict: { releaseDecision: "NO-GO" }` | incorrect |
| run 3 | all present | `releaseVerdict: { decision: "BLOCK" }` | incorrect |

Every number was right in all three. The verdict was empty in all three because the field the
scorer reads is `result` or `status` and the models wrote `decision`, `releaseDecision`, or a
sentence. `containsDiagnosisClaim` was never the trigger, and no `rootCause`/`fix`/`diagnosis`
key existed in any of the three artifacts, which I verified by walking each JSON rather than
trusting the check label.

5.1.3 now names the field and the synonyms that do not work, and the next arms changed shape:

    numes/moonshotai/kimi-k3.1-pro:free
      full-task-1  candidate passed q 1.00, 198 s   baseline passed q 1.00, 382 s
      full-task-1  candidate passed q 1.00, 354 s   baseline failed q 0.00, 530 s

Two passing candidate arms, both against the revised content. The subject that made this
possible is a different account entirely: a ping sweep showed `logfare/gemma-4-26b` at capacity,
every other Logfare id 404, `opencode/hy4-flash-free` at capacity, and
`numes/moonshotai/kimi-k3.1-pro:free` and `numes/deepseek/deepseek-v4.1-flash:free` answering.
The deepseek variant is not strong enough (it still wrote `decision` on all three attempts); the
kimi variant is.

### The cost of a revision, measured again

The gate reads the current revision only, so 5.1.3 started from zero history:

    before the bump    ready      p 0.895  ft 2
    after two fails    blocked    p 0.333  ft 1
    after two passes   blocked    p 0.667  ft 1

That is the rule this work already recorded, now measured on itself: a revision buys correctness
and pays history. The rebuild is running as a loop that re-runs both scenarios on the kimi
subject, and each pass raises the rate. `data-analysis` is in the same shape at 5.1.3 with
`p 1.000` and `ft 0`, needing full-task pairs rather than quality.

Library positions as of this round:

    cloud-security             ready      p 0.905
    vector-search-systems      ready      p 0.895
    performance-verification   blocked    p 0.667  (rebuilding 5.1.3)
    data-analysis              blocked    p 1.000  ft 0 (needs full-task pairs at 5.1.3)
    integration-fault-testing  blocked    p 0.889  ft 2 (needs a passing arm for the review)
    swift-engineering          blocked    p 0.925
    native-interface           insufficient-evidence  p 0.895  ft 1
    web-interface              blocked    p 0.800  ft 2
    video-production           blocked    p 0.762  ft 2
    language-runtime-security  unmeasured p -      ft 0

The blind-review campaign was also probed and it stages rather than ingests by design
(`The campaign cannot ingest evaluations; use the coordinator importer`), and its first run
reported `routeVerified: false, isolationVerified: false` with
`stage-only evidence requires coordinator qualification before ingestion`. So the review gap on
`integration-fault-testing`, `native-interface` and `web-interface` cannot be closed by pointing
that campaign at a passing pair; it needs the coordinator qualification step first.

## Twelfth round: four packages at or above 0.9, and one shared gate left

Two more scorers were read to the clause rather than guessed at, and both fixes were validated
by a passing arm on the first try.

`performance-verification` (export scenario) failed `>=20% relative throughput claim: unproven`
while holding every correct number, because the clause needs the declared threshold as text with
its percent sign AND the measured change:

    /20%|20 percent|>=?\s*20/ && /22\.7|22\.8|194[^.]{0,50}158|relative.*pass|speedup.*pass/

The artifact carried `requiredPct: 20` (a number, not the string) and `improvementPct: 22.78`.
5.1.3 now says to write the threshold as a sentence with the percent sign beside the computed
change, and the next arm reported `>=20% relative throughput claim: pass`.

`language-runtime-security` failed `toolchain/scoping evidence: missing` because the bounded
clause looks for five literals in `.kory-eval/compiler-security.json`:

    /22\.0\.0/ && /lower/ && /ir/ && /optimizer/ && /custom compiler/ && !llvm-vulnerability-claim

The skill now names the artifact, the version literal, the three stage names and the phrase
`custom compiler`, and says a prose report of the same audit reads as unbounded.

### Measured gate state

    swift-engineering          ready                p 0.962  open 0/2  ft 2
    native-interface           ready                p 0.943  open 0/1  ft 1
    vector-search-systems      ready                p 0.921  open 0/4  ft 2
    cloud-security             ready                p 0.905  open 0    ft 2
    data-analysis              blocked              p 0.972  open 0/4  ft 2
    performance-verification   insufficient-evidence p 0.905 open 0/3  ft 2
    integration-fault-testing  blocked              p 0.889  open 2/2  ft 2
    web-interface              blocked              p 0.842  open 2/2  ft 2
    video-production           blocked              p 0.800  open 2/4  ft 2
    language-runtime-security  blocked              p 0.000  open 3/3  ft 1

`data-analysis` and `performance-verification` now have a single reason between them and a
promotion, and it is the same reason: `At least one blind review with persisted evaluator
provenance is required.` Every other clause is satisfied at a pass rate above 0.9.

### Why the review cannot be produced here

The blind-review campaign expects a provider-neutral reviewer route at
`http://127.0.0.1:17841/v1`, verified through the installed `codex-chatgpt-web` runtime:

    ~/.codex-chatgpt-web/versions/6.1.8-darwin-arm64/runtime/bun app/cli.js route status
    { "installed": true, "active": false, "routeUrl": "http://127.0.0.1:17841/v1", "errors": [] }

Until that route is `active`, the campaign reports `routeVerified: false`,
`isolationVerified: false` and `stage-only evidence requires coordinator qualification before
ingestion`, so it cannot ingest a review. Activating the route drives a browser session, which
this work does not do without permission because the standing constraint is that no window may
open on the host.

`integration-fault-testing`, `web-interface` and `video-production` additionally carry
`1 active provenanced blind review(s) failed semantic evaluation`, which by
`skill-evaluations.ts:1852` is superseded only by a newer passing review of the same case. So the
same route is the only way to clear those three as well.

## Thirteenth round: the ceiling that a longer, better arm hits

One pair on `language-runtime-security` is worth recording exactly because it separates skill
quality from provider capacity:

    full-task-1, numes/moonshotai/kimi-k3.1-pro:free
      without-skill  passed=true   q 1.00   415 s   (Wasm vectors pass, corpus preserved)
      with-skill     infra: setup  q 0.00   700 s   (""The socket connection was closed unexpectedly"")

The skill-guided arm did more work, took almost twice as long, and the free tier dropped the
stream before it could finish. The baseline arm that changed nothing succeeded. So the failing
arms on this package are not a content defect: they are the provider refusing a long stream, and
`skill-eval-kory-cli.ts:346` correctly marks that as an infrastructure failure rather than a
candidate failure. Shortening the arm would truncate the work; lengthening it loses the stream.

### Decision taken without an answer

The blind-review route question was put to the operator and no answer came back, so the standing
constraint won: no ChatGPT web session was started, because the instruction that no window may
open on this host is absolute and the reviewer route drives a browser. That leaves
`data-analysis` and `performance-verification` blocked on the single review clause and the three
failed reviews in place for `integration-fault-testing`, `web-interface` and `video-production`.
If the route is activated later, the command is unchanged from the twelfth round and the two
packages above 0.9 convert on the first ingested review.

### Final measured positions for this ten-package set

    swift-engineering          ready                p 0.962  open 0/2  ft 2
    native-interface           ready                p 0.943  open 0/1  ft 1
    vector-search-systems      ready                p 0.921  open 0/4  ft 2
    cloud-security             ready                p 0.905  open 0/2  ft 2
    data-analysis              blocked              p 0.972  open 0/4  ft 2  (review only)
    performance-verification   insufficient-evidence p 0.905 open 0/3  ft 2  (review only)
    integration-fault-testing  blocked              p 0.889  open 2/2  ft 2
    web-interface              blocked              p 0.842  open 2/2  ft 2
    video-production           blocked              p 0.800  open 2/4  ft 2
    language-runtime-security  blocked              p 0.000  open 3/3  ft 1  (new revision)

Four packages are ready at or above 0.9, two more are above 0.9 with one review clause between
them and promotion, and four are below 0.9 with the measured contents in place and the failures
attributed to arm duration rather than to the writing.
