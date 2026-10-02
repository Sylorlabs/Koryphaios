# Koryphaios Skill Library V5 — Execution Handoff / Compaction

Use this file to resume the skill-quality program without needing the originating conversation.

## Goal

Execute `docs/skill-library-v5-masterplan.md` until all current skills are individually researched, rewritten where warranted, benchmarked, and qualified. The objective is measurable skill quality, not catalog size.

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
