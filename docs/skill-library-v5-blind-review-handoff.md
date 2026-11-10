# V5 independent blind-review handoff (2026-10-11)

## Current native-host continuation (2026-10-23)

The **182/182 ready and promoted** directive remains active. Continue without
milestone announcements, using independent native GPT 6.1 Sol subagents for
engineering work. Do not use Codex quota, invent evaluator provenance, or turn
coordinator-context forks into blind-review evidence. Preserve this heavily dirty
worktree; this continuation has made no commits or pushes.

The current host is **macOS**, not the previous Linux execution environment.
Native Bun is `/opt/homebrew/bin/bun` **1.3.14**, OpenCode is **2.0.32**, and
OmniRush is **2.6.8**. Real Brave exists at its declared macOS path. Explicit
credential-free runtime selectors verified here are
`PLAYWRIGHT_BROWSERS_PATH=/Users/Shared/micah/Library/Caches/ms-playwright` and
`BUN_INSTALL_CACHE_DIR=/Users/Shared/micah/.bun/install/cache`. Never recover
ambient credentials or the original HOME inside the isolated test runner.

The earlier **2026-10-23T09:01:38.699Z** inventory reported **105 ready / 58 blocked /
19 insufficient-evidence**, **308/364 execution-ready**, qualification exit **1**,
static quality exit **0**, ledger SHA-256
`bf193fc9d4f22904ea8a60618cb8d4ad065273aa6ee625a743d9458a3dc4c07d`.
Official regeneration at **2026-10-23T17:06:09.270Z** completed after the scorer
repairs and again reported **105 ready / 58 blocked / 19 insufficient-evidence**,
qualification exit **1**, static quality exit **0**, unchanged ledger SHA-256 and
**308/364 execution-ready**. That exit **1** is the genuine non-ready gate result,
not a failed report-generation process. A newly identified freshness concern is
under independent investigation: the gate currently selects newest **observed**
contract generations and still reports both debugging/visualization full-task
coverage after their **source** scorer bumps without fresh runs. Do not interpret
this snapshot as proof of qualification under the final **@3/@10** source
contracts. Independent repair has now reproduced the affected gate rows: debugging
retained **1** current full task / **2** current full-task pairs, visualization
**1** current full task / **1** pair, both with routing **1/1**, no blind credit,
and preserved historical open regressions. The distinct **deterministic-debugging**
package has current contracts and remains unaffected; the earlier agent's conflation
was corrected. These are focused post-fix checks, not a regenerated whole-catalog
inventory. The subsequent **official** snapshot at **2026-10-23T17:27:18.963Z**
reported **49 ready / 115 blocked / 18 insufficient-evidence** under exact current
source-contract gates, qualification exit **1**, static quality exit **0**. The
reduction removes stale coverage; it is not evidence deletion or a new skill
regression. The earlier **105-ready** snapshots are superseded, not retrospectively
rewritten. No inference, blind-review ingestion, or promotion credit was added by
these reports. Java's genuine unavailable runtime remains fail-closed. Runtime
readiness is not qualification or promotion credit.

The source promotion/closure repair finished with **166 passed / 0 failed** in
five files, **3,094 assertions**, clean backend types and scoped whitespace checks.
It also independently reproduced and fixed a hashless explicit `regressionId`
retest closing an old V5 full-task failure by changing its category to `regression`.
Full-task closures now require the exact current source contract; routing and
generic semantics and immutable historical failures remain intact. Direct source
checks at **17:52** found **zero exact current first-task observations** for
**debugging @3** and **capacity visualization @10**; their other-task gate coverage
remains **1** full task each. The distinct valid **deterministic-debugging** control
remains ready with **2** full tasks, **2** pairs and **1** blind review. Ledger hash
was unchanged. The last selector edit was around **17:47**, after the **17:27**
whole-catalog snapshot. The latest official source-gated refresh at
**2026-10-23T18:17:06.655Z** completed normally and again reports **49 ready /
115 blocked / 18 insufficient-evidence**, **182 packages**, qualification exit
**1**, static quality exit **0**. This supersedes the **17:27** snapshot without
new inference or ledger credit and does not validate the unexecuted package-build
suite.

Current-contract packaging remains an engineering prerequisite: eager registry
imports pulled optional browser modules into the previously lean evaluation
module. The original actual backend build passed (**2,990 modules / 26.35 MB**) with
startup-safe lazy registry lookup, and an unsupported raw bundle without the
registry returned **zero contracts without throwing**. That is safe fail-closed
behavior, not packaged promotion availability. A separate owner now has exclusive
helper/build integration access and is implementing lightweight metadata generated
from the actual source registry in-memory by the genuine backend build. Source
stubs stay null; absent, malformed or stale metadata must confer no credit. The
packaging owner has now handed back a **partial, unvalidated implementation**:
source-helper integration passed the existing backend typecheck, which excludes
new build scripts and test files. Main subsequently covered both new build scripts
and the new test file with a static compiler-API `noEmit` check using the real
backend aliases/type roots and existing ambient declarations: **0 diagnostics**.
The first runner setup lacked the installed Bun/Node type roots (**two TS2688**);
correcting the runner resolved them without shims or dependency changes. This is
static type coverage only, not test or build execution. All **21 parameter-expanded
new test cases are unexecuted**; the focused command was rejected before dispatch
five times by the classifier timeout, including the latest retained-context
continuation retry. These are failures before dispatch, not failing tests. The
owner is paused again, with no further edits or launched verification. No actual
new package build ran or touched the prior build artifact; its
existing bytes are stale for this integration and prove nothing. Resume the
retained owner after recovery for focused tests, actual protected-scratch recipe
validation and post-integration promotion tests. Main's final combined static
check of both backend build scripts, the new backend test and both desktop source/
test files passed **0 diagnostics** over **5 explicit roots**; no tests or builds
were executed by that check.
No hand-authored manifest, ambient environment/global override, browser external
flag or stale distribution is acceptable. The **166-test** source result predates
this packaging follow-up and does not verify it.

The desktop owner completed its separate source route using the same collector/
plugin, preserving target/output/asset semantics and fail-closed raw compiles. Their
own retry dispatched successfully before the pause arrived: **5 tests passed /
0 failed / 35 assertions / 3.93 s** across the new route file and existing desktop
controls. Two genuine macOS-arm64 helper standalone binaries proved fresh source-
metadata/map equality, recursive freezing, stale package/epoch rejection and null/
empty raw-bundle fallback. The actual `server.ts` desktop compile also succeeded
in private scratch: **88,163,170 bytes**, executable mode **755**, target
`bun-darwin-arm64` / `aarch64-apple-darwin`. The full server executable was **not
started**, outputs were removed and existing desktop resources/backend build were
untouched. No Windows/Linux runtime, cross-target, gzip packaging, Tauri/frontend,
signing/publishing or inference claim follows. Final subsequent desktop edits
changed only a header comment and the unexecuted Windows staging `.exe` suffix;
the tested native path was unchanged.

The earlier raw CI backend compile in `.github/workflows/release-desktop.yml`
(**199-213**) bypassed the plugin. CI delegation attempts failed before SendMessage
dispatch and launched no peer work. During the subsequent continuation, main used
normal dedicated source-editing tools to implement the local route directly:
`scripts/compile-backend.ts` reuses desktop's `compileEmbeddedBackend` and hence
the single fresh-source plugin, takes explicit validated matrix target/output
arguments, keeps Windows output suffixes, stages on the destination filesystem and
renames only a successful regular nonempty artifact. The YAML now invokes that
wrapper; the four matrix targets, artifact paths, relay environment and existing
Linux gzip step are unchanged. Relay quoting uses the shared JSON-escaped define,
not a shell-built literal. No CI job, upload, signing, publishing or cross-target
download was triggered.

The final corrected CI/desktop three-file group (`buw3wbs1c`) actually dispatched
under normal permissions at **19:38:51** and passed **17 tests / 0 failures /
69 assertions / 7.45 s**, exit **0**. This includes the genuine fresh-process
private-HOME/`--no-env-file` full-server CI compile and retained artifact, mode,
cleanup and unchanged-ledger assertions. It is local native build/test evidence,
not server startup, cross-platform CI execution, model qualification or promotion
credit. The separate backend packaging suite remains unexecuted.

Preserve the preceding real failures: main's earlier
three-file retry actually dispatched: **16 passed / 1 failed / 62 assertions / 4.36 s**.
The new CI file alone reproduced **11 passed / 1 failed / 27 assertions / 3.56 s**.
Both genuine in-process full-server compiles reported `Could not resolve:
"./routes/collaboration"` at `server.ts:39`. The tracked route is a regular file,
**18,517 bytes**, with an old modification time, and `Bun.resolveSync` resolves it.
No route/server changes or stub were made to force compilation. The exact Bun
loader cause remains unproven; preserve both real failures.

A separate fresh-process CLI control actually compiled the full native backend:
exit **0**, **88,163,170 bytes**, private HOME/output, full executable **not started**
and scratch removed. A separate streaming digest check afterward confirmed the
real evaluation ledger remains exactly
`bf193fc9d4f22904ea8a60618cb8d4ad065273aa6ee625a743d9458a3dc4c07d`
(**69,935,209 bytes**). That control preceded the later explicit dotenv-disable flag
and is not verification of the final corrected test. The native CI test now invokes
the actual CLI in its own private-HOME process, retains artifact/exit/mode/cleanup/
ledger assertions, strips inherited credentials and uses the installed, help-
verified `--no-env-file` flag. The CI YAML uses that flag too while retaining its
explicit relay environment. No browser external, fake route, weaker assertion or
global timeout was introduced. The first corrected three-file rerun was rejected
**before dispatch** by the classifier timeout; the later unchanged-permission
retry passed as recorded above. Main's post-fix static compiler-API check over
**7 explicit build-script/test roots** also passed **0 diagnostics**, using existing
types and no shims. Neither that static result nor the CI/desktop pass validates
the denied backend package suite. Its retained owner retried their own exact
isolated command a **sixth** time after the CI command dispatched, but that call
was still rejected **before dispatch**: all **21 cases**, the genuine backend
package recipe and post-integration source promotion/regression tests remain
unexecuted. No backend/build preservation or overwrite operation was launched.
The next bounded public native no-op control was initially rejected before
dispatch too. A later own-permissions retry (`bl21743pr`) genuinely passed: exact
`<kory-eval-patch>[]</kory-eval-patch>`, no infrastructure/task failure, **4,001**
actual stream bytes, complete strict native event parsing and exit **0**. Its
unsigned host receipt reports **2,302** serialized request bytes and **2,653 ms**;
workspace contained only the unchanged public README and was removed. This is a
real no-tools native control, not a qualification pair, blind review, OS sandbox
claim or signed upstream model attestation. The subsequent exact fresh
`debugging-full-task-1` campaign call was rejected **before dispatch**: no paired
process, archive or ledger write launched. Service recovery remains action-specific;
do not route rejected calls to peers.
Main's separate source-gate verification then passed **145 tests / 0 failures /
3,093 assertions** across **5 explicitly selected files** (`by7etxusj`): current
contract **18**, harness **30**, regression closure **4**, packages **21**, skills
**72**. Each file ran with a disposable database and credential-stripped HOME;
exit **0**. This does not cover the embedded packaging test or genuine build recipe.
The preceding coordinator command (`b4qr8ztdo`) mistakenly supplied bare test paths:
`parseTestSelection` requires repeated `--file`, so it began the entire backend
scan while appending those paths to each invocation. Main stopped that incorrect
run after inspecting the selector; its repeated partial passes are not a settled
whole-backend or focused-suite result. The corrected five-file command used
`--file` explicitly. The packaging owner was informed of the same selection
problem in their six never-dispatched commands. Their one subsequent properly
scoped `--file` command was likewise rejected **before dispatch** under unchanged
permissions. The retained owner subsequently retried that correctly scoped command
once more after main's isolated fixture commands dispatched; it was again rejected
before dispatch and they stopped without an alternate route. Totals: **six rejected
malformed-selection calls, two rejected correctly scoped calls, zero launched
packaging-suite/build processes**. All 21 packaging cases and the actual backend
recipe remain unexecuted; the old build artifact was untouched. No substitute
runner or permission change was used.

The official source-gated inventory refresh (`bqpggwrvn`) completed at
**18:17:06.655Z** with unchanged **49 / 115 / 18** counts, qualification exit **1**
and static quality exit **0**. Reporting completed normally; exit **1** is the
real non-ready gate result. The reporter verifies its before/after ledger digest;
no inference, reviews or ledger credit were added. No tracked task remains running
from that report. Later native retries include the genuinely successful public
no-op control recorded above, but the first three attempts at the exact first fresh
debugging campaign call were rejected before dispatch, including the retry after
input-reader hardening and successful seven-file integration gates. New
qualification pairs remain unstarted; none of those rejections produced an archive
or ledger write. A streaming
ledger digest at **2026-10-23T20:04:49.542Z** still matched
`bf193fc9d4f22904ea8a60618cb8d4ad065273aa6ee625a743d9458a3dc4c07d`,
**69,935,209 bytes**; this is one observed snapshot, not an assertion against
future concurrent writers.

Resumed independent engineering checks found and repaired additional concrete
issues, without reinterpreting historical qualification failures:

- Native parser: content-erased shared shape validation avoids false rejection
  when valid backtick data expands past the parser's internal cap. A JSON-string-
  aware outer delimiter scan now treats literal patch tags inside file content as
  data and rejects malformed/nested/multiple real blocks. Strict JSON, final-text/
  write budgets and exact original contents remain enforced. Four valid literal-
  tag cases failed before the fix; eight malformed cases retain rejection.
- Eligibility reader: three actual FIFO swaps blocked bounded disposable children
  before `fstat`; two inode-preserving output/manifest symlink swaps were wrongly
  accepted. `archived()` now uses read-only/no-follow/nonblocking opens, retaining
  bounded descriptor reads, identity/protection and exact provenance checks. Final
  native/eligibility/selection/dispatch group: **139 passed / 0 failed /
  969 assertions**, scoped eight-file types and whitespace clean. Fake-CLI and
  disposable-kernel controls are not new model qualification evidence.
- Reviewer archive/profile readers: initial-size-plus-one descriptor reads and
  no-follow/nonblocking opens reject growth/truncation and FIFO races. Post-read
  file/profile-parent identity and protection are rechecked. Final focused group:
  **167 passed / 0 failed / 711 assertions / 4 files**, scoped types clean. Actual
  macOS kernel denials and a credential-free pinned CLI bootstrap remain separate
  from synthetic completion fixtures and successful paid inference.
- Importer: three isolated regressions showed mutually consistent stale epoch or
  materializer/scorer metadata could retain a current hash and validate. Owned
  selection/review counting now requires current source epoch/hash and actual
  registered IDs. Importer group: **154 passed / 0 failed / 323 assertions**;
  the nine-file native/importer/campaign/backend-eligibility group passed **458 /
  0 / 1,339 assertions / 9.83 s**, scoped types and whitespace clean. Only isolated
  synthetic ingestion was tested; no real stage/import or central ledger writes
  were performed.
- Public capture: `snapshotTextFile()` in `skill-eval-execution.ts` separately
  reproduced replacement/symlink/growth acceptance (**0 passed / 3 failed**).
  Canonical-parent and file identity checks, bounded initial-size-plus-one reads,
  read-only/no-follow/nonblocking opens and a **64 MiB** capture ceiling now reject
  those races, a real FIFO replacement and an oversized sparse file. Exact valid
  UTF-8/raw hash/byte length and frozen before-execution snapshots remain intact.
  Direct capture controls passed **13 / 0 / 37 assertions**, with **14 old execution
  tests filtered**, including persistence cases. Reviewer/campaign plus capture
  controls passed **180 / 0 / 748 assertions / 5 files / 11.91 s**. Scoped types and
  whitespace passed. Importer's public-file readers remain **2 MiB**: broader
  capture availability does not imply import eligibility or raise any import cap.
- Main's subsequent isolated current-contract/eligibility/harness/native/regression
  group (`bmvh61nkn`) passed **167 / 0 / 995 assertions / 5 files**, exit **0**.
  This verifies those source/native gates, not the denied packaging suite or new
  qualification evidence.
- Shared patch containment: `assertWorkspacePath()` incorrectly rejected the
  genuinely contained `release../summary.txt` path. The isolated regression failed
  **0 / 1** before the fix. Routing containment through `runtime/platform.ts`
  `isContainedBy(root, target)` replaces the hand-rolled relative/separator check
  without weakening lexical path, symlink, directory, delete or write-budget
  protections. Main's existing patch file then passed **7 / 0 / 27 assertions**
  (`b71pvvowj`), exit **0**.
- Actual model-input snapshot: the shared `readTextContent()`/`walk()` reader in
  `skill-eval-text-patch.ts` separately reproduced **1 passed / 10 failed /
  51 assertions** in the new `skill-eval-text-patch-snapshot-race.test.ts`. Seven
  controls reproduced leaf/growth/replacement and parent/ancestor/root/listing
  leakage; a real FIFO blocked only its disposable child until a fixed **1,200 ms**
  kill/reap deadline. Invalid and split UTF-8 controls also failed before repair.
  Bounded read-only/no-follow/nonblocking descriptors, file device/inode/size/time
  checks, root/parent canonical identity checks and checks around enumeration now
  reject those controls. Invalid UTF-8 is omitted; valid content including BOM
  remains exact, and aggregate clipping ends only between complete code points.
  **120,000 bytes/file**, **400,000 total content bytes**, depth/skipped metadata
  and omission/truncation labels are retained. Canonicalized Unix race fixtures
  require mutation markers so macOS `/var` aliases cannot silently prevent hooks
  from firing. Final six-file snapshot/patch/native/eligibility/executor/dispatch
  group: **157 / 0 / 1,067 assertions / 4.87 s**; scoped ten-root TypeScript and
  whitespace checks clean. Main's containment function/test remained intact.
  This is defensive input capture on the tested host, not universal OS isolation,
  an atomic snapshot attestation or new qualification credit. Main's separate
  source/input integration check (`boeotqyyk`) completed **7 explicitly selected
  files passed / 0 failed**, exit **0**, including all **11 snapshot-race controls**
  and **7 existing patch controls**. It did not execute the denied packaging suite.
  The subsequent exact fresh debugging retry was again rejected before dispatch;
  no live pair/archive/ledger write launched. After the final concurrency blocker
  tests and main's configured backend typecheck passed, main's fourth original-route
  fresh-debugging attempt was likewise classifier-unavailable **before dispatch**;
  no generation/archive/ledger write launched.
- Original-base integrity: main reproduced a separate host-provenance defect in
  `skill-eval-execution.ts`: executor/scorer writes to the shared original base, and
  replacement of its directory with identical content, were accepted. Persistence
  recomputed `initialFingerprint` from that later base rather than using the captured
  starting fingerprint. A new isolated `skill-eval-execution-base-integrity.test.ts`
  failed **1 passed / 3 failed / 15 assertions** before repair. The runner now pins
  base directory device/inode/canonical identity and its captured fingerprint,
  rejects observed changes around dispatch/scoring/persistence, and records the
  original captured fingerprint in manifests. The three mutation controls refuse
  before ledger writes/second-arm dispatch and clean their pair; benign candidate-
  only edits retain exact original before-file evidence. Final focused result:
  **4 / 0 / 30 assertions**. Main's six-file source/native/provenance integration
  (`bn2j09wid`) settled **171 / 0 / 1,025 assertions**, **6 files / exit 0**;
  configured private-HOME backend types and scoped whitespace also passed.
  These are controlled synthetic source regressions, not live model qualification,
  universal OS confinement or an atomic snapshot guarantee. They do not upgrade
  historical manifests or fabricate previously missing original observations.
  Independent source-only review then identified a concrete NUL-framing bypass in
  the older fingerprint serializer: different file trees produced the same hashed
  byte stream without a SHA-256 collision. Main reproduced both the direct hash
  ambiguity and bypass of the new guards (**4 passed / 2 failed / 32 assertions**).
  The tree now frames sorted path/per-entry-hash pairs as versioned JSON, preserving
  `file\0` / `symlink\0` entry domains; new manifests declare
  `workspaceFingerprintFormat: path-entry-sha256-json-v1`. Final six controls passed
  **6 / 0 / 39 assertions**. The post-framing six-file integration (`beeo759mc`)
  passed **173 / 0 / 1,034 assertions**, configured backend types/whitespace passed,
  and four existing paired/public-input/budget/runtime controls passed **4 / 0 /
  25 assertions**, with **23 other execution tests filtered**. Historical fingerprint
  values keep their original format; no archived inputs or receipts were rewritten.
  Checkpoints are not continuous immutability, pair-level atomicity, or full metadata/
  empty-directory/`.git` coverage. A later-arm failure can leave its valid first-arm
  row, and late persistence failure can leave partial report files without a complete
  qualified pair. No new promotion credit was added. The next original-route fresh
  debugging attempt remained classifier-unavailable before dispatch.

  The source reviewer reported an unintended internal code-review fork despite the
  read-only/no-delegation scope. Main's listing showed no active such fork, and
  stopping the reported ID `adbb09185e6b96be6` returned **No task found**; do not
  claim it was successfully stopped or rely on any unreceived delegated result.
  The useful framing finding was independently reproduced by main before repair.
- Concurrency semantics: next-task preparation independently reproduced full-score
  false positives under credential-stripped Bun **1.3.14**. Save scorer **@6**
  accepted a stress/iteration comment and a plan artifact explicitly saying it was
  not executed; deadlock scorer **@2** accepted a single conflict/control test
  without the declared bounded repeatability record. Both returned passed/quality/
  verification **1**. The narrow owner repaired only concurrency fixture/scorer
  contracts and `skill-eval-concurrency-deadlock-regression.test.ts`. Runtime
  evidence must come from evaluator-owned observations/assertions, not candidate-
  declared counts or regenerated JSON. Required receipt schemas are public;
  materializer/scorer identities were advanced. First-phase controls passed
  **9 / 0 / 70 assertions** and both earlier counterexamples became passed:false,
  verification:0, quality:0.75. Current epoch **3** identities are materializers save
  **@3** / deadlock **@2**, scorers **@7** / **@3**, hashes `337da8e067ae6924` /
  `df40997dd5901e0b`. The separate explicit disposable-DATA_DIR probe remains
  rejected before dispatch; no substitute runner/session was used.

  Main's independent source-only review identified a remaining temporal gap: the
  exact tasks require original-source observations **before editing**, but the
  first-phase scorers could still give full credit from evaluator replay after the
  edit while allowing reconstructed/not-executed pre-fix prose. The owner confirmed
  that mismatch and completed the honest blocked/partial repair: both materializers
  have explicit readiness blockers, and both scorers always return passed:false /
  verification:0, with quality capped at **0.75** for genuinely verified post-edit
  checks. Actual before-dispatch original-source observations must be bound
  immutably and supplied publicly before full qualification can become possible.
  Final blocker/assertion tests subsequently recovered on the owner's exact original
  normal-permission command: **9 / 0 / 87 assertions / 1.81 s**. This verifies the
  fail-closed source gates, not the missing prerequisite or model qualification.
  That owner obtained no scoped typecheck and checked whitespace only before the
  final blocker edits. Main subsequently ran the configured backend `tsc --noEmit`
  under a private credential-free HOME: **exit 0**, no diagnostics. Final scoped
  whitespace checks also passed. This is static validation, not execution of the
  still-denied packaging suite/build recipe. Source-derived final with/without request sizes are
  **17,941 / 10,171** and **17,125 / 9,355 bytes** (earlier measurements plus the
  exact added paragraph/JSON escaping); these are calculated deltas, not a completed
  final runtime remeasurement.

  A separate retained agent performed source-only design, no execution or edits:
  the paired runner has an insertion point between pristine materialization and
  arm dispatch, but current APIs lack trusted per-call original observations.
  A future fixed evaluator-owned probe must bind source/driver/output identities,
  unchanged base fingerprint, immutable host context and frozen identical public
  input to both arms and durable anonymous review evidence. Candidate JSON,
  reconstructed historical receipts and timestamps alone cannot establish authority
  or chronology. Current contracts remain blocked; preserve their literal task
  requirements, byte limits and honest simulation/cleanup scope. No instrumentation
  implementation or probe execution has been performed. A stopped accidental
  code-review child produced no findings/tests/edits and is not an independent approval.

High-use native preparation independently measured all eight debugging,
authorization, API-contract and concurrency scenarios below the **24,000-byte**
request cap; debugging task-1 **@3** was **11,715 with-skill bytes**. Ten data/
visualization/TypeScript scenarios also passed readiness and size preflight;
capacity scorer **@10** was **9,098 / 6,091 bytes** for the two arms. These are
preparation/availability observations, not candidate success.

A subsequent independent API task-2 preparation revalidated package **5.1.8**,
epoch **3**, hash `ee028c30155a6a3d`, materializer **@2** and scorer **@5** through
the actual initialized registry and current-contract helper. The controlled
five-file snapshot measured **4,364 bytes**; host-declared native requests measured
**7,528 without-skill / 17,666 with-skill bytes**, leaving **6,334** with-skill bytes
under the candidate cap. These measurements reproduced the published format without
calling the then-changing reader, not upstream wire serialization. Version-only
native preflight accepted **2.1.309** with explicit API-key presence; it did not
qualify authentication/generation/transport. The maintained defective-fixture test
passed **1 / 0**, while the real scorer rejected original behavior on **3 hidden
checks** (insert continuation, cursor tampering, legacy enum restoration). This is
not repaired-candidate proof or full public-matrix evidence. Source/normative input
were restored and disposable fixtures cleaned. Main's ensuing normal-permission
API task-2 campaign attempt was rejected **before dispatch** by the classifier
timeout: no generation, pair/archive or ledger write launched. Main still owns
actual runtime-revision validation and serial qualification.

A peer's claimed
TMPDIR-containment blocker was contradicted by `isContainedBy(root,target)` and
the actual successful temporary-workspace native control: the guard rejects a
workspace containing TMPDIR, not a workspace beneath it. The preparation owner
independently checked both helper directions and explicitly retracted the
incorrect global-blocker conclusion; no guard change was made. Do not reverse or
weaken the guard. Root's configured `bun --no-env-file run typecheck` gate
(`b4nhd3quf`) subsequently exited **0** for **backend and MCP**; the frontend has
no matching `typecheck` recipe in that gate, and this does not execute packaging
tests or cover every outside-build-script root. The public-capture owner was still
finishing a separate patch, so keep their final verification separately scoped.

The importer's bounded read-only current-source snapshot at
**2026-10-23T20:06:32.533Z–20:06:35.616Z** used a temporary trusted scanner with
`listSkills()` seeding removed; product source was not modified. Ledger bytes/hash
and source identities were stable across that observation. Complete exact-current
eligible pairs were:

| Promotion package | First full task | Second full task |
| --- | ---: | ---: |
| debugging | 0 | 2 |
| deterministic-debugging | 1 | 1 |
| authorization-security | 2 | 2 |
| api-contract-design | 1 | 0 |
| concurrency-debugging | 0 | 0 |
| data-pipeline-engineering | 2 | 3 |

All **14** pairs passed manifest/output/public-contract/full domain-tagged snapshot
binding. This is not 14 assignments, semantic success approvals or promotion credit.
No observed pair was a `gpt-6.1-sol` native pair. Current epoch **3** missing-pair
contracts remain debugging task-1 (`cb86523a898e12ad`, scorer **@3**), API
cursor-pagination task-2 (`ee028c30155a6a3d`, scorer **@5**) and concurrency task-1/
2 (`7195509df3f6f7ce` / `804bd908bd924b37`, scorers **@6** / **@2**).
Revalidate actual current identities before later execution or review; do not use
this momentary snapshot as a fresh inventory or a guarantee against future writes.

A separate next-common-batch read-only snapshot succeeded at
**2026-10-23T20:53:39.968Z–20:53:43.946Z**, with unchanged ledger digest and stable
tracked registered skill sources, selected sidecars/tasks and installed sources
across that observation:

| Promotion package | First full task | Second full task |
| --- | ---: | ---: |
| testing-engineering | 2 | 2 |
| security-review | 2 | 1 |
| refactor-implementation | 2 | 2 |
| typescript-javascript-engineering | 1 | 1 |

These are **13 complete eligible pairs / 26 arms** with durable anonymous source
bindings, not new assignments, blind adjudications, semantic approvals or promotion
credit. `security-review` is the actual secure-code-review package; no generic
code-review package was invented. No `gpt-6.1-sol`/`native-cli` source pair appeared
in that batch. Historical Codex/OmniRush/OpenCode evidence was read only; no new
Codex quota was used. Both complete TypeScript candidate runs record **passed:false**
(task1 baseline true; task2 baseline false); eligibility is not successful
qualification. Current epoch-3 task hashes from that observation are:

| Exact task | Contract hash |
| --- | --- |
| testing-engineering-full-task-1 | ec940672d36da692 |
| testing-engineering-full-task-2 | 89721e34206e19f7 |
| security-review-full-task-1-individual | 6ad7cd861b638377 |
| security-review-full-task-2-individual | a0f5b3743db13d8b |
| refactor-implementation-full-task-1-individual | 96f49f2b2ef6de90 |
| refactor-implementation-full-task-2-individual | ca7f93fc1f6d4a36 |
| typescript-javascript-engineering-full-task-1-individual | 68b46e33eac57f30 |
| typescript-javascript-engineering-full-task-2-individual | 8f6c90c56ace13c7 |

The separate **20:55:16.587Z** exact-ID follow-up confirmed that all three apparent
missing baselines exist with **provider infrastructure failures**: refactor task1
comparisons `433d7b28-e52e-4f78-a188-98677e87e89f` and
`f28c7353-9c37-4a62-8570-d72910ed0abd`, and TypeScript task1 comparison
`e614064a-3625-4867-a0df-20c5b285a8c3`. These are not complete eligible pairs;
never stitch baselines across comparisons or count the candidate alone. Ledger
digest remained unchanged in that follow-up. The correctly invoked two-file
importer tests subsequently passed **154 / 0 / 323 assertions / 969 ms**, with
scoped types/whitespace clean.

Preserve the separate accidental broad run (`b6l9kadhk`): the owner's first Bun
invocation routed into the backend package test script and forwarded the importer
paths to repeated backend children. They stopped it; it is not a settled or scoped
suite result. Main read retained lines **60638–60662**: the browser-plus-two-importer
child actually reported **158 passed / 1 failed**, with the genuine failure
`real importer validates fresh native evidence without persistence then retains all
evidence on isolated successful ingestion`. That failure is not erased by the
later standalone **154/0**. The final marker named `skill-eval-bun-runtime-fixtures`
but had no confirmed child output before SIGTERM. The owner found no embedded-
contract-suite marker/output anywhere in that run, which stopped before that
alphabetical position; the denied packaging proof remains unexecuted. The narrow
owner's intentional one-browser-`--file` plus two importer targets subsequently
reproduced **131 passed / 28 failed / 159 tests**: the fresh HOME's missing inherited
skills directory was being canonicalized by the mock importer harness. The earlier
158/1 failure was protected-root deny coverage, not scorer/typechecking. A narrow
fixture-only repair in `scripts/blind-review-native-import.test.ts` now creates each
mock importer child's private HOME/data/config/skills/temp roots through the existing
closed-environment builder and binds receipt/profile coverage to those exact child
roots. Two new regressions retain positive validation/no-persistence assertions for
missing ambient paths and unrelated ambient `/` roots/fake credentials. Production
verification, assertions and timeouts are unchanged. The owner's post-fix exact
three-file run was classifier-unavailable **before dispatch**; final runtime
verification is pending, so neither real failure is erased. The exact offending root
behind the historical line-183 refusal was not recorded: do not claim that historical
failure is independently proven resolved. Alias/ambient-aware importer `noEmit`
types and scoped whitespace passed after the fixture patch; these static checks are
not runtime proof. Main reviewed the new private-root/environment/receipt binding
source without executing the rejected tests. The initial reproduction had also
used a verified CommandLineTools directory; the final blocked invocation omitted
`DEVELOPER_DIR` after main clarified the provisioned selectors. No denied test was
rerouted and no broad scan/packaging/model/central ledger action occurred. The owner
has completed their handback; no importer test process remains running.

Native reviewer preparation independently selected the exact eligible second
debugging pair `debugging-full-task-2:ecbb75f0-2ee9-47ba-9ca5-d3e90c6de33c`,
assignment `blind-v5-5a084fe47904d3034ccd`, current epoch **3**, contract
`20e3e0f3750d4368`, cancel-complete-race materializer/scorer **@1**. The actual
candidate mode is **opencode-stateless-text-patch**, CLI **2.0.32**,
`stateless-generate-v1`/text-only/no-local-tools, not quarantined legacy
`opencode-text-patch`. Current-revision/eligibility/durable anonymous bindings
passed with no exclusions; archived task text matches current source (**848 bytes**)
and both READMEs match (**534 bytes**). `contract.json` remains explicitly absent
and must not be reconstructed. The fresh anonymous prompt measured **55,658 bytes**;
the declared `gpt-6.1-sol` reviewer request measured **58,878 bytes**, below its
separate **128,000-byte** cap. These are in-memory preparation checks, not a native
review or signed upstream proof. No prepared seal existed for that assignment.

Main read the actual native launcher and archive-finalization sources. The reviewer
owner provided an **instructions-only, unexecuted** task2-pinned host stage route:
revalidate current source/revision/pair, exact seal/artifact/prompt/request hashes,
bounded no-follow/nonblocking prompt reads, measured no-tools CLI plus the actual
macOS private-root profile, raw-stream/profile/four-reference archives, then
`--validate-only` with native-stage opt-in. It must never auto-ingest or substitute
for missing task1 qualification. The ordinary first `--prepare-only
--skill=debugging` command was rejected **before dispatch** by the classifier
timeout. No seals, native reviewer process, stage archives or ledger writes were
created by that attempt; the proposed subsequent host stage was not executed.
Campaign queue ordering cannot pin a pair/scenario, so do not assume a one-assignment
campaign chooses task2 after a later task1 qualification.

Previously truncated outputs were inspected. The old root run ended with
**SIGTERM**, without a backend aggregate. The later old frontend run actually
reported **1 failed / 187 passed files, 1 failed / 1,417 passed tests** in
`FeedEntry.variant.test.ts`; the current checkout already resolves that failure:
a fresh focused run passed **8/8**, and the fresh complete frontend suite passed
**188 files / 1,418 tests**, exit **0**, without changes or weaker assertions.

Fresh focused native checks:

- Skill-package and skill tests: **92 passed**, 2,879 assertions; preserve the
  distinction between 182 V5 packages and the two runtime-only critic controls.
- Git/session-workspace residual group: **43 passed**; follow-up chat Git and
  confinement controls: **29 passed**. A new real regression checks import of a
  newly created source commit using read-only source roots and denial of source
  Git-configuration writes. Existing source index/configuration and sibling HEAD
  remain unchanged. Previously reported Git error translation assertions pass.
- Performance-debugging fixture file: isolated native rerun exit **0**; no source
  change was needed for its old Linux failure.
- `bun run typecheck` and `git diff --check`: exit **0** before the latest pending
  agent patches. Recheck after all patches finish.

The new native `CI=1 KORY_RUN_LIVE_PROVIDER_TESTS=0 bun run test` completed:
**frontend 188 files / 1,418 tests**, **MCP 30 files / 496 tests**, and
**backend 522 files passed / 2 failed**, root exit **1**. The session-workspace
failure loaded a transient sandbox edit (`realpathSync is not defined`); the
completed canonicalization repair has since passed adjacent controls and the
exact isolated file passed **7 tests / 42 assertions**, exit **0**. The other failure was `skills.test.ts` returning null
for a retained incompatible bundled resource under the root workspace-filter
launch. A deterministic incomplete-writable-data contamination regression reproduced
that defect. Bundled discovery now uses the explicit source-relative asset root
when present, resolves registered generated defaults before file resources, and
rejects invalid resource names. Unknown personal files are not bundled, incompatible
Codex resources remain unavailable, and packaged fallback does not infer HOME.
The settled native workspace-filter rerun passed **93 tests / 2,889 assertions**
(skills **72**, packages **21**), with backend typecheck and scoped diff check exit
**0**. The complete root rerun (`ba0q1k7fo`) finished with **frontend 188 files /
1,418 tests**, **MCP 30 files / 496 tests**, **backend 523 files passed / 1 failed**,
root exit **1**. Both prior failures now pass. The sole failure was the authored dash
debt ratchet in `skill-prose-quality.test.ts`, triggered by the new CI/CD and frontend
source prose. The source wording repair has since passed **10 tests / 426 assertions**,
with unchanged baseline/assertions; targeted package/static checks remain clean.
The subsequent complete rerun (`b35b22vaz`) again finished **backend 523 passed /
1 failed**, with frontend and MCP green, root exit **1**. The prose ratchet now
passes; the sole failure is Freebuff's oversized/malformed-body and redirect control
hanging at its unchanged **60,000 ms** timeout. The narrow diagnosis reproduced
**8 passed / 2 skipped / 1 failed**, locating the hang after the oversized **413**
while the next malformed request never reached the handler. Repeated affinity
HTTP **400** failures interrupted source diagnosis. Consuming each response body
alone passed one exact isolated run but then failed a separate full-file repeat at
**60,004.10 ms**, with **8 passed / 2 skipped / 1 failed**. The short-lived relay
fixture now also sends an explicit default `connection: close`; three separate
isolated full-file processes then each passed **9 tests / 2 existing Docker skips /
78 assertions**, exit **0**, in **607 ms**, **588 ms**, and **535 ms**. The test's
macOS skip uses the shared platform helper. These are measured fixture lifecycle
controls, not a conclusively established Bun root cause or a production transport
repair. No timeout, isolation or fixed-route assertion has been weakened.
Do not label any prior root exit **1** green or erase historical failure outputs.
The fresh full workspace run (`bj1b2mikb`) completed with **backend 525 files passed /
1 failed**, **frontend 188 files / 1,418 tests**, **MCP 30 files / 496 tests**, root
exit **1**. Freebuff passed. Its sole failure was an initialization error in
`skill-eval-agent-behavior.test.ts`: `Cannot access
'SKILL_AUTHORING_EVALUATION_MATERIALIZERS' before initialization` while importing
`skill-eval-fixtures.ts`, **0 passed / 1 failed / 1 error**. It loaded source around
**17:32**, before the later startup-safe lazy registry repair. The run began during
source changes and is concurrent integration evidence, not verification of the
final checkout. The exact isolated behavior file passed **12 tests / 14 assertions**
at **17:56**, exit **0**, without edits or weaker assertions, after startup-safe
registry loading. Rerun settled whole-workspace verification after the packaging
owner finishes.

The coordinator's bounded native public no-op control was again rejected **before
dispatch** by the temporary safety-classifier timeout. It produced no native
session, event archive, generation or promotion evidence. Do not route blocked
calls to peers or change credentials, permission mode, router or settings.

Read-only sandbox grants now reject ancestor/descendant/equal writable overlap
and private-scratch overlap, using canonical paths and shared containment.
Actual macOS kernel controls verify committed-object import while denying source
file/config/ref writes and symlink escapes: **94 scoped tests**, **169 adjacent
security tests**, and **71 follow-up Git/sandbox tests** passed without skips.
Selected environment/browser controls passed **37 tests in 4 files**, including
real Vue/Next runtime, React Chromium inspection, and independent visual evidence.
Generic reviewer diagnostics passed **40 tests / 215 assertions** and now report
executable availability separately from unverified route/isolation; diagnostics
perform no reviewer dispatch or ingestion. The stricter JVM and novel-UI caller
startup deadline repairs passed final scoped verification: **JVM/Ruby 3 passed,
1 explicit unavailable-Java skip**, and **novel UI 6 passed**, no failures.
Novel UI startup/retry/evaluation share one caller deadline; a real sleeping
launcher settles around **1.05 s** and the unchanged nontermination **<8,000 ms**
assertion passes around **2.13 s**. Typecheck and whitespace checks passed.

OpenCode's source-inspected stateless free-router smoke returned the exact
`KORY_STATELESS_OK` response. A different advertised free route rejected the API
call with `ServiceUnavailableError`; it is not a fallback. The bounded serial
fresh campaign for **debugging task-2** and **data-pipeline-engineering task-2**
completed using only `opencode-stateless-text-patch`, `openrouter/openrouter/free`,
120,000 ms per arm. Debugging's candidate passed real hidden state-machine checks
and public regression tests (quality/verification **1**), with baseline patch
contract failure retained. Pair `debugging-full-task-2:ecbb75f0-2ee9-47ba-9ca5-d3e90c6de33c`
closed its open regression; debugging now needs only independent blind review.
Pipeline pair `data-pipeline-engineering-full-task-2-individual:da16fa5f-0077-4d48-a00a-0120f8099b6d`
had an incomplete timed-out candidate and a failed baseline; its regression remains.
Campaign exit **1** means one completed and one infrastructure-failed scenario.
Local timeout cleanup does not attest upstream cancellation or model identity.
No historical failures were deleted or relabeled. A named free-route smoke on
`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` returned the exact stateless
control, then a bounded 180,000 ms serial pipeline/TypeScript regression campaign
completed with exit **1**. Pipeline pair
`data-pipeline-engineering-full-task-2-individual:f82246f9-b843-472f-a3a5-7c1e55b574fb`
completed with candidate and baseline both failing, without infrastructure or
integrity failure. Both applied two valid patch operations and passed both hidden
behavior tests (**2 tests / 10 assertions** per arm), but omitted required repository
regression tests. Candidate evidence additionally missed JSON commas, so strict
parsing could not validate compatibility/provenance or hierarchy evidence; quality
was **0.5**, verification **1**, versus baseline quality **0.75**, verification **1**.
Existing skill/verification instructions already require the missing delivery
checks; no verified source defect warranted tailoring the package to this fixture.
TypeScript pair
`typescript-javascript-engineering-full-task-1-individual:e614064a-3625-4867-a0df-20c5b285a8c3`
had a completed candidate task failure and an incomplete **baseline** infrastructure
failure. Ledger diagnosis shows the candidate CLI exited **0** after **117,043 ms**
with a **10,499-byte** response containing three standalone JSON objects instead
of the strict patch block/array, plus an unsupported claim of running tests. The
baseline exited **1** after **567 ms** with a **129-byte** incomplete response;
provider diagnostics are discarded, so its precise upstream cause is unknown.
Both requests were below the unchanged **24,000-byte** serialization bound. Isolated
stateless executor controls passed **72 tests / 742 assertions**; no demonstrated
local defect or source changes were found. Neither outcome is promotion credit. Campaign reporting now exposes per-arm
infrastructure flags and prefixes failed details; the exact candidate-semantic /
baseline-infrastructure case passed focused **4 tests / 16 assertions**, with no
execution, persistence, retry or gate change. A subsequent authorization/API/
concurrency campaign stopped after authorization pair
`authorization-security-full-task-1:a2195dc3-f4b2-4d95-89a9-e89016067e58`: candidate
timed out at the bounded budget and baseline provider execution failed; both arms
were infrastructure failures, **3 queued scenarios were not started**, exit **1**.
No prompt/result failure was converted into success. OmniRush reports **tokens_left:
0** from the weekly quota despite renewed daily allowance; no new OmniRush
inference was submitted in this continuation.

Read-only independent-review revalidation found **290 eligible pairs**, **215
awaiting review**, **75 existing reviews skipped**. All sixteen staged generic
artifact hash sets match; thirteen pass current importer validation with
**persistedReviews: 0**, while backend-engineering, application-security, and
cicd-engineering are stale. **None were ingested.** Ordinary OpenCode reviewer
runs still lack enforced isolation. OmniRush now reports a running ready VM, but
that is not session-specific blinded reviewer isolation or provenance. Native
fork task IDs also do not prove blind input or tool prevention. A fresh,
non-inheriting sealed-prompt-only reviewer with qualified prevention and
host-observed identity/completion remains required. Planning has one eligible
pending pair; debugging, data-pipeline-engineering, and data-visualization each
have two. Data-visualization now has two eligible full-task pairs and still needs
independent review. Native reviewer experiments are **unqualified**: pure read
allowlists aborted both positive and negative child controls, so those results do
not demonstrate prevention. Broad runtime reads with canonical private-root denies
passed canary denial and allowed-write controls, but the native tiny supplied-input
smoke exited **1** with no init/session/result/completion evidence. A separate
credential-free argument control emitted an `unrecognized_model` warning for
`gpt-6.1-sol`, but still produced an init with **tools/MCP servers/skills all empty**.
Its result had subtype `success` **and `is_error: true`**, reporting `Not logged in`,
with exit **1**. A success subtype alone is not a successful completion. The warning
does not establish model rejection as the cause of the sandboxed smoke failure;
these controls prove no inference, full reviewer isolation, or upstream identity. No router/auth/settings change was made and no
native review was ingested. A fresh public-only API-key smoke subsequently completed
in **4.0 s**, with empty tools/MCP/skills init and exact true successful result;
that unsandboxed smoke alone is not reviewer isolation. A credential-free kernel
startup diagnosed `EEXIST: mkdir '/tmp/claude-501'`: the pinned CLI uses
**CLAUDE_CODE_TMPDIR**, not only TMPDIR. Pointing that selector to the private root
restored bootstrap without broadening host temp access. The exact canonical private
root deny policy then passed negative read/write canaries and allowed-write controls,
plus a public-only native smoke in **4.9 s** with true successful completion and
empty tools/MCP/skills. Reads remain broad runtime reads plus explicit private-root
denies, **not a universal file allowlist or upstream identity attestation**.
A distinct native stage-only adapter passed its initial **47 tests / 159 assertions**.
Opt-in production kernel mode (`KORY_NATIVE_REVIEW_STAGE_SANDBOX=macos-private-roots`)
now enforces canonical private/protected-root denies, private-only writes, and actual
source/evaluation/credential/symlink canaries with a positive credential-free native
bootstrap control. Receipts retain **osIsolationVerified: false** because this is
explicit-root confinement, not global filesystem blindness. Actual sealed packets
are **39,799** and **62,809 bytes**; the native reviewer has its own bounded **128,000**
raw/host-serialization limit without truncation. OpenCode and native qualification
request limits remain **24,000**. A real public synthetic A/B control initially failed
while tiny controls passed. Direct live classification proved the native CLI emits
an initial `redacted_thinking` assistant envelope before one final text envelope.
The parser now accepts only the validated opaque thinking prefix, then exactly one
text/result binding; tool/unknown/mixed blocks and error results remain rejected.
No thinking data is decoded, used or published. Subsequent fixture/kernel controls
passed **110 tests / 547 assertions**, strict typecheck/diff check; a broader final
reviewer/campaign group passed **179 tests / 822 assertions**. The repaired synthetic
kernel A/B control timed out at **120,033 ms**, with no completed envelope, and is
retained as unqualified. The subsequent actual complete sealed debugging assignment
`blind-v5-b420ad1a502ea95b5f1f` completed **stage-only**, bounded to **180 s**, one
attempt, **no ingestion**. Session `native-cli:b282ff0c-0954-493d-890c-9d238d67b630`
returned a valid adjudication: **both artifacts failed**, preferring B's clearer
separation of expected and observed evidence. It found missing observed starting
reproduction and invalid-then-valid configuration recovery; correct post-fix
behavior alone did not satisfy the full debugging contract. The prompt hash remained
`e88ef69e8a06ffe6c92c424365a73809dae72c1cc2598aa815a28be1ac801a31`; archived
host receipts describe empty tools/MCP/skills and the actual canonical protected
roots/profile. Current importer validated **1**, persisted **0**; independent
source/receipt/kernel-boundary audit remains required before any ingestion. Latest
parser provenance guards reject non-null parent-tool origins and bind supplied
startup invalidation sessions to init: **115 tests / 553 assertions**, strict types
and scoped diff check passed. A native qualification executor is under source/test
engineering with explicit selection and native-specific fail-closed receipt
eligibility. The settled coordinator test group passed **125 tests / 1,353
assertions in 4 files**, exit **0**, including actual protected raw-stream archival
and completed semantic-false arms. Targeted agent typechecking reported **0
diagnostics**; that is not a full-project typecheck. Fresh independent engineering
review then reproduced and fixed two defects: file-content Markdown fences were
rescanned as extra patches, and a symlinked archive parent could redirect raw
transport into the opposite candidate workspace. Canonical whole-pair containment
and exact actual-Buffer archive binding now precede persistence; eligibility
independently verifies the manifest's `nativeTextEventArchive` binding. The final
owned test group passed **128 tests / 1,403 assertions**, exit **0**, and the scoped
eight-file compiler check reported **0 diagnostics**. Missing new bindings are
excluded by the derived view, without editing history. No live qualification using
this executor has run yet; explicit native selection must never fall through to
Codex. A new public no-tools control has **not** executed: repeated scratch-script
Write attempts and the independently submitted direct control Bash invocation were
blocked before dispatch by the tool safety classifier's temporary GPT 6.1 Sol
timeout. Do not bypass this boundary, change router/auth/permission settings, or
claim a failed dispatch as runtime evidence. The second
sealed stage, data-visualization `blind-v5-a4c103593502cbf4405b`, also completed under
`native-cli:c0b3ee46-c8bd-454a-b04d-63da482a4d4d`, with validated **1**, persisted **0**.
It scored A **false** and B **true**, preferring B, while flagging possible host gap
policy/scorer and artifact-digest discrepancies. Separate source investigations
must verify those claims; they are not automatically defects or promotion credit.
The independent stage audit has confirmed that **both stages remain unqualified**:
actual native init/assistant/result bytes were hashed in memory but not archived,
so historical observed completion cannot be independently replayed. Import currently
retains assignment/output rather than kernel/runtime receipts. These stage artifacts
must not be retroactively repaired, ingested, or counted. Protected actual-stream
archival and durable provenance retention are being repaired with focused tests;
future reviews must run fresh. A concrete visualization lexical gap-policy false
negative was separately reproduced. The audit's **96/96** recomputed bindings match:
snapshot before/after hashes use `sha256("file\\0" + bytes)`, whereas the scorer's
artifact digest uses raw bytes. Both domains match their archived source; the
reviewer's digest-discrepancy criticism was mistaken and must not be silently
rewritten. Future sealed prompts need the generic domain clarification. The audit's
initial kernel/reviewer controls passed **210 tests**; an additional eligibility run
observed **24 passed / 1 failed** during the owner's concurrent raw-archive repair.
The later settled native execution group passed as recorded above; the historical
failure remains intact. Fresh reviewer archival/campaign recovery implemented
protected exact native-stream/profile archival and the independent importer
handshake. An initial extensionless-import error produced **80 passed / 40 failed**;
the import was corrected to explicit `.ts`, and the final owned four-file suite
passed **161 tests / 678 assertions**, with targeted strict TypeScript and scoped
whitespace checks passing. Actual macOS archive read/write denial controls passed.
No live review or ingestion occurred.

Earlier importer recovery reported **223 tests / 451 assertions in 5 files**, but
four standalone transitive type diagnostics remained then. Fresh independent
review reproduced bounded/no-follow-read, current metadata/payload and durable
assignment defects and repaired them. Its later combined pipeline run passed
**443 tests / 1,267 assertions in 9 files** with aliased/ambient-aware TypeScript
clean, before final parent-directory fsync and post-read parent-protection rechecks.
After intervening safety-classifier timeouts, the owner's final complete importer
rerun passed **151 tests / 314 assertions**, with final focused TypeScript and scoped
whitespace checks clean. The archive/importer handshake is confirmed; no historical
stream was reconstructed and no real review was ingested.

The visualization capacity scorer's lexical gap-policy false negative was repaired
under new contract **@9**. Agent regression verification reported **43 tests / 202
assertions** across evidence and conversion suites; the coordinator's attempted
follow-up used a nonexistent conversion filename and ran only **17 tests in one
file**, not the whole group. Fresh disposable replay of the exact old A/B patch
bytes passed structured-policy checks and rejected negative gap corruption without
changing the saved files. This is repair verification, not browser/usability
evidence or promotion credit for the sealed **@8** pair. Independent review then
reproduced additional contradiction and static line-path defects and repaired them
under new capacity scorer contract **@10** (materializer remains **@4**). The final
required isolated run passed **39/39 evidence-contract tests / 268 assertions** and
**26/26 visualization-conversion tests / 79 assertions**, both files green; scoped
whitespace check passed. A backend typecheck attempted during the debugging owner's
active replay refactor reported only those out-of-scope transient diagnostics.
The debugging owner subsequently reported a settled whole-backend TypeScript
check exit **0**, plus an owned-entrypoint scoped check exit **0**. This supersedes
the transient diagnostics, not their historical outputs; **@10** still requires
fresh qualification.

Debugging's empty-plugin scorer now uses new contract **@2** after real false
positives were reproduced: unchanged starter tests and a keyword-only unobserved
report could pass, and invalid-input poisoning escaped the previous recovery
check. The repair requires changed candidate-authored regression bytes, actual
starter CLI reproduction, green candidate tests, red tests against only the owning
starter source, corrected CLI execution, and invalid-then-valid recovery. Receipts
explicitly describe independent **post-response harness-owned replay**, never
candidate-observed history. Agent checks reported **9 debugging/scorer tests** and
**11 fixture-integrity tests**, all passing. Replay confinement and source correctness
were then independently reviewed. That review reproduced submitted-source mutation
by public tests, startup credential inheritance, nondiscovered/duplicate selected
tests, red-failure display truncation, incorrect successful CLI-output acceptance,
and defeatable soft termination. The fixes use bounded pre-execution snapshots,
phase-by-phase integrity checks, discovered unique tests, real bounded CLI output,
and hard-killed 15-second subprocess deadlines. They do not claim an OS sandbox.
The final empty-plugin scorer contract is **@3**, not the in-flight **@2**. Final
scorer/integrity/performance-debugging controls passed **31 tests / 145 assertions**,
exit **0**, with whole-backend and honest scoped TypeScript checks passing. An
earlier broader group passed **45 tests / 786 assertions** before the final
enumeration-bound/identity adjustments. Only the deadline regression has a local
25-second allowance; global timeouts remain unchanged. Neither new scorer contract
retrospectively upgrades historical failures; fresh qualification is required.
Planning preparation skipped **1 existing review**, queued **0**, without replacing
its historical failure. A distinct pinned OpenCode stateless stage adapter and shared strict JSON
parser passed **64 tests / 362 assertions**, with source-reinspected no-local-model-
tool dispatch, but ambient base config/provider hooks remain an unqualified trust
boundary. Both adapters explicitly mark unsigned/stage-only and upstream identity/
cancellation unverified. No actual blind review from them has been ingested;
coordinator forks are not their reviewers.

Three narrowly scoped authoritative-source corrections were verified against
actual official Markdown pages: fine-tuning new-job creation ends **2027-01-06**,
not the separately listed **2027-01-14** GPT-4 inference shutdown; Cloudflare's
six-connection quota counts connections waiting for response headers, not body
streaming after headers; speech retirement dates now cite the separate deprecations
source rather than attributing dates to the model catalog. Existing verification
dates and promotion gates were preserved; fresh static audit remains exit **0**.
A further official-source audit corrected application-security's WSTG **4.2**
destination and obsolete redirect claim, frontend-engineering's distinction between
Android app-window sizing guidance and Kory's representative test matrix, and
cicd-engineering's GitHub plan/visibility/custom-rule-preview restrictions and
GitLab Premium/Ultimate protected-environment scope/authorization. Only the four
actually corrected source entries were reverified on **2026-10-23**; backend sources
needed no edits, and title-only Apple HIG content was not counted as substantive
verification. All four packages validated with zero errors/warnings and targeted
static issues/stale sources; no empirical promotion evidence was created.
Reviewer/runtime/source subagents hit repeated upstream encrypted-content-affinity
HTTP **400** errors. The coordinator recovered partial patches without changing
router configuration, permissions or credentials; recovery agents are engineering
work, never independently blinded evaluator evidence.

Keep the self-paced continuation active while useful local repairs,
qualification, or verified reviewer-route work remain. Stop only at **182/182**
or a concrete external prerequisite requiring the user's decision.

## Latest test continuation (2026-10-22)

### Persistent coordinator directive

**Do not stop at a milestone. Continue the Koryphaios V5 campaign until all
182 promotion-catalog skills are ready and promoted.** This is the active user
goal for every resumed session and compaction: preserve this directive, keep
working through local repairs, qualification, independent review, and report
regeneration, and stop only when the authoritative inventory reports **182/182
ready and promoted**—or when a concrete missing external prerequisite requires
the user's decision. Never convert blocked, insufficient, quarantined, stale,
or unreviewed evidence into promotion credit just to reach the target.

This update supersedes the unresolved-test list below. The latest exact
`bun run test` invocation was terminated by the shell's **300,000 ms outer
deadline**, not a reported assertion failure. Frontend completed **1,417 tests
across 188 files** and MCP completed **496 tests across 30 files**, both exit 0.
Backend was still progressing through fixture tests when SIGTERM arrived; its
final summary was never reached. **The full root gate remains unverified.** Do
not repeatedly restart the same full run within that deadline or report it green.
Continue the remaining backend checks in bounded file selections through
`scripts/test-backend-isolated.ts --file ...`, preserving per-file isolation.

### Continuation after the latest compaction

The coordinator continued without stopping. The current generated inventory at
`2026-10-22T17:35:19.510Z` reports **105 ready / 59 blocked / 18
insufficient-evidence**. Data-visualization now has **2/2 full tasks and 1/2
eligible paired baselines** after fresh OmniRush text-patch candidate runs;
legacy OpenCode evidence remains excluded. Data-pipeline-engineering remains
blocked because a fresh task-2 candidate regression is recorded, despite its
existing 2/2 pairs.

Focused backend checks completed in this continuation:

- External environment fixtures: **2 passed, 4 explicit skips** without asset
  selectors; selected browser assets: **6 passed, 0 failed**.
- OpenCode stateless adapter: **72 passed, 0 failed**; oversized serialized
  requests are rejected before dispatch because the CLI exposes only an argv
  request body.
- F/G/H backend shard: **8 files passed, 0 failed**.
- I backend shard: **6 files passed, 0 failed**.
- Typecheck and `git diff --check`: passed.

The long-lived root run also exposed one real frontend-suite timeout in the
older checkout state: `frontend/src/lib/stores/providers-beam.test.ts` timed out
while importing a store-only test because it unnecessarily loaded Testing
Library setup/cleanup. That unused DOM setup was removed; the focused Beam test
now passes **6/6** repeatedly without changing global timeouts or production
code. The already-running root process predates this repair, so its recorded
frontend exit 1 is not a verdict on the repaired test. Its backend shard is
still running and should be allowed to finish for diagnostic coverage.

The authenticated OmniRush route is available as `omnirush 2.5.3`, with the
account's remaining daily allowance recorded privately by the CLI. It was used
only for fresh candidate qualification, not blind-review credit. No Codex quota
was used. The OpenCode free-model routes tested directly returned HTTP 503, so
they are not treated as a reliable route.

A complete root test is now running outside the five-minute tool deadline:

- PID: `92376` (and its child processes)
- Log: `/var/folders/kf/5y26484x0571_3cq5b2hfk3w0000gn/T/agent-tmp/kory-root-test-20261022.log`
- Environment: `CI=1`, live providers disabled, runtime asset selectors unset

Do not kill or call this run a pass until its backend summary and root exit are
observable. Continue checking the log while advancing qualification and local
repairs; the 182/182 directive remains active.

Implemented and checked in this continuation:

- Swift fixtures now share a bounded known-good compile/run readiness probe in
  `backend/src/kory/skill-eval-swift-runtime.ts`. The default host SDK/compiler
  mismatch is reported as unavailable, not credited as a successful red control.
  Explicitly selected toolchains retain strict assertions. The two Swift scenarios
  are included in the real-runtime registration inventory.
- Browser tests explicitly skip unavailable runtime controls only when no asset
  directories were selected. Registration, unavailable-state, integrity, and
  mocked broker-lifecycle tests remain mandatory. Selected assets retain strict
  assertions, and Chromium readiness and launch now select the same executable.
- Missing C/C++ compilers retain an explicit unavailable diagnostic instead of an
  empty version banner. No compiler/browser timeout limits were increased.

Verification: native-runner and Swift-runtime unit tests **22 passed**; default
native fixtures **7 passed, 12 explicitly skipped**; selected-toolchain native
fixtures **19 passed, zero skips**. Browser checks without asset selectors:
**41 passed, 10 explicitly skipped**. Provisioned browser checks initially had
**50 passes and one Chromium launch timeout**. The unchanged four-test visual
verification file then passed on a focused rerun, including real 24-capture and
forged-review rejection controls; the earlier timeout remains a recorded flake,
not proof of its cause. Integrated `skill-eval-execution.test.ts`: **13 passed,
643 assertions**. `bun run typecheck` passed for backend and MCP.

Qualification is separate from these unit/runtime controls. The latest generated
inventory remains **105 ready / 58 blocked / 19 insufficient-evidence** (07:24 UTC
on October 22). No new promotion evidence was written by this test repair.
Legacy `opencode-text-patch` stays quarantined. The distinct version-pinned
`opencode-stateless-text-patch` transport has a no-local-tool-dispatch boundary,
not OS isolation, upstream model attestation, or acknowledged upstream
cancellation. Its tiny free-router smoke succeeded, but full paired attempts
still encountered provider failures/timeouts; a reliable fixed free-model route
and an independently completed reviewer remain prerequisites. No new Codex calls
are authorized. The earlier disclosed local commit `5830cbaa` remains unchanged;
this continuation made no commits or pushes.

## Current continuation: OpenCode boundary hold

This section supersedes the historical launch guidance below. **Do not use new
Codex quota.** Use local subagents or verified free-model routes only. Subagent
reasoning is not configurable through the available delegation tool; a recorded
campaign `reasoningEffort: none` is not proof of the model's actual reasoning setting.

The inventory generated at `2026-10-22T05:03:23.387Z` reports **105 ready,
58 blocked, 19 insufficient-evidence**. Static quality is clean; qualification
still exits 1. Reports remain in `outputs/skill-v5-promotion/`.

An OpenCode visualization candidate emitted native repository search events
despite its text-only contract. A preceding task-2 candidate passed deterministic
checks, but the archive lacks a full protocol/boundary receipt, so that result
cannot certify tool-free execution. Original runs, scores, and artifacts remain
unchanged. Do not delete failures or relabel old evidence as isolated.

Implemented safeguards:

- `backend/src/kory/skill-eval-opencode.ts` rejects structured provider errors and
  reported tool events before applying patches. Timeout settlement closes owned
  pipes and terminates the owned process group through the platform module.
- `scripts/kory-opencode-reviewer` also rejects errors and reported tool use,
  without printing raw diagnostics or tool payloads.
- Both workspace agents under `.opencode/agents/` declare wildcard deny-all
  permissions. `opencode debug agents` resolved a catch-all deny with no later
  allow rules for both. Existing running sessions must be restarted to pick up
  config changes; resolved config alone is not runtime isolation proof.
- `backend/src/kory/skill-eval-eligibility.ts` excludes all `opencode-text-patch`
  execution credit, including `tool-event-guard-v1`, from promotion, resume, and
  blind-review eligibility. Linked reviews cannot restore excluded pair credit.
  Historical observations are preserved, and exclusion reasons are visible.
- Campaign readiness blocks this executor before dispatch. A visualization
  dry-run confirmed zero queued scenarios. This is a temporary hold, not a new
  trusted-receipt scheme and not evidence that every historical run used tools.

Checks from this continuation:

- `bun run typecheck`: passed (backend and MCP server).
- Focused executor/reviewer/eligibility/resume/provider tests: **189 passed,
  0 failed**, 1,417 assertions across six files.
- `git diff --check` and `node --check scripts/kory-opencode-reviewer`: passed.
- `bun run test`: the latest run was **incomplete**, terminated at the
  300-second outer command budget while the isolated backend runner was still
  progressing. Frontend and MCP completed successfully; no backend assertion
  failure was reported before termination. Continue with bounded backend
  selections and a long-lived outer process rather than treating the partial
  root run as green.

Next: qualify an enforced, isolated no-tool runtime outside the evaluator
checkout, with negative permission canaries, session-specific cancellation, and
host-produced boundary receipts. Detection after a tool executes is not prevention.
Only then define receipt validation and re-enable fresh paired qualification.
Use an outer command budget that covers both sequential arms plus scoring and
persistence (a 300-second per-arm budget needs more than 600 seconds overall).
Do not remove the quarantine merely because a stub test or one model response
passes. Re-run affected scenarios under fresh pair IDs after qualification.

## Authority and current blocker

The independent semantic reviewer must be a **real, completed `chatgpt-web/...` turn** with a unique Codex thread ID and event evidence. The candidate's steward cannot review their own work. The V5 promotion checks in `backend/src/kory/skill-evaluations.ts` also require provenance blind to the skill variant, an exact current revision/contract pair, the registered skill display label, and independent evaluator identity. The coordinator alone owns `.koryphaios/skills/evaluations.json`. Do not run the importer with `--ingest` from this review task. **No new complete independently attested reviewer has been proven in this continuation.**

One earlier actual `chatgpt-web/high` review was attempted on the prepared factual-research assignment `blind-v5-87a28a224c533c166547` through the local browser bridge. The launcher preflight reported that another Codex browser turn was active and could not confirm readiness. The attempted Codex CLI turn encountered WebSocket HTTP 426, fell back to HTTP, then failed after retries with **`ChatGPT web turn is missing network access in trusted Codex environment context`**. The process emitted `turn.failed`, never supplied a completed adjudication, and generated **zero** independently attested review artifacts. Passing `sandbox_workspace_write.network_access=true` from the child CLI did not satisfy the trusted environment. Do not retry this identical configuration, fabricate trusted environment metadata, or bypass its trust check.

Read-only diagnostics on October 11, 2026 found Codex CLI `0.162.0` and `codex-chatgpt-web` `6.1.8`. The registered local Responses route `http://127.0.0.1:17841/v1` was installed, active and error-free. The Web doctor found the proxy and tunnel healthy but could not verify the launcher browser while it was running another Codex turn. It also warned that local checks cannot prove the ChatGPT connector is attached to the tunnel. The new campaign `--diagnose-reviewer` returned `routeVerified: true`, `browserBusy: true`, `ready: false`, `canAttempt: false`, `independentReviewerCompleted: false`, and trusted network context **unverified**. Local proxy health does not establish browser readiness, trusted network authority, or actual model identity.

## Read-only evidence

- An existing, genuine anonymous factual-research prompt is stored at `.koryphaios/skills/blind-reviews/pending/blind-v5-87a28a224c533c166547.prompt.txt`. It is 149,031 bytes, SHA-256 `5810108b0a23d730dfaedaef5eaecbbf7870ddd07f544b17fd5f907d61f9e534`, paired to scenario `factual-research-full-task-1-individual`. It compares passport-renewal fact checks with source availability and fallback evidence; the hidden assignment mapping must not be disclosed to the reviewer.
- An earlier `--summary --skill=factual-research` read returned **2 eligible current pairs, 0 existing matching reviews, 2 queued**. A broader earlier snapshot returned 182 V5 packages, 328 eligible pairs, and 166 campaign assignments at one per skill; those aggregate counts can change while the coordinator updates evaluations. They are not a synchronized promotion snapshot. A new attempt to retrieve the summary was blocked by automatic safety review when polling its read-only command. No completed updated summary was returned. **Do not retry that refused poll without explicit action-specific confirmation.**
- The central evaluation ledger changed between two read-only SHA-256 checks in this run: `67dc0acc7470d5f45ce5b1df97b3cdcee438e29f8284cc7111b5eb4831d317ee` and `b94490fc01e72d05faa1f2e74e3288fb196991846751ad2400dce91dd7ac596c`. No campaign ingestion was invoked, and the source of the concurrent change is unverified. Do not attribute it to a particular process or claim the global ledger stayed unchanged.

## Review-only procedure

`scripts/run-skill-v5-blind-review-campaign.ts` is now **stage-only by default**, and accepts `--review-only` for clarity. It explicitly rejects automatic `--ingest`. It prepares the anonymous assignment, seals prompt and private assignment hashes, and runs the independently configured reviewer only after the installed local route exactly matches the configured endpoint and the browser reports readiness. Live execution is serial; a trusted-network denial or missing browser readiness stops the remaining queue without retrying an infrastructure refusal for every assignment. The campaign no longer passes an ineffective child network flag or `--ignore-rules`, and never interrupts a busy browser turn.

A returned review requires one strictly parsed completed Codex event stream, a valid observed thread UUID, a matching final agent message **inside the completed turn**, and an adjudication with valid field types and score ranges. The envelope uses the exact observed thread UUID as `reviewer.agentId`, without inventing an agent name. The model and provider fields are identified as the CLI selection through the installed local route; the JSONL stream does **not** contain a separately signed model identity. Thread completion and CLI model selection alone are not proof of independently attested model provenance. For every candidate review the campaign invokes the importer in **`--validate-only`** mode before staging an attestation. The importer checks the prepared assignment against the current pair/revision/contract, reviewer identity versus the steward, rubric and source-evidence contradictions, and prompt integrity. Neither the campaign nor `--validate-only` writes a review record or the central evaluations ledger.

The staging directory is `kory-v5-blind-review-*` under the OS temporary directory. A candidate result contains `review-task.prompt.txt`, `reviewer-events.jsonl`, `import.json`, and `review-attestation.json`, with content hashes, observed thread identity, recorded model-selection source, and an `importValidation` record. These are **unimported evidence for coordinator inspection**, not promotion credit or cryptographic model attestation. Temporary directories are not durable archives; the coordinator should copy accepted artifacts to durable storage before any cleanup.

```sh
# Read-only route and browser diagnostics; no assignment preparation or review submission
bun scripts/run-skill-v5-blind-review-campaign.ts --diagnose-reviewer

# Resume only after trusted ChatGPT Web network access is repaired
bun scripts/run-skill-v5-blind-review-campaign.ts --review-only --skill=factual-research --max-assignments=1 --max-reviewer-attempts=1

# Optional read-only revalidation of a returned import envelope
bun scripts/run-skill-v5-blind-review.ts --skill=factual-research --validate-only=/path/to/import.json
```

The campaign no longer has an auto-ingest mode. The coordinator must inspect any genuinely completed review and invoke the separate importer on its own authority.

## Verification and next action

`bun test scripts/run-skill-v5-blind-review-campaign.test.ts` passed **35 tests / 185 expectations**, including route verification and spoofed-loopback rejection, busy browser preflight, dry diagnostics with no assignment preparation, serial execution and global trust/safety denial stops, automatic ingestion refusal, failed or mismatched importer summaries, incomplete/invalid/out-of-order reviewer events, invalid adjudication, altered source assignments, and duplicate thread IDs. The focused tests replace all reviewer and importer commands with isolated fakes; their passing results **do not establish a real review**. `scripts/tsconfig.cli.json` excludes these scripts, so the CLI typecheck is not evidence of their TypeScript type correctness.

Repair the trusted browser/Codex environment's network capability through its authorized host configuration, then perform one actual reviewer turn using the unmodified anonymous prompt and stage its event stream. If it completes, independently inspect its hashes, broker/model provenance, adjudication, reviewer/steward distinction, and read-only importer validation. The coordinator can then decide whether to ingest it. Until a genuine independently attested reviewer turn completes, **no new blind-review judgments or promotion credit are established**. Preserve the earlier infrastructure failure and unrelated dirty work.

## Continuation update (2026-10-17)

The coordinator added a provider-neutral adapter boundary for review-only campaigns. A
non-`chatgpt-web` adapter is now required to emit one JSON completion envelope on
stdout with `schemaVersion: 1`, a stable non-empty `reviewerId`, `completed: true`,
the exact adjudication string in `output`, and exactly two ordered events:
`review.started` followed by `review.completed`. The completion event must contain
the SHA-256 of `output`. The campaign records that adapter envelope as
`reviewer-events.json`; it no longer invents a UUID or synthesizes Codex JSONL for a
generic command. Provider/model remain metadata and do not establish independence.

Focused checks after this hardening passed: `37` campaign tests / `202` expectations,
`44` combined campaign and blind-review tests / `233` expectations, and backend typecheck. The generic
adapter path itself is only fixture-tested: no real provider-neutral reviewer command
is installed on this host (`omnirush` is not on PATH). The default ChatGPT Web
diagnostic currently reports `routeVerified: true` but `ready: false`,
`canAttempt: false`, detail `exit 124`, and trusted network context `unverified`.
Do not treat either diagnostic state as completed review evidence.

Three old pending V5 import envelopes (`blind-v5-c7fc5077d87023d57945`,
`blind-v5-ed59e14fe9cf8dd81e1b`, and `blind-v5-f41896a19bdaab179176`) were checked
read-only and all failed validation as stale exact current revision/contract pairs.
They were not ingested or deleted. The current audit snapshot remains `52 ready`,
`60 insufficient-evidence`, and `70 blocked`; the coordinator-owned ledger was not
changed by those validation attempts.

A bounded open-regression requalification was attempted for
`analytics-engineering-full-task-1-individual` with the available
`codex-text-patch` executor. The executor reached the provider but returned the
account usage-limit failure until **October 21, 2026 at 11:24 PM**. The failure was
persisted as infrastructure evidence and was not retried or converted into a pass.
The promotion inventory was refreshed afterward; counts remain unchanged and the
analytics package remains blocked by its historical open regression.

The source-quality audit was also refreshed against the current documentation for
the agentic-systems, aws-cloud, edge-cdn, finops-cloud-cost, mlops, and the AWS/
Cloud Run/Cloudflare portions of serverless-platforms, plus GPT-Transcribe. This
reduced stale-source warnings from 26 across 8 packages to zero. The final audit
reports `catalogErrors: []`, `catalogWarnings: []`, and static-quality exit `0`.
