# Koryphaios Skill Library V5 — Execution Handoff / Compaction

Use this file to resume the skill-quality program without needing the originating conversation.

## Goal

Execute `docs/skill-library-v5-masterplan.md` until all current skills are individually researched, rewritten where warranted, benchmarked, and qualified. The objective is measurable skill quality, not catalog size.

### Plan-mode repair — 2026-11-08

Chosen because it was the only non-ready skill whose remaining gate was pure measured skill quality: routing 1/1, two full tasks, nine paired baselines, one provenanced blind review, zero open regressions, both scenarios executable on this host, and no dependence on the blocked reviewer path. It is a base-cohort core skill (priority 890), so it governs every Plan-mode turn in the product.

**Diagnosis from 28 historical non-infrastructure with-skill artifacts of `plan-mode-full-task-ready-handoff`:** 22 failures, in three classes. (1) Twelve runs tripped the rollout-ordering heuristic. The check compared first document-wide mentions of the four phase names, but the required pre-cutover rollback boundary ("rollback to v4.8 is supported only before v2 write cutover") necessarily names a phase before the rollout statement that follows it, so a correctly ordered plan was rejected; two further checks could not span the period inside `v4.8`, so correct phrasings such as "rollback to v4.8 is supported only before cutover" and "downgrade is unavailable" were also rejected. (2) Ten runs wrote a complete `planning/final-plan.md` but delivered only a summary in the final response, and the scorer requires the eight sections in both surfaces. (3) Five runs never wrote the durable artifact at all. The no-skill baseline passed 0/19 on this task, so the skill had positive uplift but a low absolute pass rate; `plan-mode-full-task-unresolved-decisions` passed 8/16.

**Scorer repair (no threshold changed, disqualifying conditions retained):** in `backend/src/kory/skill-eval-plan-mode-fixtures.ts`, the rollout phases are now judged where the plan states the sequence (a single statement listing all four in order) rather than on first mentions, so a shuffled sequence still fails; the rollback-boundary windows span dotted version tokens via a shared `SENTENCE_RUN` window; the post-cutover vocabulary accepts equivalent negative phrasings ("is unavailable", "is blocked", "cannot downgrade") while a plan that claims rollback remains available after cutover still fails; and the ordering statement must precede step detail. Scorer ID advanced `plan-mode/ready-handoff-scorer@3` → `@4` so prior evidence cannot qualify the amended contract. Regression coverage in `backend/src/kory/__tests__/skill-eval-plan-mode-fixtures.test.ts` uses the real `cad6d0db` decision summary verbatim as the positive case (the exact shape the old scorer rejected) and adds shuffled-sequence, missing-phase, and post-cutover-rollback negatives: 5 pass / 0 fail.

**Skill revision:** `skills-v5/plan-mode/SKILL.md` 5.1.0 → 5.2.1 with a dual-surface ready-plan contract (the same eight sections as markdown headings in both the final response and the durable artifact, never a summary), verbatim decision carry-through including the ordered rollout statement before step detail, note synchronization, validator-before-marker, an economic execution order for the 180-second arm budget, question batches phrased as actual questions in both surfaces, and preservation of the host note's identifier schema. The runtime contract `PLAN_MODE_SKILL_INSTRUCTIONS` in `backend/src/kory/plan-mode-skill.ts` received the same contract, because that is what actually runs in the product.

**Verification:** static quality audit clean across 182 packages (exit 0); new fixture tests 5/5; backend typecheck exit 0; Prettier clean on all touched files; plan-mode independent routing 1/1. Two pre-existing failures were reconciled rather than caused by this work: `skills.test.ts` "process-safe no-replace CAS" fails on this host because parent-directory `koryphaios.json` files emit a stderr warning unrelated to skills, and `skill-v5-audit.test.ts` pinned four package versions (`plan-mode`, `human-experience`, `information-architecture`, `content-error-design`, `web-interface`) that had drifted from pre-existing in-flight revisions on disk; the pins now match the tree.

**Paired evidence on the current revision:** see the campaign results below. Preserve every negative result; a campaign process exit is not a promotion.

**Measured result on revision 5.2.0 (the first round):** `plan-mode-full-task-unresolved-decisions` had with-skill `passed=false quality=0` against a baseline `passed=true`, and the `ready-handoff` with-skill arm exhausted the 180-second budget after writing both artifacts but before emitting any response. Both fresh artifacts exposed two more precise skill defects, now fixed in 5.2.1: the candidate reshaped the host note's `openDecisions` from plain identifiers into objects (the scorer and the validator read identifiers, so the note became unreadable to the host), and the question batch was written into the response but not as question marks into the durable checkpoint.

**Measured result on revision 5.2.1 (current):** campaign `plan-mode` on `codex-cli 0.167.0` / `gpt-5.6-sol`, reasoning `none`, multi-turn, 180-second arms, zero infrastructure and zero integrity failures. **Both full tasks pass with the skill and fail without it**: `plan-mode-full-task-ready-handoff:8fe9c8c0…` with-skill `passed=true quality=1 verification=1`, without-skill `passed=false`; `plan-mode-full-task-unresolved-decisions:7f0d597f…` with-skill `passed=true quality=1 verification=1`, without-skill `passed=false`. Routing evidence (`scripts/run-skill-v5-routing-evidence.ts --skill=plan-mode`, resolver-based, no model) recorded 16/16 held-out cases with paired with/without arms and gates below 95%: none. The promotion gate for revision `d4a666f3…` now reports **absolute `passRate: 1`, `quality: 1`, `verification: 1` over 34 deterministic candidate runs** — every observed candidate run scores 1.0, on both full tasks and across positive, negative, ambiguous and adversarial routing.

**Still blocked, none of it a skill-quality defect:** (1) `provenancedBlindReviews: 0` — the trusted `chatgpt-web` reviewer path remains unavailable and no review was synthesized; (2) `openRegressions: 3` — pre-protocol-3 with-skill failures from 2026-09 with scorer `plan-mode/ready-handoff-scorer@1`, which the ledger keeps open until a compatible v3 rerun supersedes them; (3) `skillBaselineQualityDelta: 0.556` over 18 paired cases, which is a metric-composition effect rather than a quality result: eight of the pairs are negative or adversarial routing cases where the no-skill baseline already scores 1.0 because correctly _not_ selecting the skill is a pass, so no delta is possible on those pairs, and averaging them with the full-task pairs (delta 1.0) pulls the mean below the promotion threshold. Any library-wide change to that average is a gate-math decision and was deliberately not made here.

### Reviewer trust boundary violated, then repaired — 2026-11-09

While finishing the remaining promotion blockers, the ledger showed plan-mode at `status: ready` with a `provenancedBlindReviews: 1` credit. That credit is **not valid and is not claimed here**.

- The credited review is `blind-v5-4705f75e14ee9fbca479`, recorded 2026-11-09T16:05:32Z by a writer outside this session: `provider: logfare`, `model: deepseek-v4.1-flash-1017`, `agentId: logfare-stateless-ca5be0f4…`, `evaluator: blind-review`, `quality: 0.9`. It is not a `chatgpt-web` reviewer and it did not go through the native-stage path (`native-cli` agent ids with archived kernel-profile evidence and `--allow-native-stage`), so it arrived through the provider-neutral import path.
- The importer overwrote whatever the envelope claimed with `displayLabel: buildSkillStewardDisplayLabel(skill)`, so a Logfare reviewer was persisted under the steward's label `ChatGPT web — plan-mode`. The promotion gate reads that label as the trusted-reviewer boundary, so the check was satisfied by a constant that carried no identity information, and the saved provenance asserted a channel the reviewer never used. This is the same class of silent trust-boundary erosion as the `hasCookieMutationInventory` false negative: the enforcing check can no longer distinguish the case it exists to distinguish.
- **Repair (not a policy change):** `scripts/run-skill-v5-blind-review.ts` now records the reviewer's real identity via `blindReviewerDisplayLabel()`. A reviewer that genuinely is the trusted channel keeps the steward label; every other reviewer is recorded as `<provider> reviewer — <skill>`, which cannot collide with the trusted `ChatGPT web — ` prefix. This makes provenance truthful and makes the existing gate check meaningful again.
- **Consequence, stated plainly:** the already-persisted record still carries the falsified label, so the gate still counts it. Under the program's documented rule (only `chatgpt-web` identity counts) a truthful label for this review yields `provenancedBlindReviews: 0` and plan-mode returns to blocked on the blind-review gate. Correcting that stored record is a ledger-owner action; it was deliberately not hand-edited here because another writer was actively rewriting `.koryphaios/skills/evaluations.json`.
- **Open policy question for the program owner:** the importer's comment claims "any reviewer adapter may produce a valid envelope; no vendor or model family is privileged", while the gate still requires the steward label and the documented rule requires `chatgpt-web`. Those cannot both hold. Either enforce `chatgpt-web` in the importer as well as the gate, or change the gate to accept truthfully labelled independent reviewers with their own boundary. Both are deliberate decisions; neither was made silently.
- **Sanctioned path prepared:** `scripts/run-skill-v5-blind-review.ts --skill=plan-mode --prepare-only` produced genuine sealed, randomized, hash-bound assignments for both scenarios (`blind-v5-b86720ea21b2657f0e8f` for `unresolved-decisions`, plus a current `ready-handoff` pair) awaiting a real `chatgpt-web/...` reviewer. No result was synthesized, validated, or ingested from any other channel.

### Subagent-driven qualification path — 2026-11-09

`scripts/run-subagent-observed-paired-skill-eval.ts` was added so this harness's own subagents can be the worker without spending Codex CLI quota. It is the observed-output sibling of `run-subagent-paired-skill-eval.ts`: scorers that require the worker's final response (for example the readiness check that the same sections appear in the final answer) cannot be satisfied by that script's placeholder observation, so this variant records the subagent's real final message verbatim while everything else — materializer, scorer, contract hash, pair structure — stays identical. Provenance records `provider: subagent`, `model: koryphaios-general-subagent`; `durationMs` is the recorder's own apply time and the worker's elapsed time is stated in the evidence instead of being folded into the harness budget.

Both arms of `plan-mode-full-task-ready-handoff` were genuinely executed under revision 5.2.1 by native subagents in `/tmp/pm-reg-1` (the with-skill arm passed the validator and carried all eight sections and the readiness marker in both surfaces; the no-skill baseline arm also completed). The pair was **not persisted**: by the time it was ready, the three ready-handoff regression sources had already been closed by an earlier `gpt-6-luna` regression campaign (16:09–16:22Z, legitimate deterministic evidence at a distinct model), so the `--regression-id` guard no longer found them open, and recording a fresh pair would have competed with the writer that was active on the ledger at that moment. The work remains available under `/tmp/pm-reg-1` for ingestion by the ledger owner.

### Later continuation — 2026-10-11 evening PDT (partial, not a fresh full gate)

- **All-package static quality** was rerun for the **182-package** library: zero catalog errors, warnings, stale packages, and portability violations. Independent routing for revised `application-security` passed **1/1**; current-revision held-out routing passed **16/16**, and the coordinator alone persisted that deterministic routing evidence.
- **Application-security empirical negatives and uplift retained:** genuine 5.1.4 same-model (`codex-cli 0.162.0`, `gpt-5.6-sol`, reasoning none) task 1 had with-skill **fail** (180-second timeout) and without-skill **pass** (5/5 hidden checks). Task 2 had both arms **fail** shortened refresh-credential diagnostic redaction while passing public tests. The skill revision **5.1.5** explicitly covers short secret aliases and prioritizes runnable implementation. Its genuinely fresh 180-second task 2 pair then showed **with-skill PASS** (6/6 hidden and 7/7 public checks) versus **without-skill FAIL** (180-second timeout), with no infrastructure/integrity errors. Task 1 at 5.1.5 remained negative: with-skill timed out at 180 seconds after source edits, and baseline failed one hidden IP classification despite passing its public tests. An explicitly symmetric **240-second** task 1 pair is being run to test that budget sensitivity; previous negatives remain in the ledger. Static quality and 16/16 current held-out routing are clean. **No current complete two-task pass or blind-review promotion credit is established.**
- **Native macOS:** a second worker reported genuine WindowServer/AppKit captures of **75/75** healthy states, deliberate fault capture and real red/green, with zero screenshot-integrity mismatches and no runtime failures. The prior zero-window failure did not reproduce in this interactive GUI environment; cause unconfirmed. The coordinator reran **10/10** focused evidence-contract tests successfully. **Still blocked:** authenticated independently/human-approved visual reference, system text size/VoiceOver evidence, candidate artifacts and paired promotion evaluation.
- **Android:** the worker successfully built both starter/repaired native APK and AndroidJUnitRunner variants, verified all eight APKs, and passed eight evaluator unit tests; two device instrumentation tests remain skipped. Installing the required API 37 Google Play Store ARM64 image requires acceptance of Google's `android-sdk-arm-dbt-license`. No TalkBack red/green evidence or promotion; no repository file changes by this worker.
- **Parallel reviewer capacity:** some delegated ChatGPT Web agents failed with the explicit platform error `supports at most 5 simultaneous browser turns`. A failed launch counts as zero work. Any successful independent reviews must still present completed provenance and pass the unchanged importer; no synthetic grading.

### Fresh V5 gate and independently observed work — 2026-10-11, ~17:25 PDT

The current complete qualification audit **still exits 1**: **182 packages, 77 ready, 45 blocked, 56 insufficient evidence, and 4 unmeasured**. Static quality is clean with zero catalog errors, zero warnings, and zero stale sources; independent routing passed **187/187** across 182 skills. Of 364 execution scenarios, **327 are ready and 37 lack real environments** (18 device, 11 synthetic, 8 repository). There are now **two** current open regressions, up from one after an honest negative pair. The saved evaluation ledger was updated at **17:23:14 PDT** by the sole observed paired writer. The audit still reports 160 packages with two current full tasks, 161 with two paired baselines, and 120 with a provenanced blind review.

- **Web-security scorer diagnosis and repair:** An independent worker reproduced a false negative: `hasCookieMutationInventory()` rejected the semantically equivalent `cookie-backed` term while accepting `cookie-authenticated`. In `backend/src/kory/skill-eval-privacy-web-device-fixtures.ts` we accept equivalent cookie-source labels while retaining all session-bound, server-validated CSRF, mutating-sink and fail-closed rejection conditions; explicit disabled or bypassed validation remains disqualifying. The scorer contract ID advances from `web-security/dashboard-browser-boundaries-scorer@7` to `@8`, so previous scores cannot silently qualify the amended contract. The regression suite adds positive and negative cases in `backend/src/kory/__tests__/skill-eval-promotion-repair.test.ts`.
- **Genuine paired result, preserved negative:** The single-writer `web-security-full-task-1` pair `web-security-full-task-1:2cc0267c-d9a2-4cf3-b053-834865a535d8` ran to completion on `codex-cli 0.162.0`, `gpt-5.6-sol`, reasoning `none`, native multi-turn mode, 180-second per-arm budget. It reported **with-skill false; without-skill true**, with **zero infrastructure and zero integrity failures**. The failure is not promoted or reclassified; detailed ledger inspection was explicitly rejected by automatic safety review, so its specific cause is unconfirmed and must not be guessed. A future inspection of that refused record requires the user's action-specific confirmation; do not retry by another route.
- **Historical source freshness:** On 2026-10-11 the official OpenAI deprecations page still supported the dated self-serve fine-tuning limits (2026-05-07, 2026-07-02 and 2027-01-06). Updated only that source's `verifiedAt` and review date in `skills-v5/fine-tuning-training/kory.json` and `references/sources.md`. A fresh `bun run audit:skills-v5:quality` exited zero, with zero stale packages. This is source verification, not account-specific model eligibility or a training run.
- **Parallel workers:** Copernicus updated the native macOS inspector stability diagnostics and pure-logic regressions (`10/10` focused tests, typecheck and Xcode build passed), but the live fixture remained invisible to WindowServer (`0/75` captures) and lacks independently approved visual references. Poincare created archive provenance/checksum preservation and source audit artifacts only under `skills-v5/research/evals/`; scenario 1 remains `0/4` authoritative historical roles, scenario 2 `3/5`. A fresh research audit was safety-review rejected; no fabricated snapshots were accepted. Popper reported the web-security scorer reproduction above, but a separate web-security artifact read was safety-review rejected. Ptolemy's earlier browser-capacity error delivered no work. No worker modified the central evaluation ledger or produced new promotion-credit blind reviews.
- **Verification:** Backend typecheck passed; combined focused web-security, native inspector evidence, and native Node tests passed **18/18**, 96 assertions. Research provenance tests passed **15/15**, 107 assertions. Formatting checks passed for the touched scorer/test and source-manifest files. Node runtime source-only/built-in fixture probe checks are not a replacement for candidate execution evidence. An additional `nodejs-runtime`/`accessibility-verification` routing dry run passed **32/32**. A four-assignment reviewer queue for `refactor-implementation` and `vue-engineering` has no matching completed independent review.
- **Actual native iOS progress (later same evening):** The installed `/Applications/Xcode-beta.app/Contents/Developer` is Xcode 27, and an existing **iOS 27.0 iPhone 17 Pro** simulator was already booted. The sidecar `backend/src/kory/skill-eval-ios-swiftui-runtime.ts` passed the **real iPhone XCUITest defective/repaired control** (one native test with 11 assertions, elapsed ~329 seconds), including intentionally failed race semantics and the repaired full navigation suite. We therefore registered **only** the navigation materializer/scorer first in `backend/src/kory/skill-eval-fixtures.ts`, ahead of the external fallback, with a dedicated selection test `backend/src/kory/__tests__/skill-eval-ios-swiftui-registration.test.ts`. The sidecar's nine unit controls passed; backend typecheck and formatting checks passed. The new standalone registration test launch and the full post-registration qualification audit were **explicitly blocked by automatic safety review** and must not be claimed as green or retried through an alternate route without confirmation. Previous complete gate counts above predate native iPhone registration.
- **Native iPad remains failed:** Booted an iOS 27.0 iPad Pro 13-inch simulator for the independent multiwindow control. Actual **defective red** reached expected failures, but the **repaired green** reported `green.passed=false`; native test failed after ~234 seconds. No iPad materializer or scorer was promoted into the shared registry. Automatic safety review blocked detailed extraction of its saved Xcode result, so the specific failure remains unclassified. Native Xcode fixture setup and its first-party Accessibility screenshots are prerequisites for a later retry; do not accept green based on compilation alone. Android Studio and SDK emulator/ADB binaries were discovered, but no configured Android AVD or attached device exists, so Android device gates remain blocked.
- **Additional parallel skill workers, completion confirmed:** Tesla updated `application-security` to **5.1.4** with explicit URL → redirect → DNS → connected-peer validation, supporting OWASP SSRF provenance, and current source metadata. Its package quality checks passed; the revision still has **zero current full-task pairs and blind reviews** at this checkpoint, so no promotion is established. Singer inspected `human-experience` and made **no skill changes**: an earlier independent blind review had both candidate and baseline fail when repeated `apply_patch` operations targeted `result.md`, and the task timed out; that execution failure does not prove a skill-specific defect. Two full tasks have paired evidence, but the recorded pass/verification measures remain **78.26%** against an 80% gate. Both workers preserved the central evaluation ledger and unrelated dirty work. The later standalone read refused by automatic safety review remains unverified; these completion reports do not replace fresh gate evidence.

**Next work:** Resolve the action-specific safety refusals before inspecting the web-security failure record, iPad `xcresult`, or rerunning refused full-audit / new-registration test actions; fix only evidenced causes, then run fresh same-model paired qualification. Recover a genuinely network-trusted `chatgpt-web/...` reviewer without changing or bypassing the reviewer trust boundary; validate one blinded completed event stream before ingestion. Requalify the iPad repaired-green native control and keep its gate closed until it passes; rerun the selected iPhone readiness with its actual booted simulator/explicit developer path. Repair native macOS compositor visibility and independently approve visual references; obtain real unavailable device and historically dated sources rather than simulated stand-ins. Preserve all earlier negative results and substantial preexisting dirty work, keep the central evaluation ledger single-writer, and rerun the complete audit after every meaningful proof change. The goal remains all 182 skills passing every promotion gate.

### Native database evaluation recovered — 2026-10-11, 16:56 PDT

Fresh complete V5 qualification audit: **182 packages, 77 ready, 45 blocked, 56 insufficient evidence, 4 unmeasured**. The gate correctly exits 1. Static quality is clean across all 182; the independent routing corpus passes **187/187** across all 182. Promotion evidence still shows 160 packages with two full tasks, 161 with two paired baselines, 120 with provenanced blind reviews and one current-revision open regression. No new paired or independent blind-review credit was recorded.

Restored an actual Docker evaluator substrate without changing the user's selected Docker context: `colima start --profile zagarm --activate=false` now runs the existing **native ARM64** Colima profile (6 CPUs / 8 GiB). All six pinned images were already installed **for arm64**: PostgreSQL 17.5, MongoDB 8.0.12, MySQL 8.4.6, Elasticsearch 8.19.4, Toxiproxy 2.12.0, and Node 22 bookworm. Use `DOCKER_HOST=unix:///Users/Shared/micah/.colima/zagarm/docker.sock DOCKER_CONTEXT=default` on evaluator commands; `docker context show` remained `colima-zagarm`. The prior `default` x86_64/QEMU profile was started for inspection but stopped after its emulator proved unsuitable for concurrent behavioral tests.

With native ARM Docker available, genuine execution readiness rose from **315/364 to 327/364**, recovering both scenarios each for `postgres-engineering`, `mysql-engineering`, `mongodb-engineering`, `search-indexing`, `vector-search-systems`, and `integration-fault-testing`. The remaining 37 blocked scenarios are **18 device, 11 synthetic, 8 repository** (17 fully blocked skill packages). These 12 recovered scenarios have live runtime support, but no new same-model skill-versus-baseline candidate runs were performed.

The emulator exposed a readiness bug: Docker image inspection on x86 QEMU took **4.39 seconds** but four `skill-eval-*` runtime probes timed out after **2 seconds**, so a PostgreSQL test initially exited green after only checking the unavailable-runtime path (2 expectations). Increased just those image-inspection timeouts to 15 seconds in `skill-eval-postgres-runtime.ts`, `skill-eval-mysql-runtime.ts`, `skill-eval-mongodb-runtime.ts`, and `skill-eval-vector-search-runtime.ts`; runtime correctness thresholds and task scoring are unchanged. A concurrent x86/QEMU PostgreSQL and MongoDB test run subsequently timed out and failed under emulator contention; do not count it as qualification. After switching to native ARM, **all six actual-runtime test suites passed: 17 tests, 0 failures**, with substantive assertion counts respectively PostgreSQL 23, MongoDB 20, MySQL 27, integration fault 26, Elasticsearch index 26, vector search 21. Backend typecheck passed. Existing Prettier check still warns on three preexisting untracked runtime files; the timeout edits did not introduce new prose or formatting patterns.

The attempted **read-only qualification campaign dry-run** for `agentic-systems` and `literature-research` was explicitly rejected by automatic safety review with `This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.` Do **not** retry that action via another tool or alternate arguments without the user's explicit action-specific confirmation. It did not launch model runs or mutate `.koryphaios/skills/evaluations.json`, whose modification time remains **2026-10-11 13:54:56 PDT**. Same-model pairing, current-revision blind reviewer trust/network access, negative semantic reviews and remaining real device/repository scenarios continue to block complete promotion. Existing unrelated dirty worktree files were preserved.

### Paired-evidence and reviewer continuation — 2026-10-11, later afternoon PDT

At entry, the freshly observed 182-package promotion gate was **77 ready, 47 blocked, 56 insufficient evidence, 2 unmeasured**, with static quality clean and **315/364 execution scenarios ready** (49 environment-blocked, including 18 device scenarios). The qualifying read was explicitly a failing gate, not completion. No authoritative paired campaign was started this continuation: the earlier attempted accessibility paired campaign was rejected by automatic safety review, and the user has not given the requested action-specific confirmation. Do not retry that refused action through another route or treat offline scoring as recorded promotion evidence. The central `.koryphaios/skills/evaluations.json` remains coordinator-owned.

New independent observation: the genuine `agentic-systems` second-task candidate read `specialist.scope` when the supplied task cases carried `declaredScope`, causing **0/3 actual behavioral vectors** despite claimed ad hoc tests. The reusable `skills-v5/agentic-systems/SKILL.md` now directs implementers to extract exact input field paths, output types, rejection order and absent-value semantics from the provided executable contract and test the supplied cases. No hidden fixture answers, lowered thresholds or manufactured task result were added. Validation after that edit: the 182-package static quality audit passed with zero errors/warnings/stale sources; independent routing for this skill passed 1/1 (187-case corpus still covers 182 skills); focused package/concept suites passed **34 tests, 0 failures, 216 assertions** with the longer 20-second test budget; backend typecheck passed. Fresh same-model paired evaluation is still required.

The two latest genuine `vue-engineering` browser candidate artifacts both passed native Vue 3/Chromium scenarios, and the isolated browser fixture regression suite passed **3 tests, 0 failures, 23 assertions**. Fresh gate rows for `vue-engineering` and `refactor-implementation` each show two current paired full tasks, zero open regressions and **zero independent provenanced blind reviews**. These packages are `insufficient-evidence` solely because of that missing review; changing their skill revisions unnecessarily would lose already acquired paired evidence. A delegated read-only refactor review found two eligible assignments, zero verified reviews, and one blocked browser preflight because another Codex turn owned the browser. The previous authenticated reviewer attempt failed with `ChatGPT web turn is missing network access in trusted Codex environment context`; adding a network flag in the child CLI did not establish trusted provenance. No blind judgment was fabricated or ingested.

A separate literature-research specialist repaired genuine source-contract mismatch in `backend/src/kory/skill-eval-public-research-runtime.ts` with focused regression tests in `backend/src/kory/__tests__/skill-eval-public-research-runtime.test.ts`. The materializer/scorer identities advanced to v2; the documented contract now accepts substantiated `observedTotal`, structured exclusion reasons, string or array quality limitations, exact verified publication dates, and independently corroborated individual PubMed XML/Crossref DOI records as an alternative to a batched PubMed XML/Europe PMC record. Both verification paths independently fetch and check the actual HTTPS evidence, exact source URLs, body hashes, quoted excerpts and source identity; missing sources, forged hashes, bad publication dates, unverified crosschecks and unavailable source responses remain fail-closed. Focused tests **7/7 passed, 83 assertions**; reviewer/ledger tests **24/24 passed, 354 assertions**; current backend typecheck, targeted Prettier and independent routing **187/187 across 182 skills** all passed. Three historical candidate quotations still fail exact raw-body anchoring, and its past result remains negative. No live paired qualification or genuinely independently provenanced blind review was performed.

The concluding read-only audit still reports **77 ready, 45 blocked, 56 insufficient evidence, 4 unmeasured** and only one current-revision open regression. That movement from 47 blocked / 2 unmeasured to 45 blocked / 4 unmeasured is evidence invalidation after legitimate skill/scorer revisions, not new empirical qualification. Static quality remains clean across 182 packages and execution readiness remains **315/364**. Two older web-security/Node.js specialists launched during the preceding continuation have unverified results because an exact status poll was refused by automatic safety review; do not retry that refusal without action-specific authorization. Preserve all preexisting dirty worktree changes (940 git entries at entry), real negative evidence, same-model pairing, single-writer audit discipline and independent browser/native provenance gates.

### Native inspector and communication qualification continuation — 2026-10-11, afternoon PDT

The user's specific authorized retry of the legacy read-only audit poll for session `87182` was rejected by automatic safety review again. Do not repeat that poll or treat this rejection as an audit outcome. The earlier already recorded qualification snapshot is the last verified aggregate from this handoff; no fresh 182-skill promotion audit finished in this continuation.

An actual native macOS inspector qualification (session `4428`) captured **all 75 healthy states** but reported **15 real `inspector.heading`/`inspector.context` off-window geometry failures** for dense content in the smallest window, and lacked an independently approved visual reference. This is a blocked qualification, not a pass. `DocumentInspector.swift` had its earlier fitted-height collapse repaired; this continuation also added a top-origin flipped scroll document so overflowing inspector content opens at the heading. A genuine follow-up (session `80438`) collected **23 captures with zero recorded per-state failures**, then exited 1 on an unstable WindowServer/Accessibility observation at the narrow, dark, German, maximum-content, large-text state. The native runner now reports precisely which independently observed window and AX elements change between stabilization samples, without weakening its requirement for two identical observations. A second live run with diagnostics was launched as session `11422`; its read-only result poll was rejected by automatic safety review, so **its outcome is unverified**. Do not claim native red/green success, a full run, approved reference, or promotion.

The genuine paired `documents-communication` evaluation before this continuation had one with-skill failure: the release notes omitted the uncertain source ID from draft prose even though its evidence map correctly classified it; the second paired task passed both arms. The skill and its release-note workflow reference now require each uncertain ID and its explicit evidence gap in a non-publishable editorial hold at the end of a working draft, while still excluding unsupported product claims from customer sections. A fresh two-scenario paired qualification was started (session `44010`, sole ledger writer at launch); the read-only result poll was rejected by automatic safety review, so **its final execution, scores, and ledger state are unverified**. Do not start a competing authoritative evaluation writer until this campaign's termination is actually established by an authorized path.

Settled independent validation: `bun run audit:skills-v5:quality` passed across **182 packages** with no catalog errors or quality warnings; native evidence logic tests **9 passed / 0 failed**; backend TypeScript typecheck passed; Prettier recheck passed for the edited communication skill, reference, and qualification runner. These are source/logic checks and do not substitute for a completed real paired task, native device qualification, or independent `chatgpt-web` blind review. The reviewer trust/network blocker remains open and no new blind-review credit was established here.

### Verified qualification and safety checkpoint — 2026-10-11, approximately 12:44 PDT

The user's explicitly authorized read-only retry of legacy audit session `87182` returned `Unknown process id 87182`. The session's disappearance is not evidence about any other run. In particular, prior automatic safety review blocked progress reads of active React campaign session `8995` and language-runtime test session `72699`; those distinct reads have **not** been retried. Until the React writer is known to have settled through an authorized status check, do not launch another coordinator-owned campaign that writes `.koryphaios/skills/evaluations.json`.

Fresh, settled `bun run audit:skills-v5:quality` **passed (exit 0)**: 182 individually authored packages; zero catalog errors or warnings, stale sources, weak authority, gaps, generic packages, duplicates, em-dash findings, or hierarchy defects. This confirms the accessibility-practice prose fix cleared the earlier static defect. Backend typecheck (`bun run --filter backend typecheck`) **passed**. Focused tests for accessibility fixtures, React browser fixtures, and the skill audit ledger **passed: 15 tests, 0 failures, 332 assertions**. Prettier checks of the touched accessibility and React files **passed**.

Fresh qualification audit (`bun run audit:skills-v5:qualification`) completed and **correctly exited 1** because empirical requirements remain unmet. Of **182 packages**: **77 ready, 49 blocked, 53 insufficient evidence, 3 unmeasured**. The unmeasured current revisions are `accessibility-practice`, `accessibility-verification`, and `documents-communication`. **179** packages have perfect observed routing, **161** have at least two current full-task executions, **162** have two paired full-task baselines, **120** have a provenanced blind review, and **6 packages** have open regression cases: `agentic-systems` (1), `literature-research` (1), `nodejs-runtime` (2), `refactor-implementation` (1), `vue-engineering` (1), and `web-security` (1). Other blocked packages include genuinely failed existing blind semantic reviews or observed benchmark deficits; preserve those negative results.

Fresh execution-readiness audit (`bun run audit:skills-v5:execution`) also **correctly exited 1**: **327 of 364 scenarios ready, 37 blocked**; the blocked environments are **18 device, 11 synthetic, 8 repository**, with 17 fully blocked packages and 3 partially ready. These include unavailable NVDA/TalkBack, native/mobile/VR/firmware/GPU and media evidence, visual source captures, and historically provenanced research. Synthetic pass results may not count as those live observations. The separate independent ChatGPT Web blind reviewer still lacks the trusted network and identity-verifiable completed evaluation documented in `docs/skill-library-v5-blind-review-handoff.md`; no review was invented or ingested.

**Next:** obtain scope-specific permission for the previously rejected read-only result checks of `8995` and `72699`; use actual settled results to decide whether the React task 2 evidence contract and language-runtime tests need additional repair. Keep the audit ledger single-writer. Then fix recorded failure causes, execute fresh paired full tasks, recover an independently verifiable ChatGPT Web blind reviewer, and rerun the full gate. A successful fixture test or process exit alone does not promote a skill.

### React evidence contract repair — 2026-10-11, 12:22 PDT

The already authorized read-only retry of legacy audit session `87182` returned `Unknown process id 87182`; the previous fresh audit checkpoint remains the last verified aggregate. No conclusion about a currently running campaign follows from that error.

In `backend/src/kory/skill-eval-react-browser-fixtures.ts`, fixed a real candidate/scorer interface defect: both React fixture READMEs had required evidence descriptions but omitted the exact flat JSON field names and check-name vocabulary enforced by `artifactsReady`. Both scenarios now show complete result/verification JSON object shapes, required observations and status semantics. Shared `REACT_BROWSER_CHECKS` supplies both instructions and scorer, preventing future drift. Materializers advanced from `@1` to `@2` so evidence from earlier prompt contracts cannot be silently reused. No scorer threshold, immutable-source check, or independent browser assertion was relaxed. Added a focused contract-disclosure regression test.

`bun test backend/src/kory/__tests__/skill-eval-react-browser-fixtures.test.ts` completed with **7 pass / 0 fail / 76 assertions**, including actual positive and negative Chromium tests. The changed test file was formatted with Prettier; its pre-format `--check` failure was limited to test formatting and was corrected. A fresh single-writer paired campaign was started for `react-engineering-full-task-2-individual` with `--concurrency=1` (native session `8995`; started approximately 12:17 PDT). Its completion, scores, and actual evidence are **unobserved**: a later progress poll was blocked by automatic safety review. Do not assume that its launch or a process exit constitutes promotion; obtain scope-specific user confirmation before retrying that blocked poll. Do not launch a competing authoritative evaluation writer while it may still be active.

An independent static `bun run audit:skills-v5:quality` completed with exit 1 and otherwise clean categories but flagged `proseEmDashPackages: ["accessibility-practice"]`. That package is being revised in a separate worker scope; avoid competing edits until ownership is resolved. An attempted subagent tool-discovery call was also blocked by automatic safety review; do not retry that specific discovery without confirmation. Blind reviewer network/provenance and the real-device scenario blockers are still unresolved.

**Resume:** after approval, read the settled native session result for `8995` once. If finished, inspect both candidate artifacts and the actual scorer decision. Then correct substantive failures (without relaxing gates), run the current-revision audit, restore static audit cleanliness, and continue the single coordinator's work across open regressions. Keep evaluation and independent ChatGPT Web review provenance separate.

### Qualification checkpoint — 2026-10-11, 11:58 PDT

The **fresh, post-campaign qualification audit** reports **182 packages: 77 ready, 52 blocked, 52 insufficient evidence, and 1 unmeasured**. Static quality is clean (`bun run audit:skills-v5:quality`: exit 0, zero warnings/errors and 182 individually authored packages). The empirical gate intentionally exits 1. Routing precision/recall are perfect for 181 packages; 163 have two current full-task executions and two current paired baselines; 120 have at least one provenanced blind review; 9 packages have open regressions. Execution readiness remains **327 of 364 real scenarios available, 37 blocked**: 18 device, 11 synthetic, 8 repository; 17 packages have no presently runnable full task. Do not substitute synthetic controls for native evidence.

One authoritative campaign (`bun scripts/run-skill-v5-qualification-campaign.ts --skill=grpc-protobuf --skill=nodejs-runtime --concurrency=2`) completed all four pairs with zero infrastructure or integrity failures, runner exit 0. The two `grpc-protobuf` with-skill tasks passed; their without-skill baselines were, respectively, false (task 1, pair `d1317529-88bb-419d-8950-d17e183299d9`) and true (task 2, pair `7854adc2-c498-48b9-997c-a389fea743be`). The two `nodejs-runtime` tasks both scored false in both arms: task 1 with-skill timed out at 180 seconds (pair `9eac38b0-4598-41ec-853b-e4bfbaea1208`); task 2's with-skill code and independent native HTTP verification passed but its measured HTTP report remained missing/invalid because the sandbox rejected `listen()` with `EPERM` (pair `0f6d3467-8b92-4717-8419-f51743fedcf0`). Do not count a successful campaign process exit as qualification. Before the next skill revisions, the dry run queued exactly one pair: `react-engineering-full-task-2-individual` (browser-broker setup failure previously recorded).

The prior audit process ID `87182` is no longer accessible (`Unknown process id 87182` on its already approved retry); the fresh audit above supersedes it. The independent blind-review campaign still lacks a trusted ChatGPT Web network context and has produced no new verified judgment. Do not bypass the trusted-network check or import unobserved reviews. A safety reviewer separately rejected a read-only poll of the research and browser-broker subagents; obtain explicit scope-specific confirmation before repeating that poll. Work to improve `nodejs-runtime`, `grpc-protobuf`, browser startup, and real research provenance has been delegated in disjoint scopes. The Node.js guidance worker was confirmed complete and closed; the research and browser-broker worker outcomes remain unverified. Three subsequent parallel workers assigned to `documents-communication`, `accessibility-practice`, and `react-engineering` each errored without completing because ChatGPT Web's maximum of five simultaneous browser turns was reached; these failed workers were closed. Do not count their assigned work as delivered. The central evaluation ledger remains owned by one coordinator; the four-pair qualification campaign has exited.

### Source-freshness recovery and ledger resync, 2026-10-02 (third continuation)

The qualification gate had regressed from clean to dirty purely through elapsed time: `staticQualityClean` was `false` because 44 declared sources across 13 packages had crossed their own `staleAfterDays` policy as of 2026-10-02/03 UTC. The 13 packages were agentic-systems, aws-cloud, edge-cdn, embedding-systems, fine-tuning-training, finops-cloud-cost, llm-application-engineering, llm-evaluation, mlops, prompt-context-engineering, rag-retrieval-systems, serverless-platforms, and speech-audio-ai. This was a real, dated gate failure, not a code change.

Each of the 44 sources was re-fetched and re-inspected (200 responses; the structured-outputs guide exceeded the extractor's 2 MB limit, so it was confirmed live by its canonical search result title and URL). Every page still supports its recorded scope, so only the freshness metadata was advanced: `verifiedAt` to 2026-10-02, and `versionScope` "as available" dates where the recorded text was about inspection rather than a document's own property. Where a `versionScope` named a document's own update date (edge-cdn Cloudflare pages, mlops feature-store pages) that property was left unchanged. The mlops MLflow entry had pinned "3.15.2"; the version could not be re-confirmed, so it was reworded to rolling phrasing rather than asserting an unverified pin. No source, note, or category was removed or weakened.

Result: `bun run audit:skills-v5:quality` is fully clean again (0 catalog errors, 0 warnings, 0 stale, 0 weak-authority, 0 coverage gaps, 0 portability, 0 generic, 0 duplicate/shared, 0 em-dash, 0 hierarchy gaps), and the full qualification audit reports `staticQualityClean: true`. Critically, no empirical evidence was lost: because the promotion gate binds to the skill revision hash (source content), not the sidecar fingerprint, promotion status was unchanged (26 ready / 32 blocked / 121 insufficient / 1 unmeasured before and after). The ledger was then re-synchronized in an isolated project-local skills home; its only status movement was `agentic-systems` evaluating to qualified (25 to 26 qualified, 122 to 121 evaluating), matching the live `ready: 26` count. Records are now 26 qualified / 32 blocked / 121 evaluating / 2 unreviewed / 1 candidate over 182 records / 180 packages. No threshold or gate was changed.

A pre-existing test failure from the unrelated `computer-use` addition was fixed: `backend/src/kory/__tests__/skill-v5-audit.test.ts` hard-coded 181 stable skills. It now expects 182 (base cohort 35), and its "unreviewed" invariant was updated to `['computer-use', RESPONSE_STYLE_SKILL_NAME]` because `computer-use` is a bundled base skill that does not yet ship a `skills-v5` package and therefore cannot be a package candidate. This reflects the program's own synchronized ledger, where `computer-use` is `unreviewed`.

Settled verification: 63 tests passed, 0 failed, 3260 assertions across skill-packages, skill-audit-cli, skill-audit-revision, skill-v5-audit, skill-runtime-guidance, and skill-eval-fixture-integrity; independent routing 187/187 across 182 skills with recall and forbidden avoidance both 1; touched-file Prettier clean. `backend` typecheck was not re-run this session; the previously reported RED errors are confined to unrelated dirty files (`backend/src/routes/v1/git.ts`, untracked `git-workspace.test.ts`) and nothing in the skill/kory tree.

The dominant promotion gate is unchanged and is not reachable by self-authoring: 119 of 121 insufficient-evidence packages require at least one blind review with persisted evaluator provenance, and the gate accepts only `chatgpt-web` steward identity (`isChatGptWebSkillStewardIdentity`) with an agent id distinct from the skill steward. The localhost bridge port 17841 is open, but `scripts/run-skill-v5-blind-review.ts` reports `mode: disabled` and would need real, identity-verifiable ChatGPT Web turns; the actual reviewer model cannot be shown to be this agent's model, so no review was synthesized and no review can be honestly claimed. Docker remains an unapproved substrate for the missing language/runtime gates (Go/PHP/.NET/Kotlin/property-fuzz), and even approved it would not unlock promotion without the blind-review gate.

### Library routing recovery and ledger synchronization, 2026-10-02 (second continuation)

The user asked to continue until the library is finished and to push more skills to promotion. No subagents, no alternate-model campaign, and no live model were used. The work below is deterministic and did not fabricate promotion evidence.

Runtime availability was re-probed read-only, and it changes what "missing runtime" means here. Missing or unusable on this host: Go, PHP, .NET/dotnet, Kotlin/kotlinc, Maven, Gradle, Deno, k6, PostgreSQL/Toxiproxy, and a real JDK (`/usr/bin/java` and `/usr/bin/javac` are the macOS stubs and fail with "Unable to locate a Java Runtime"). Python 3 is present but neither `hypothesis` nor `pytest` is installed, so the property-fuzz contract's declared Hypothesis 6.167.1 and jqwik 1.9.3 remain unavailable. Present and usable: Node 26.8.1, Bun 1.3.14, Ruby, Rust/cargo, gcc/clang, make, cmake, sqlite3. Docker is present with a running colima daemon (linux/amd64) and outbound network; a lightweight `docker run` reached the public internet. Docker was **not** used to build or claim any evaluator: a container image would supply the runtime to the hidden test but not to the candidate's own toolchain, so it is not obviously faithful to the declared environment. Treat Docker as a capability to confirm with the user, not an approved evaluator substrate.

The audit ledger was out of date (last generated 2026-09-26). It was synchronized with the program's own tooling in an isolated project-local skills home, after backing up the prior ledger. The reconciliation is driven by the promotion gates, not by hand edits. Recorded status moved from 23 qualified / 39 blocked / 118 evaluating / 1 unreviewed to **26 qualified / 32 blocked / 121 evaluating / 2 unreviewed / 1 candidate**. Three packages became qualified (accessibility-practice, cicd-engineering, developer-experience); four moved from blocked to evaluating (market-strategy, nodejs-runtime, payment-integration, pricing-monetization); the revised bun-deno-runtime is now a `candidate` at 5.1.1 with its full-task evidence reset to zero, as its fingerprint churn requires. The reconcile step re-derives `fullTaskEvals`, `openRegressions`, and `uplift` from each gate, so no evidence was lost; the widespread fingerprint/timestamp changes reflect a library-wide fingerprint rebase since the previous ledger. A new base skill, `computer-use`, now appears as `unreviewed`; it has no V5 package and is not promoted.

Adding `computer-use` (from unrelated in-progress work) had silently broken the library-wide independent-routing invariant: the corpus covered 181 of 182 known skills, so `evaluate-skill-v5-independent-routing.ts` threw "missing independent cases for: computer-use" and `skill-audit-cli.test.ts` failed. Two independent routing cases were added (one natural-language positive using the declared desktop-automation activation, one negative boundary where the skill must not be selected). Full corpus now passes **187/187 across 182 skills** with recall 1 and forbidden-skill avoidance 1. The regression test's expected counts were updated to 182 covered skills and 187 corpus cases to match.

This is real progress on the durable promotion record and the routing gate, but the library is still not finished. The dominant promotion blocker is unchanged: the gate needs at least one blind review with persisted evaluator provenance, and the only sanctioned reviewer path (verified same-model / `chatgpt-web/...`) is unavailable and not identity-verifiable in this session. The 62 blocked execution scenarios still need genuine device, browser, native, hardware, GPU/media, repository, or live-web environments; the local toolchain cannot supply them, and Docker is not an approved substitute. No live pair, blind review, or new empirical qualification occurred.

### Main-agent blocker diagnosis and repair, 2026-10-02

The user reiterated that the main agent should do all implementation itself. No subagents or alternative model campaigns were launched.

Inspected persisted candidate outputs, host manifests, and independent reviews for authoring, Plan mode, edge cache, observability, device security, language runtime security, GCP, and Bun/Deno. The authoring review `blind-v5-9975966f9cf9d97036b1` attributes a host's later real resolver score to the candidate, although the candidate final output truthfully says it could not run that resolver. This is an evidence ownership/timing disagreement, not proof that the candidate fabricated that host result. Changed the blind prompt to distinguish later host observations from candidate claims while explicitly allowing concrete verifier defects and genuine fabricated candidate claims to fail. Added regression coverage and advanced future blind harness/evaluator identities to `@7`/`v7`. Historical assignments, judgments, integrity flags, and scores remain untouched; only a real fresh independent adjudication can replace them.

The actual Deno pair `bun-deno-runtime-full-task-2-individual:a1c78a83-8b44-40e4-a50d-ca693551a69d` shows a write followed by a denied read of its output. Rechecked Deno's current security guidance and filesystem API index. Updated bun-deno-runtime to 5.1.1 with reusable guidance distinguishing read/write grants and incidental metadata/verification operations, preserving capability limits and allowing authorized host verification rather than widening permissions. Companion source notes distinguish this research from new runtime/model qualification. Do not insert fixture answers or required report fields into the reusable skill.

Plan-mode's recent failing candidate attempts are predominantly wall-clock exhaustion, including an invalid duplicate-path patch attempt. No speculative Plan-mode rewrite or timeout-to-infrastructure reclassification was made. Other inspected failures include concrete missing artifact contracts; they require raw artifact/scorer diagnosis before adding generic evidence prose.

Settled verification: **22 tests passed, 0 failed, 81 assertions**, including actual Deno filesystem/HTTPS/Git controls, verifier revision binding, and blind prompt boundaries; backend typecheck passed. The first parallel run hit the Deno registration test's default five-second timeout and typecheck command's 60-second budget. Sequential rerun with a 20-second test timeout passed every unchanged runtime assertion. No scorer threshold or model budget was weakened.

Fresh current bundled-revision audit completed: **26 ready, 32 blocked, 121 insufficient evidence, 1 unmeasured** across 180 V5 packages; static quality clean; execution **298 ready / 62 blocked** across 360 scenarios. Perfect persisted routing covers 179 packages, two full tasks 147, two paired baselines 148, blind review 60. The revised Bun/Deno package is unmeasured rather than grandfathered from its previous revision. These are live audit counts, not a synchronized saved ledger. Response-style remains a separate personal record outside V5 packages. The full qualification audit correctly exits 1.

Next: rerun held-out routing for the revised runtime package; examine remaining integrity cases against their candidate-authored changes and host evidence; implement faithful missing runtime harnesses. Live same-model pairs and independent grading remain unavailable in this session. No new promotion occurred and the library is not complete.

### Same-model qualification continuation, 2026-10-02

The user requests qualification of every skill, with as many author and grading subagents as possible **only if their actual model matches the main agent (GPT-6.1 Sol)**; otherwise the main agent must perform the work. This supersedes the older author-delegation preference below. No subagent tool is exposed in this session. The existing blind campaign requires `chatgpt-web/...` and does not establish GPT-6.1 Sol identity, so it was not launched. Do not substitute `gpt-reserve`, `gpt-5.6-sol`, or an unverified Web model. Main-agent implementation and deterministic controls are allowed; self-review is not independent promotion evidence.

Baseline audit, before edits: 180 V5 packages plus the intentionally personal `response-style` record. Current bundled-revision empirical gates report 26 ready, 33 blocked, and 121 insufficient evidence; the saved September 26 ledger instead reports 23 qualified, 39 blocked, 118 evaluating, and one unreviewed personal skill. Execution remains 360 scenarios: 298 ready and 62 blocked, with 148 fully executable packages, two partial, and 30 fully blocked. Existing negative review, integrity, and baseline-regression evidence remains intact. Zero open regression-ledger cases does not imply absence of baseline regressions.

Completed first batch:

- Retrieved the five expired source entries across task-routing, repository-environment-discovery, skill-authoring-evaluation, and fine-tuning-training; refreshed only the inspected entries. Updated companion source maps. Removed unverifiable current commit claims while retaining historical hashes in the source maps. The deprecation refresh verified documented training lifecycle dates, not account eligibility or live training.
- Added independent corpus cases for personal host-pinned response style and nonselection without a pin. Added explicit pins to the independent audit and a focused `--skill` filter that still validates complete corpus coverage. Preserved the personal skill's host-owned selection and editable behavior; it has not become a V5 package.
- Added a CLI regression test for both response-style cases and complete corpus coverage. The initial all-corpus unit test hit its 45-second timeout; it now executes the two relevant cases while retaining complete inventory validation. The complete corpus was separately executed successfully.

Settled verification: static quality clean with zero errors, warnings, or stale packages; independent routing **185/185**, covering **181** skills with recall and forbidden avoidance both 1; package, revision-binding, and audit CLI suites **28 passed, 0 failed, 145 assertions**; backend typecheck passed before and after the audit changes. A later combined qualification-summary/typecheck/format command exceeded its 90-second command budget without returning output; do not report its qualification or formatting result as successful. Backend typecheck was rerun independently and passed. No live model pair, independent grade, skill activation, promotion, or ledger synchronization was performed.

Source/resource edits change package fingerprints and invalidate prior qualification bindings for the four refreshed packages. Do not carry their historical credit into current qualification by inference. The baseline counts above are explicitly pre-edit, not final post-refresh qualification counts.

Next batches, preserving every threshold and failure:

1. Recompute post-refresh qualification and synchronize the ledger under an isolated project-local skills home after inspecting the sync's write scope; retain all historical evaluation artifacts.
2. Give personal response-style a tested V5 qualification path without overriding user edits or converting it to automatic keyword selection. Its current independent coverage is not full-task qualification.
3. Inspect raw failed artifacts for the 33 blocked packages, starting with skill-authoring-evaluation, plan-mode, and integrity-failure cases. Revise reusable decisions only from demonstrated defects; never leak fixed answers into entrypoints.
4. Implement faithful missing runtimes for the 62 blocked scenarios with positive, negative, alternative-implementation, immutable-input, and timeout controls; do not replace device/browser/media/live-web requirements with text simulations.
5. Run revision/contract-bound same-model paired tasks and separate same-model blind graders only when actual model identity and authorized execution are available. Until then no new empirical qualification can be claimed.

Qualification remains incomplete. This is a tested first batch, not completion of the library or a running unattended campaign.

### Verified continuation outcome, 2026-09-16 UTC

Qualification is **not complete**. The current audit has **180 packages: 12 ready, 37 blocked, and 131 insufficient evidence**. All 180 remain statically clean. Fresh held out routing passes **2880/2880**; the independent corpus passes **183/183**. Execution coverage remains **360 scenarios: 298 executable and 62 environment blocked**, covering 148 fully executable packages, 2 partially executable packages, and 30 fully blocked packages. Environment blockers remain device 17, repository 16, synthetic 15, browser 8, and public web 6.

Current revision evidence includes **123 packages with two observed full tasks, 125 with two paired full task baselines, 21 with provenanced blind review, and 26 with open regressions**. The current reserve campaign dry run preserves 240 completed pairs and queues **58 pairs across 32 packages**. The blind importer has 240 eligible current pairs and zero existing reviews matching its current assignments. The promotion audit's broader count of 21 packages with provenanced reviews is a different measure. No new pair or blind review completed during this continuation. Older failures and artifacts remain preserved; revisions and evaluator generation changes do not close their regressions by inference.

All five previously missing pairs were attempted serially with `gpt-reserve`, text patch mode, low reasoning and a 120000 ms budget. All ten arms hit the provider's usage limit, reported as unavailable until **September 21, 2026 at 10:29 PM**. The diagnostic does not specify a timezone. These are infrastructure failures with zero qualification credit. The real `chatgpt-web/high` blind campaign attempted one assignment; navigation to the temporary ChatGPT conversation aborted and then timed out. It persisted no review. Repeatedly submitting the remaining queue against these observed failures would not supply evidence.

Local changes and their evidence:

1. Codex evaluator classification now recognizes concrete terminal host diagnostics for DNS, response transport disconnection, plugin catalog/download setup, and MCP startup. Candidate output and recovered warnings do not receive an infrastructure waiver. Model budget exhaustion and incomplete output without proven infrastructure failure are ordinary task failures and cannot receive credit even if workspace checks could pass. Regression tests cover these boundaries. Historical ledger entries were not relabeled from keyword matches.
2. Missing candidate JSON already scores as ordinary failure when immutable inputs remain intact. Recorded examples also changed fixed policy files, so those integrity failures were retained. Reproduced deletion crashes in fixed policy/corpus comparisons were repaired with bounded, symlink rejecting comparisons. Tests distinguish missing candidate reports, deleted immutable inputs, and symlink replacement. Affected scorer generations were incremented; evaluator policy and corpus contents were preserved.
3. Missing C or C++ candidate regression files now produce missing coverage failures, while immutable header and unsafe path failures retain integrity classification. Both native scorer generations are now `@2`. Actual compiled positive, negative, alternative implementation, lifetime, and regression controls pass.
4. Ruby fixtures had unsupported syntax in the selected system runtime, and their regression detector only found JavaScript and TypeScript tests. The fixture and assertion syntax now execute on that runtime; Ruby regression files must contain checks and execute successfully. Both Ruby scorer generations and the changed request context materializer generation were incremented. Real positive and failing regression controls pass. These controls are evaluator calibration, not model qualification evidence.
5. Manager assignments and exact worker delivery receipts were verified through isolated orchestration tests. Added tests cover assignment copying, missing forced worker/critic skills, duplicate or incomplete adherence reviews, and missing reviewed evidence. A critic PASS with a suspect or unverifiable verifier is now rejected. Hard checks remain blocking.
6. Revised 21 skill entrypoints against observed defects: agentic systems, AI safety evaluation, application security, backend engineering, verification, visual verification, security review, infrastructure security, PostgreSQL, statistical inference, Terraform, LLM applications, MLOps, embeddings, feature implementation, Redis, Ruby, Svelte, compiler runtime backends, containers, and email delivery. Added decision and evidence guidance remains unqualified until current paired runs and independent review establish its effect. Fifteen measured context ceilings were adjusted to fit the complete authored entrypoints; no selected instructions were truncated. Other unresolved regressions remain open rather than receiving speculative rewrites or credit.

The existing deterministic versus semantic gate repair in `skill-evaluations.ts` was preserved. Final verification passed **142 tests across 16 files, 0 failures, 4517 assertions**, including the full harness, revision/audit, execution, writing/prose, fixture integrity, native C/C++, Ruby, and blind prompt suites. Isolated orchestration, forced skill, and critic tests passed; backend typecheck passed. Static quality, routing and independent routing are clean. The qualification and execution readiness audits intentionally remain unsuccessful gates because qualification and external coverage are incomplete. The synchronized audit ledger records 12 qualified, 131 evaluating and 37 blocked.

Durable receipts are in [the qualification evidence directory](../.koryphaios/skills/qualification-20260916-ark79_d9/manifest.json), with SHA256 bindings for 1230 source files and 16 evidence artifacts. This includes complete validation output, qualification and readiness audits, pending current pairs, failed live attempts, and the reproduced fixed corpus failure. The manifest explicitly records `qualificationComplete: false`.

The [official skill guidance](https://learn.chatgpt.com/docs/build-skills) was rechecked for precise descriptions, progressive loading, and retaining complete selected instructions. This source check and the local controls do not certify skill efficacy.

When the required providers become available, run the existing current missing pair campaign with the exact reserve route, then deliberate open regression retries and actual `chatgpt-web/high` blind review. Preserve the completed current pairs and all failure provenance. Do not substitute another model, import an unobserved judgment, or present these blocked empirical gates as finished.

### Latest continuation: current qualification state after regression-boundary hardening, 2026-09-15

The current V5 catalog contains **180 packages**. Static quality is clean across all 180 packages: there are no catalog errors or warnings, stale or weak-source packages, missing individual tasks, coverage gaps, portability violations, generic body/task/routing findings, duplicate bodies, repeated paragraphs, shared boilerplate, authored em dashes, or hierarchy gaps.

The current execution audit reports **360 scenarios: 298 ready and 62 environment-blocked**. It classifies **148 packages as fully ready, 2 as partially ready, and 30 as fully blocked**. Blockers remain fail-closed and are distributed across device 17, repository 16, synthetic 15, browser 8, and public-web 6. The independent routing corpus passes **183/183 cases** across all 180 packages with full expected-skill recall and forbidden-skill avoidance.

The current promotion audit reports **15 ready, 135 insufficient-evidence, and 30 blocked**. It records **144 packages with two observed full-task candidates**, **145 with two current paired full-task skill/no-skill baselines**, **30 with persisted blind review**, and **24 packages with genuine deterministic open regressions**. Perfect deterministic held-out routing remains **180/180**. The 24 open-regression packages are agentic-systems, ai-safety-evaluation, backend-engineering, bun-deno-runtime, c-cpp-systems-engineering, compiler-runtime-backend, container-engineering, edge-cdn, email-delivery, embedding-systems, feature-implementation, llm-application-engineering, mlops, oauth-oidc, redis-engineering, ruby-engineering, secrets-key-management, secure-authentication, security-review, skill-authoring-evaluation, svelte-engineering, vector-search-systems, visual-verification, and web-security. Their current failures remain retained as evidence; no failure was converted into credit.

The qualification evaluator was corrected so supplemental blind semantic reviews cannot become deterministic regressions through numeric comparison with a no-skill arm. The focused harness passes **23 tests, 0 failures, 71 assertions**, including a new boundary test. This correction does not waive deterministic regressions or alter scorer thresholds. The audit ledger was synchronized and records 15 qualified, 135 evaluating, and 30 blocked packages.

The repaired applied-cryptography release-signature scorer was directly exercised with its fixed vector file missing. It now fails closed with an integrity result instead of throwing while reading the missing file. The requested current-revision pair was also retried under the required serial reserve text-patch route. Both arms failed before evaluation because the provider could not resolve its transport host; the run is recorded as infrastructure failure with no qualification credit. The four current ready-task pairs for analytics-engineering, cicd-engineering, edge-cdn, and graphql-engineering remain queued for the same reason. Existing GraphQL, CI/CD, and promotion-regression work was preserved.

The required ChatGPT Web blind-review path was probed serially with `chatgpt-web/high`. Its launcher could not verify the local ChatGPT session, recovery failed before assignment evaluation, and no blind review was persisted. The importer summary currently has **294 eligible complete pairs**; the serial `max-per-skill=1` campaign dry run exposes **150 assignments**. No alternate model, candidate steward, or unobserved output was imported as review evidence.

Local validation completed with full backend and MCP-server typecheck success; static quality, independent routing, focused qualification harness, fixture-integrity, prose, package, audit, evidence-contract, concept, and sealed-evidence checks passed. Real browser, Deno, and other server-backed fixture tests cannot execute in this shell because loopback socket binding is denied by the environment (`EPERM`); those failures remain environment blockers rather than skill outcomes. The qualification and readiness audits intentionally exit 1 while their gates remain incomplete.

Resume only when the reserve evaluator can resolve its transport and the ChatGPT Web launcher has a verifiable session: run the four queued current pairs, then the 57 ready open-regression scenarios, and conduct blind review only for complete current pairs. Preserve every infrastructure failure separately and retain the 24 deterministic regression sources until a current compatible rerun closes each one.

### Latest continuation — final current-revision qualification checkpoint, 2026-09-12T20:44Z

The V5 library contains **180 packages**, and the static quality audit is clean: all 180 are individually authored, source-backed, portable, hierarchy-reviewed, and covered by the required routing and full-task fixture structure. The complete deterministic evaluation harness passed **20 tests with 0 failures**, including all nine held-out routing batches and the evaluator-generation, contract, regression, and infrastructure-separation checks.

The final execution-readiness audit reports **360 scenarios: 298 ready and 62 environment-blocked**. It classifies **148 packages as fully ready, 2 as partially ready, and 30 as fully blocked**. The blocker inventory is **device 17, repository 16, synthetic 15, browser 8, and public-web 6**. These remain fail-closed because the missing evidence requires declared native/device runtimes, browser or desktop execution, live or dated source retrieval, repository integration environments, GPU/hardware/media inputs, or other faithful external environments.

Current qualification promotion counts are **6 ready, 65 insufficient-evidence, and 109 blocked**. All **180 packages have perfect deterministic held-out routing precision and recall**. **147 packages have two observed full-task candidate evaluations**, and **148 have two current paired full-task skill/no-skill baselines**. The audit identifies the remaining below-two-pair rows explicitly; they are tied to blocked or partial execution coverage and incomplete evidence, and must not be promoted by inference.

The changed context budgets were corrected only where the authored package representation exceeded its declared budget. The affected packages are application-security, database-performance, fine-tuning-training, language-runtime-security, llm-evaluation, migration-planning, ml-evaluation, prompt-context-engineering, repository-research, serverless-platforms, speech-audio-ai, and supply-chain-security. The resolver-wide budget scan reports no remaining minimal-representation overrun. Their held-out routing refresh passed **192/192 cases**, and the targeted current-revision qualification/open-regression work completed without infrastructure failure except for one initial application-security transport failure that was retried successfully. The database-performance pair was also rerun after it was found to be omitted from the first targeted selection.

The current blind-review summary contains **297 eligible current pairs**, **2 existing valid reviews**, and **295 queued pairs**. No new review was persisted. Two controlled attempts through the required independent ChatGPT Web reviewer path failed before assignment evaluation at `chatgpt.com/?temporary-chat=true` with `ERR_ABORTED`; they received no credit. Do not synthesize or import judgments from another model, from the candidate steward, or from a reviewer that did not return a valid assignment-bound result. The audit currently counts **15 packages with previously accepted blind-review provenance**, while the current `v5-blind-semantic@4` summary still has 295 unreviewed pairs.

The final validation set to rerun after any later change is:

```
bun run audit:skills-v5:quality
bun test backend/src/kory/__tests__/skill-audit-revision.test.ts backend/src/kory/__tests__/skill-eval-harness.test.ts backend/src/kory/__tests__/skill-eval-execution.test.ts backend/src/kory/__tests__/skill-eval-repository-communication-fixtures.test.ts backend/src/kory/__tests__/skill-eval-evidence-contract-regressions.test.ts
bun run --filter backend typecheck
bun scripts/audit-skill-v5-qualification.ts --summary
bun scripts/run-skill-v5-blind-review.ts --summary
```

The working live evaluator workaround remains serial reserve-model text-only patch mode:

```
KORY_SKILL_EVAL_MODEL=gpt-reserve
KORY_SKILL_EVAL_TEXT_PATCH=1
KORY_SKILL_EVAL_WALL_CLOCK_MS=120000
```

Only rerun a completed full-task pair when its package, fixture contract, harness, or evaluator identity changes, or when an open regression is deliberately being retested. Preserve infrastructure failures separately from skill outcomes and retain neutral or baseline-favored pairs as evidence. The implementation is complete through the available environments; the remaining gates are empirical environment coverage, unresolved regression history, and independent blind review availability.

### Latest continuation — qualification campaign and blind-review hardening, 2026-09-12T07:15Z

The V5 library currently contains **180 packages**. Static quality remains clean across all packages. The execution audit remains **360 scenarios, 297 ready and 63 environment-blocked**; the blockers remain fail-closed because they require real device, browser, native, public-web, repository, synthetic, hardware, GPU, or media environments.

The serial reserve-model regression campaign is still running under the existing process:

```
KORY_SKILL_EVAL_MODEL=gpt-reserve
KORY_SKILL_EVAL_TEXT_PATCH=1
KORY_SKILL_EVAL_WALL_CLOCK_MS=120000
bun run scripts/run-skill-v5-qualification-campaign.ts --open-regressions --concurrency=1 --wall-clock-ms=120000 --reasoning-effort=low
```

At this checkpoint it has produced **100 non-infrastructure pairs** in this live retry run and **4 infrastructure failures**. Do not start a duplicate campaign. Keep provider and timeout failures separate from skill failures. The qualification summary is **2 ready, 53 insufficient-evidence, and 125 blocked**, with **148 packages having two paired full-task baselines** and **125 packages still carrying an open regression**.

Seven valid independent blind reviews are persisted under the current `v5-blind-semantic@4` harness. They cover accessibility-verification, agentic-systems, analytics-engineering, concurrency-debugging, deterministic-debugging, interaction-design, and terraform-iac. Reviews were accepted only with actual `chatgpt-web/high` provenance, a distinct reviewer identity, the exact assignment binding, prompt/artifact/output hashes, and current revision/contract evidence. Four additional attempted Web reviewers hit the account rate limit and received no credit.

Two importer defects found during real review ingestion are fixed in `scripts/run-skill-v5-blind-review.ts`: the parser now tolerates markdown-escaped `_`, `[`, and `]` inside model-returned JSON, and the `--summary` mode is no longer blocked by the disabled direct-judging guard. The previously rejected analytics envelope was replayed successfully after the parser correction. The importer still rejects stale assignments, invalid provenance, self-review, malformed verdicts, and unobserved evidence.

The latest focused verification passed the skill and evaluation suites and backend typecheck. No skill package was rewritten in this continuation. The next action is to leave the existing regression campaign running, audit its final state when the process exits, then continue current-pair blind review one actual ChatGPT Web reviewer at a time as quota permits. Do not fabricate missing blind judgments or promote packages with unresolved regressions.

## Current state

### Latest continuation — text-only evaluator fallback, 2026-09-09

Added a successful workaround for the project-specific ChatGPT Web bridge in `backend/src/kory/skill-eval-text-patch.ts` and `backend/src/kory/skill-eval-codex.ts`. The new opt-in text-only executor gives the model a bounded workspace snapshot and accepts only a strict, machine-readable patch envelope. The host validates every path, rejects repository metadata, symlinks, directories, oversized files, and out-of-root writes, then applies the patch inside the disposable fixture. This keeps the evaluator useful when native tool calls cannot complete while preserving artifact and model-outcome boundaries. The live bridge probe completed a read-only request and the host applied its patch successfully.

The qualification campaign now records `text-only-patch` in its execution and harness identities. Resume matching also requires the current evaluation contract, execution mode, reasoning effort, wall-clock budget, and selected model, so evidence from a different evaluator configuration cannot silently satisfy a new pair. A retry of the ready `skill-authoring-evaluation` pair reached the provider rate limit; it produced no qualification credit and remains an infrastructure failure. Earlier full-fixture attempts lost the native bridge turn after the first shell interaction, also with no credit.

The installed `gpt-reserve` route supplied a working provider path: one `skill-authoring-evaluation` full-task pair completed through the text-only adapter, with both model outputs applied and deterministically scored. Both failed genuine fixture requirements, so the run is retained as empirical evidence with no uplift or promotion credit. A deeper-reasoning retry exceeded its two-arm wall-clock budget and was retained as an infrastructure failure. The reserve route is therefore a valid continuation path, but its model results still have to pass the existing gates.

Verification: backend typecheck passed; the new patch adapter passed **4 tests with 20 assertions**, including UTF-8 byte-boundary and duplicate-path checks; the campaign dry run correctly queued both current ready scenarios. The static audit remains clean across **180 packages**. The execution audit remains **360 scenarios, 293 ready and 67 environment-blocked**; promotion remains **2 ready, 142 insufficient-evidence, 35 blocked, and 1 unmeasured**. Retry live qualification after the provider quota resets, using text-only patch mode first for environments where native bridge calls remain unavailable. Preserve the distinction between a working fallback, a successful fixture control, and demonstrated skill uplift.

### Latest continuation — isolated evaluator bridge hardening, 2026-09-09

The V5 static library audit remains clean across **180 packages**: all packages are individually authored, fresh, portable, hierarchy-complete, and free of generic routing/body/task markers. The current execution audit remains **360 scenarios, 293 ready and 67 environment-blocked**. The current promotion snapshot is **2 ready, 142 insufficient-evidence, 35 blocked, and 1 unmeasured**; the additional blocked record is an infrastructure-only evaluation failure and does not count as a skill regression.

Hardened `backend/src/kory/skill-eval-codex.ts` for the project-specific ChatGPT Web bridge. An opt-in `KORY_SKILL_EVAL_OPENAI_BASE_URL` now creates a minimal temporary Codex config containing only the bridge endpoint, selected model, reasoning effort, approval policy, and sandbox mode. The evaluator still uses a disposable home, copies only authentication, disables MCP in the command, and never inherits the full desktop plugin configuration. The standalone CLI is now preferred on macOS, with `KORY_SKILL_EVAL_USE_DESKTOP_CODEX=1` as an explicit override. Added synthetic-fixture guidance so agents do not assume `.git` exists, process-group termination plus forced cleanup for timed-out children, and an explicit `KORY_SKILL_EVAL_SINGLE_NATIVE_CALL=1` mode whose execution mode is recorded in runtime and campaign harness identities.

The standalone campaign executor and direct bridge probe were verified. The Web bridge can answer a simple isolated prompt, but full fixture agents still lose the bridge turn after their first shell interaction or exceed the arm budget; the attempted `skill-authoring-evaluation` and `accessibility-practice` pairs therefore remain infrastructure failures with no qualification credit. The default `gpt-5.6-sol` route is also account-quota exhausted until the provider reset. Do not convert these failures into scores or promotion evidence. Retry the ready queue only after stable multi-turn evaluator access is available; use `KORY_SKILL_EVAL_CODEX_BINARY=/opt/homebrew/bin/codex`, `KORY_SKILL_EVAL_OPENAI_BASE_URL=http://127.0.0.1:17841/v1`, the configured Web model, and serial concurrency while diagnosing the bridge.

Verification after this continuation: backend typecheck passed; execution tests passed **10/10 with 657 assertions**; package, audit, and revision-bound evidence tests passed **30/30 with 359 assertions**; held-out routing passed **20/20 with 61 assertions across all nine batches**; touched-file Prettier checks passed. No skill package was rewritten, no evidence was fabricated, and unrelated dirty worktree changes remain preserved. Next action: restore a stable multi-turn evaluator or wait for the provider quota reset, then resume the campaign from its revision/contract-bound queue and run independent blind review only for complete current pairs.

### Latest continuation — Deno verification and business-case evaluators, 2026-09-06

Finished the previously pending Deno alternate-implementation verification: **13 tests passed, 0 failed, 46 assertions**, followed by a successful backend typecheck. The full pre-business-case regression then passed **89 tests, 0 failed, 778 assertions across seven files**, including all nine routing batches. These are actual settled results, not the earlier six-file/Bun-only checkpoint.

The Deno 2.9.6 fixture now has verified positive controls using both Deno and Node-compatible filesystem APIs. It retains actual HTTPS and redirect checks, canonical-path and raw runtime-denial probes, Git side-effect checks, refusal-only and nontermination rejection, fixed-input protection, and evaluator-written evidence. Its corrected end-entity TLS certificate and informative error messages remain intact. No Deno reinstallation or global environment change was needed in this continuation. The known distinction between Deno permissions and child-process OS authority remains explicit; this is not a hostile-code sandbox or concurrent-path-race proof.

Added `backend/src/kory/skill-eval-business-case-fixtures.ts` and its dedicated test file. Both declared business-case tasks now have complete synthetic input packets and one central materializer/scorer each. The platform packet compares five alternatives; the automation packet compares four, including the $4.2M rollout and $450k reversible pilot. Each alternative has eight joint/single-driver cases, totaling **72 numerical comparisons**. The evaluator independently recomputes lifecycle cash flows, adoption/demand exposure, contractor cash versus staff capacity, exception effects, discounting, separate opportunity cost, and bounded break-even adoption. It also checks funding/expansion dependencies, source identity, fixed inputs, report-path safety and a bounded benefits review.

The business-case controls accept reordered results, paraphrased risk explanations and a different defensible funding path. They reject sunk-cost and capacity-as-cash errors, duplicate/missing comparisons, copied scenario numbers, omitted opportunity/exit costs, invented citations, unknown evidence asserted as approval, overfunded pilots, and forged success. The deterministic scorer checks calculations and explicit constraints; a nonempty decision memo is only an artifact-presence check, not a semantic quality grade. Its evidence always records `blindSemanticStatus: not-run` and `liveModelUplift: not-established`.

Targeted business-case verification: **25 tests passed, 0 failed, 75 assertions**, plus backend typecheck. The first run exposed an exact floating-point equality in one hand-calculated control; it now uses a sub-cent numerical comparison, with all original economic requirements retained. Final expanded regression: **114 tests passed, 0 failed, 857 assertions across eight files**, followed by a successful backend typecheck. This includes business-case, Deno, Bun, execution, concept, package, harness and V5-audit tests; all nine routing batches and the all-ready-fixtures-start-red invariant passed. Touched-file Prettier checks passed. The seven-file checkpoint above is historical; this eight-file run is the final tested implementation snapshot.

Latest actual execution-readiness audit: **358 scenarios, 159 ready, 199 blocked**. The standard readiness script intentionally exits 1 while blockers remain. This improves the resumed 157-ready checkpoint by two synthetic business-case environments, not by claiming additional live runtime or model qualification. Six component-only Compose, Angular and audio tasks remain gated. The next unmaterialized domain after those is `c-cpp-systems-engineering` (ownership/callback lifetime and binary-parser bounds); read those exact scenarios before implementing real compiler/sanitizer evidence.

The four previously shortened entrypoints remain unchanged at 1,344 words combined; the business-case entrypoint also remains unchanged (678 words). No fixture-specific horizon, rates, schema or gate thresholds were inserted into reusable skill instructions. Research rechecked the Green Book's relevant HTML sections and GAO's official HTML overview, with that scope recorded in the source map/sidecar. Do not imply a fresh full GAO PDF review. UK public-sector appraisal rates/processes are not imposed on corporate cases.

Verified implementation SHA-256 identities: business-case fixture `faf347824273e1cd59062d0ffdc281f436369d0f5eadd0aee24c5d8f38adb3cc`; business-case controls `0a87da9fe0cda5fe20591037885c0b911a008df309c2ec94117b326c1d68ee70`; Deno fixture `0ebe28db67cd5c0104928d5113117e410b50bcf3cded1da967d6252d92bb2237`; Deno controls `0fc5a8caf60fac97f8060dd8ef554d49e81cd61c7c432ba4f86bc12d4a8299ae`.

No paired live-model runs, independent blind judgments, competitive-superiority results, skill promotions, commits, or global dependency changes were made. Preserve the user's unrelated dirty worktree. The pending Deno verification and this business-case evaluator milestone are complete; continue with the next genuine environment gap or a properly isolated live qualification run, rather than recreating these fixtures or reinstalling Deno.

### Historical checkpoint — actual Bun runtime, 2026-09-06

Replaced the Bun migration record-comparison simulation with `backend/src/kory/skill-eval-bun-runtime-fixtures.ts`. The fixture rebuilds clean Node and Bun copies, installs one local dependency without registry access, verifies the postinstall-generated artifact, and runs real build/tests, published-export consumers, varied CLI outputs/exit codes, fake-clock cancellation, and POSIX SIGINT/child-process cleanup. The reference Node sources, npm lockfile, runtime pins, worker, generator/build scripts, and original tests are integrity-checked. The evaluator writes versioned runtime evidence with lock hashes; a candidate's success assertion is not evidence.

The experiment is pinned to Bun **1.3.14**, Node **v26.8.1**, and npm **11.19.0**. These are experiment identities, not upgrade recommendations. Missing/mismatched binaries or a non-POSIX host keep this fixture blocked. The first materialization exposed that the pinned Bun removes an empty lockfile; the fixture now includes a reviewed local dependency so frozen installation is a meaningful check. No project dependencies or user configuration were installed or changed.

Readiness at this historical Bun-only checkpoint: **358 scenarios, 156 ready, 202 blocked**. Exactly one runtime materializer/scorer now owns the Bun scenario; its obsolete simulator and duplicate controls were removed. The nine remaining concept exercises included seven component-only scenarios still blocked for missing Compose/device, Angular/browser, audio/listening, and Deno runtime evidence. The newer checkpoint above supersedes these counts. No runtime requirement was waived.

Final verification: **76 tests passed, 0 failed, 730 assertions across six test files** (execution, concepts, Bun runtime, packages, harness, and V5 audit). Backend typecheck and touched-file Prettier checks passed. The global invariant still verifies that every executable full-task fixture starts red. Twelve Bun controls cover valid and alternative implementations, broken starts, exit/cleanup shortcuts, nontermination, lock corruption, duplicate dispatch, runtime availability, and source/report symlinks.

The first expanded run had 67 passes and one aggregate routing timeout at 60 seconds. `skill-eval-harness.test.ts` now runs every original held-out prompt for all 179 packages in nine batches of at most 20 packages, each bounded to 30 seconds. Precision/recall thresholds, expected/forbidden skills, and hierarchy assertions are unchanged; no case was removed. All nine batches passed in the final run.

Verified SHA-256 identities: runtime fixture `7b1b0a19dee78c6178532fbb5305f33d0bceb847898e6b1b9c28e6d614448f68`; runtime controls `4f8d6fb5051ca7dce70533d431e04dad57a8259d722fb9e2f0d423f35a8f97d7`.

Preserve the distinction between a working evaluator, a successful reference control, and demonstrated skill uplift. This continuation establishes the first two for the Bun fixture, not paired live-model superiority, independent blind qualification, or completion of the full library. Keep the compact skill entrypoints unchanged. Next: close another actual-runtime gap or qualify the next blocked domain using the same behavioral/evidence boundary.

### Prior continuation — concept-first fixtures, 2026-09-06

The user refined the objective: keep guidance concept-first, transferable, and compact. Do not multiply niche recipes or require one architecture. Shared principles belong in the parent; a child contributes its actual domain constraints. This is now explicit in `skills-v5/skill-authoring-evaluation/SKILL.md`. Android Compose, Angular, audio production, and Bun/Deno entrypoints were shortened from 2,653 to 1,344 words combined, preserving hierarchy and evidence boundaries; targeted official sources were rechecked and recorded in their source maps.

Added ten evaluator fixtures across those four domains plus AI safety evaluation, with 147 behavioral input variations. Implementation files are `skill-eval-concept-fixtures.ts`, `skill-eval-safety-protocol-fixtures.ts`, `skill-eval-lifecycle-concept-fixtures.ts`, and `skill-eval-media-runtime-concept-fixtures.ts` under `backend/src/kory/`; all are centrally registered. Positive controls and faulty controls live only in `__tests__/skill-eval-concept-fixtures.test.ts`, not materialized subject workspaces.

Readiness at this historical concept-only checkpoint: **358 scenarios, 155 ready, 203 blocked**. Two synthetic AI-evaluation protocols were newly ready. Eight new component exercises remained blocked for full-task execution: they did not yet supply the promised native Compose/device, Angular/browser, audio-stem/render/listening, or actual Bun/Deno compatibility/permission environment. `readinessBlockers` gates both the audit and paired execution. Do not remove a blocker merely because a component simulation passes or a runtime binary is installed. The prior 153 registrations were regression-tested, not newly certified as complete runtime environments in this continuation.

New scorers compare outputs against evaluator-owned expected outcomes, check fixed inputs before and after candidate execution, and bound child execution. This is process separation, **not** a hostile-code OS sandbox. Controls cover broken starts, valid solutions, plausible faulty solutions, self-reported success, modified/missing/symlinked evidence, and nontermination. No live-model uplift, independent blind qualification, listening result, device verification, or competitive superiority was established here.

Resume with the missing high-value runtime adapters or the next blocked domain, retaining these distinctions. Run the concept, execution, package, harness, and V5-audit test files plus backend typecheck after relevant changes. Keep actual evaluation coverage separate from registry presence and preserve failures as regression vectors.

### Original program baseline

- Repository: Koryphaios.
- Current bundled library: 179 skills.
- Cohorts: 79 existing/base+professional skills and 100 V4 specialist skills.
- V4 infrastructure already exists for skill graph/routing, context budgets, draft/activation lifecycle, steward registry, Skill Factory, evaluation ledger, health, and usage.
- The 100 V4 specialists are **not** individually qualified expert skills yet.
- All 100 currently use the same generic positive routing form and the same unrelated negative example.
- Across all 179, 157 have one positive routing example and 176 have one negative example.
- Current foundation tests were previously clean: 54 focused core skill/factory/steward tests, 8 isolated skill-route tests, 9 frontend skills-workspace tests; backend typecheck and Svelte check were clean at that point.
- The worktree contains unrelated pre-existing edits in desktop/MenuBar areas. Preserve them. Do not reset, clean, checkout, or overwrite unrelated user work.

## Non-negotiable subagent policy

The user explicitly requires skill-work subagents to be actual ChatGPT Web agents.

- Only delegate skill research/authoring/review to a model whose actual identity is `chatgpt-web/...`.
- Skill worker display labels: `ChatGPT web — <skill-name>`.
- Never silently substitute GPT-5.6 Sol, Codex, Claude, or another model as the requested skill steward.
- If ChatGPT Web is unavailable or the browser concurrency cap blocks delegation, do the work in the main agent.
- A skill author may not blind-grade its own candidate. Use a separate ChatGPT Web evaluator when delegation is available.
- Keep concurrency below the live ChatGPT Web browser-turn limit so one slot remains for evaluator/coordination work.

## Read first

1. `AGENTS.md`
2. `docs/skill-library-v5-masterplan.md`
3. `backend/src/kory/skills.ts`
4. `backend/src/kory/specialist-skill-definitions.ts`
5. `backend/src/kory/skill-playbooks.ts`
6. `backend/src/kory/skill-evaluations.ts`
7. `backend/src/kory/skill-stewards.ts`
8. `backend/src/kory/skill-factory.ts`
9. `backend/src/kory/skill-health.ts`
10. current skill tests under `backend/src/kory/__tests__/`

## Research sources already identified

Primary patterns and starting points are listed in the masterplan. Re-check current versions before using them. Important sources include:

- Agent Skills spec: https://agentskills.io/specification
- OpenAI skill creator: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
- Anthropic skill authoring: https://support.claude.com/en/articles/12512198-how-to-create-custom-skills
- Anthropic agent eval guidance: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic official skills: https://github.com/anthropics/skills
- Vercel skills: https://github.com/vercel-labs/agent-skills
- Supabase skills/evals: https://github.com/supabase/agent-skills and https://github.com/supabase/evals
- Expo skills/eval harness: https://github.com/expo/skills
- GitHub awesome-copilot: https://github.com/github/awesome-copilot/blob/main/docs/README.skills.md
- Wshobson skills ecosystem: https://github.com/wshobson/agents/blob/main/docs/agent-skills.md
- SecondSky design/technology skills: https://github.com/secondsky/claude-skills
- Remotion skills: https://github.com/remotion-dev/remotion/blob/main/packages/skills/README.md
- Superpowers workflow library: https://github.com/obra/superpowers

Use official docs/specs as truth for product behavior. Community skills are pattern/evidence sources, never executable authority.

## First execution milestone

Do **not** start rewriting 179 skills immediately.

Implement V5.1 + V5.2 foundations first:

1. Define canonical first-class skill package source (`SKILL.md` + optional focused resources + Kory sidecar).
2. Build compiler/migration into the existing Kory runtime representation without losing current local-edit/base-hash/update semantics.
3. Add source provenance/freshness schema.
4. Add V5 eval scenario/experiment/suite structure with skill/no-skill pairing and regression storage.
5. Add pairwise routing-confusion support.
6. Add a durable per-skill V5 audit ledger.
7. Keep activation/promotion behavior backward-compatible and evidence-gated.

Only after those are tested should the individual skill waves begin.

## Per-skill execution contract

For each current skill:

1. Resolve its exact responsibility and adjacent/confusable skills.
2. Research authoritative current sources first.
3. Inspect strong community skills for operational patterns and examples; record provenance/license.
4. Identify concrete current weaknesses; do not assume the masterplan's generic diagnosis is sufficient.
5. Create/refresh source manifest and version scope.
6. Rewrite only the instructions/resources that evidence justifies.
7. Replace generic routing fixtures with >=5 positive, >=5 near-neighbor negative, >=3 ambiguous, >=3 adversarial/negated cases.
8. Add realistic full-task evals and deterministic scorers where possible.
9. Run candidate vs same-model/no-skill baseline.
10. Run separate blind evaluation for non-deterministic quality.
11. Preserve all failures as regression cases.
12. Promote only if measured uplift is meaningful and no material regression remains.

Never qualify a skill from prose length, file count, syntax validation, or self-review alone.

## Recommended skill wave order

1. Skill system / authoring / routing.
2. Design, human experience, frontend craft.
3. Backend, architecture, APIs, distributed systems.
4. Languages/runtimes.
5. Data/databases/search/analytics.
6. Testing/debugging/verification/reliability.
7. Security/privacy/identity/supply chain.
8. Cloud/infrastructure/delivery/operations.
9. AI/ML/agents/retrieval/evals.
10. Research/communication/product/business.
11. Creative/hardware/finance.

The complete current-skill inventory and candidate gap list are in the masterplan.

## Quality gates to preserve

- Precise metadata trigger; no important trigger hidden only in body.
- Focused professional responsibility.
- Authoritative source provenance and version scope.
- Progressive disclosure with only necessary context.
- High-impact correct/incorrect examples where useful.
- Deterministic helpers for repeated/fragile mechanics.
- Falsifiable completion evidence and recovery behavior.
- Held-out routing and full-task evals.
- Skill/no-skill uplift.
- Independent blind review for subjective/high-risk outputs.
- Context/cost/latency tracked alongside quality.
- Portable Agent Skills validation where possible.
- No skill metadata or imported prompt can grant execution authority.

## Competitive benchmark requirement

The user's desired end-state is for Kory's skill-assisted performance to be stronger than current Codex, Claude Code, Cursor, and strong community Agent Skills configurations. Treat this as a benchmark objective, not an assumption.

Run controlled same-task experiments for:

- Kory no-skill baseline;
- current V4 library;
- V5 candidate library;
- current Codex default and relevant official skill when comparable;
- current Claude Code default and relevant official/community skill when comparable.
- current Cursor default and relevant installed/portable skill when comparable;
- Matt Pocock/Agent-Skills community packages when licensing, dependency installation, and comparable runtime setup permit.

For V5 packages, distinguish `model-invoked` reusable disciplines from `user-invoked` orchestrators. Validate composition dependencies before activation, fail closed when required skills are absent or user-only, and keep any optional path/file applicability repository-relative and advisory to semantic routing rather than a replacement for it.

Normalize starting state, task text, available tools, runtime identity, and budget as much as each harness permits. Record any unavoidable mismatch. Use deterministic outcomes first, blind semantic judging second.

## Safety / worktree rules

- Preserve unrelated dirty files.
- Do not use destructive git reset/checkout/clean operations.
- Keep skill imports reviewable and license/provenance tracked.
- Never trust downloaded scripts automatically.
- Do not weaken Kory's existing permission model to make a community skill work.
- Keep agent-authored changes draft-only unless existing learning/promotion policy permits activation.

## Stop condition for each work session

Before ending a session:

- persist audit/progress state;
- record exact skills completed and still in flight;
- record source revisions and eval results;
- record unresolved regressions/blockers;
- run focused tests/typechecks relevant to changed surfaces;
- leave the next actionable skill/wave explicit.

Do not report “the library is done” until every current skill has an individual audit record and the V5 Definition of Done in the masterplan is satisfied.

### Live continuation checkpoint — current-revision audit and independent worker wave

The current checkout was re-audited after a large disjoint worker wave. The live qualification gate remains failing across **182 packages**. Current verified aggregate values are:

- **63 ready, 21 blocked, 36 insufficient-evidence, 62 unmeasured**.
- **327/364** execution scenarios ready; **37** remain blocked: 18 device, 11 synthetic, and 8 repository.
- Static quality is clean across all 182 packages: zero catalog errors/warnings, stale packages, weak-source findings, coverage gaps, portability issues, generic-content findings, duplicate/shared boilerplate, prose em-dash findings, routing-reference gaps, or hierarchy gaps.
- Independent routing passes **187/187** across all 182 skills, with expected recall and forbidden-skill avoidance both equal to 1.
- The current live audit reports **101 packages with two current full tasks, 101 with two paired baselines, 79 with provenanced blind reviews, and five packages containing seven open regression cases**. These current-revision values supersede older handoff snapshots.

The central evaluation ledger remains coordinator-owned. A coordinator campaign for ten executable skills queued 20 current-revision pairs and completed none: all 20 arms were recorded as provider infrastructure failures with the explicit usage-limit message, unavailable until **2026-10-17 20:57**. No pair received qualification credit and no failure was reclassified as a skill result. The campaign emitted per-pair progress independently and preserved the failure records.

The independent blind-review path remains unavailable. The latest read-only diagnostic reports route verification true, browser busy false, browser ready false, canAttempt false, trusted network context unverified, and no completed independent reviewer. The immediate host blocker is the missing `/Users/Shared/micah/.codex-chatgpt-web/runtime/launcher-browser.json` descriptor. Local proxy health or a child CLI network flag cannot establish trusted reviewer provenance.

Evidence-backed package work completed in this continuation without ledger writes:

- `integration-implementation`: added the durable page-mutation plus checkpoint atomic-commit invariant; the prose audit was then repaired to remove an em-dash finding.
- `ml-evaluation`: aligned the evaluator-owned vector contract to the candidate-facing `finalExamples` shape, advanced the fixture generation, and added six contract tests with 113 assertions. Historical failures remain preserved; fresh paired evidence is still required.
- `payment-integration`: added durable operation identity, exact-money, provider-reconciliation, refund/dispute, ledger, and explicit synthetic-boundary guidance without pretending the synthetic fixture proves production behavior.
- `swift-engineering`: advanced the callback materializer/scorer to `@2` and added stale-flight retry plus shared-waiter cancellation vectors and focused regression coverage (**3 tests, 14 assertions**). This revision now requires fresh paired evidence.
- A sealed-task violation identified during review was fully reverted and hash-checked for `secure-authentication/scenario-1.json` and `oauth-oidc/scenario-2.json`; no new sealed-task modification was retained by that worker.

Read-only inventory work covered the full 182-package set and classified each current row by exact gate. The dominant current blockers are revision-bound empirical evidence, failed or missing independent blind review, provider quota exhaustion, and declared native/external environments. Existing artifact references remain present and digest-valid, but stale revision or contract bindings cannot qualify current packages. No blind review, paired result, native result, or promotion was fabricated.

Next actionable work is to preserve the clean static/routing state, run focused tests for the Swift and ML evaluator changes, diagnose only evidenced open regressions when their records are safely accessible, and resume current-revision paired qualification only after a non-exhausted evaluator provider is available. Repair the authorized ChatGPT Web/Codex host before staging any blind review. Keep one coordinator as the only writer of `.koryphaios/skills/evaluations.json`, and process worker completions independently rather than waiting for a batch.

### Live Luna qualification continuation — 2026-10-13

The user explicitly authorized using the authenticated account's `gpt-6-luna` model for Koryphaios candidate qualification. This is candidate execution only; it does not turn Koryphaios skills into Codex or ChatGPT Web skills. The independent blind-review contract remains the separate `chatgpt-web/...` path and was not bypassed.

The coordinator ran current-revision paired evaluations with `gpt-6-luna`, Codex CLI `0.162.1`, reasoning `none`, multi-turn mode, and a 180-second per-arm budget. Results were persisted by the single coordinator writer, with negative outcomes retained:

- `application-security`: task 1 fresh pair was **with-skill pass / without-skill fail** with no infrastructure or integrity failure. Task 2 first partial dispatch was not treated as complete; a fresh complete pair was then **with-skill fail / without-skill fail**, also without infrastructure or integrity failure.
- A five-skill batch (`agentic-systems`, `documents-communication`, `nodejs-runtime`, `testing-engineering`, `functional-verification`) completed all ten pairs with no infrastructure failures. `documents-communication` task 2 first showed a candidate-only required-artifact accounting failure because the model labeled an evaluator-owned paired artifact `unavailable`; a fresh forced pair then passed both arms. `agentic-systems` task 1 had a fresh **skill fail / baseline pass**; task 2 retained **skill pass / baseline fail**. `nodejs-runtime` task 1 was **skill pass / baseline fail**; task 2 failed the current HTTP evidence contract in the skill arm and remained an honest negative. Testing and functional-verification pairs remained recorded as their observed results.
- The reusable qualification runner now stops dispatching new work after a terminal non-retryable provider failure while allowing already dispatched pairs to finish. Focused dispatch tests pass and the runner reports `stoppedReason` and `notStarted`; this does not reclassify or discard provider failures.

The latest qualification audit after these observations reports **63 ready, 79 insufficient-evidence, and 40 blocked** across 182 packages. Execution remains **327/364 ready** with 37 real environment blockers. Current-revision coverage is **106 packages with two full tasks**, **106 with two paired full-task baselines**, and **79 with provenanced blind-review records**; the blind count includes historical/current-selection records and does not mean every current row is ready. There are **24 open regression cases** in the live gate. Static quality remains clean and independent routing remains **187/187** across all 182 skills. The current inventory snapshot is at `outputs/skill-v5-promotion/inventory.md`, `outputs/skill-v5-promotion/inventory.csv`, and `outputs/skill-v5-promotion/audit.json`.

The latest blind-review diagnostic remains fail-closed: route verified, browser not busy, browser not ready, canAttempt false, trusted network unverified, and no completed independent reviewer. The missing launcher descriptor is still `/Users/Shared/micah/.codex-chatgpt-web/runtime/launcher-browser.json`. No reviewer credit or promotion was fabricated. The current package objective remains open until every skill has current empirical evidence, valid independent review, no unresolved regression, and the complete audit exits successfully.

### Luna waves 2 through 5 checkpoint — 2026-10-13 17:02 UTC

Additional bounded `gpt-6-luna` waves completed after the preceding checkpoint. Batch 2 persisted 18 valid pairs and two integrity-invalid controls. Batch 3 persisted 19 valid pairs and one integrity-invalid control. Batch 4 persisted 14 valid pairs, three integrity-invalid pairs, and three complete skips. Integrity-invalid observations remain failed evidence and do not grant promotion credit.

The latest verified audit reports **60 ready, 78 insufficient-evidence, and 44 blocked** across 182 packages. Execution remains **327/364 ready** with 37 environment blockers. Current revision coverage is **116 packages with two full tasks** and **116 with two paired full-task baselines**. Static quality remains clean across all 182 packages, independent routing remains **187/187**, backend typecheck passes, and focused coordinator/evidence tests pass. The current inventory is at `outputs/skill-v5-promotion/inventory.md`, `outputs/skill-v5-promotion/inventory.csv`, and `outputs/skill-v5-promotion/audit.json`.

The next Luna wave is running in `outputs/skill-v5-luna-batch-5-20261013.log`; its first events again show integrity-invalid API cursor and Angular fixture controls. Do not treat those control failures as skill promotion evidence. Continue from the live dry-run queue after the wave settles, preserving every negative, integrity, environment, and reviewer blocker. The full 182-skill objective is still open.
