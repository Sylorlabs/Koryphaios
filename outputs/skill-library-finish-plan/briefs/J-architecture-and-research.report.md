# J-architecture-and-research execution report

Owner: J-architecture-and-research agent. 13 skills.
Evidence source of truth: direct `evaluateSkillPromotion` calls against the live
revision hash, via `outputs/skill-library-finish-plan/tools/j-gate-measure.ts`
(raw output `tools/j-gate.json`; the latest live snapshot is
`j-logs/gate-2026-11-08-final.json`). The shared promotion inventory could not be used
as a snapshot during this session: `scripts/report-skill-v5-promotion-inventory.ts`
aborts with `Evaluation ledger changed during audit; rerun snapshot` because other
group agents are actively running qualification campaigns on this host and writing
the ledger. The per skill gate call reads the same ledger without a global digest
guard.

Ledger ingestion is the coordinator job. Nothing here writes
`.koryphaios/skills/evaluations.json`, `stewards.json`, or another group's skills.

## Group state at start of work (measured 2026-11-07)

| skill | status | candidate / baseline runs | full tasks | paired full tasks | blind (provenanced) | open regressions | exact missing gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| architecture-planning | blocked | 41 / 40 | 2 | 8 | 1 | 4 | negative delta vs matched no-skill baseline; 4 open regressions; 6 excluded runs (stale full-task contract) |
| planning | blocked | 32 / 32 | 0 | 0 | 0 | 1 | no blind review; no full-task coverage; no paired full-task baseline; 1 open regression; 47 excluded (opencode quarantine + stale contract) |
| feature-implementation | blocked | 39 / 38 | 2 | 6 | 1 | 4 | 4 open regressions; 2 excluded (stale full-task contract) |
| refactor-implementation | blocked | 26 / 23 | 2 | 5 | 1 | 1 | 1 open regression |
| implementation | ready | 41 / 40 | 2 | 7 | 1 | 0 | none |
| integration-implementation | blocked | 39 / 38 | 2 | 6 | 1 (failed) | 0 | 1 active provenanced blind review failed semantic evaluation |
| developer-experience | ready | 45 / 44 | 2 | 11 | 1 | 0 | none |
| repository-environment-discovery | ready | 35 / 34 | 2 | 2 | 1 | 0 | none |
| repository-research | ready | 41 / 40 | 2 | 4 | 1 | 0 | none |
| research | insufficient-evidence | 32 / 32 | 0 | 0 | 0 | 0 | no blind review; no full-task coverage or pair; both full tasks environment blocked on a dated historical source corpus |
| literature-research | blocked | 34 / 34 | 2 | 2 | 0 | 1 | no blind review; 1 open regression |
| factual-research | blocked | 34 / 36 | 2 | 2 | 0 | 2 | no blind review; 2 open regressions |
| market-competitive-research | blocked | 48 / 48 | 0 | 0 | 0 | 0 | evaluation contract conflict on both full-task scenarios; no blind review; no full-task coverage or pair |

## Journey log

### Session 2026-11-07

**Gate measurement.** `evaluateSkillPromotion` was called directly for all 13
skills against each live active revision hash
(`outputs/skill-library-finish-plan/tools/j-gate-measure.ts`, raw
`tools/j-gate.json`). The shared inventory script is unusable as a snapshot on
this host right now: it aborts with `Evaluation ledger changed during audit`
because other group agents are writing the ledger concurrently. The per skill
call does not take a global digest and therefore remains valid.

**refactor-implementation: ready.** Open regression source was
`refactor-implementation-full-task-1-individual:c26a1ef7…` (codex gpt-5.6-sol,
recorded 2026-10-07, failed). Reran the open regression through the real paired
campaign:

```sh
bun --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill=refactor-implementation --open-regressions \
  --executor=codex --model=gpt-6-luna --concurrency=2 --wall-clock-ms=420000
```

Result: 1 pair completed, 0 failed, pair
`refactor-implementation-full-task-1-individual:19b1e068-658f-4b37-83c3-0c6614bce18f`,
with-skill passed, without-skill failed, no infrastructure or integrity failure.
Re-evaluated gate: pass/quality/verification 0.9615, deltas +0.591/+0.591/+0.227,
open regressions 0, provenanced blind review 1. Status `ready`. No package content
was edited, so no revision hash changed.

**literature-research: blind review staged.** The blind campaign staged one
review for `literature-research-full-task-1-individual`
(`blind-v5-6d7914624b773a64715c`, reviewer thread
`logfare-stateless-fdef5204-db31-4bab-9de7-b77f4dd5f290`, attempts 1) with a
review attestation and envelope in the campaign's temp stage directory. It is
stage-only evidence: the adapter reports the route and isolation unverified, so
the coordinator must qualify it before ingestion. Nothing was ingested here and
the gate still reports 0 provenanced blind reviews.

**factual-research: blind attempt infrastructure failure, retry in flight.** First
campaign attempt for `factual-research-full-task-1-individual`
(`blind-v5-e03955ff42a86150d95f`) exhausted 3 reviewer attempts and reported
`Reviewer process failed: kory-logfare-stateless-reviewer: failed; diagnostics
redacted. No completed review emitted.` That is an infrastructure failure, not a
verdict, so a single retry was launched. A second failure will be recorded as an
unresolved reviewer-route prerequisite rather than retried further.

**market-competitive-research: contract conflict diagnosed, coordinator action
required.** Two cohorts exist on the same current revision
`89e475f0c892…`, the same suite `market-competitive-research:v5.1.1:held-out`,
and the same materializer/scorer ids (`real-public-sources-v1` /
`public-source-reconciliation-v1`), but with two different contract hashes:
`a3ba65734f9e` (5 runs, recorded 2026-10-10) and `64a08acd6d58` (2 runs, recorded
2026-11-04). That is a task or contract input change without a materializer or
scorer generation change, so `selectContractRuns` cannot pick one active
generation and raises an evaluation contract conflict. Re-running cannot clear
it: a fresh run adds a third hash to the same revision cohort. Resolving it
requires either invalidating a cohort or bumping a generation, both of which are
coordinator decisions and neither of which this agent may perform. It was not
edited. Separately, every current-cohort arm failed with
`Authoritative HTTPS verification failed: <vendor>-pricing: source exceeds size
limit`, so the live-source evaluator could not certify the task even before the
conflict: `posthog-pricing` and `mixpanel-pricing` exceed the materializer's
1.5 MB cap as currently served. That is an external retrieval prerequisite, not a
skill behavior result.

**integration-implementation: failed blind review is a real negative.** The
active provenanced review for `integration-implementation-full-task-1-individual`
at revision `a2d375974e6e` (harness `v5-blind-semantic@8`, provider
`independent-agent`) failed with quality 0.5 and verification 0.3. Its evidence
names concrete defects: deduplication state only in an invocation-local `Map`,
checkpoint advanced before the page commit is durable, and no retry, timeout, or
cancellation behavior. This is the exact failure the skill guidance warns about
(`Commit page progress atomically`), so the negative is kept. It was not retried
to obtain a different verdict.

**research: blocked on a dated historical corpus.** Both full tasks remain
execution blocked because the fixture requires original dated source bytes at a
2026-09-04 cutoff and the required roles are unresolved. The checked-in
`skills-v5/research/evals/README.md` and `source-corpus-plan.json` record the real
Internet Archive observations (HTTP 503 on retry, HTTP 200 with an empty indexed
inventory) and the pinned GitHub candidates. Nothing here was fabricated or
reconstructed, and no snapshot command was run.

**factual-research and literature-research: regression reruns failed.** Reran the
open regression scenarios through the real paired campaign:

```sh
bun --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill=factual-research --skill=literature-research --open-regressions \
  --executor=codex --model=gpt-6-luna --concurrency=2 --wall-clock-ms=420000
```

Result: 3 pairs queued, 3 completed, 0 failed, 0 infrastructure or integrity
failures. Every pair reported `withSkill:false, withoutSkill:false`:
`factual-research-full-task-2-individual:2559dc72…` and `:d5985419…`, and
`literature-research-full-task-2-individual:c8b187d4…`. These are real task
failures, not harness failures, so they stay in the ledger. Observed effect:
factual pass rate 1.0 to 0.889 and 2 open regressions remain; literature pass
rate 0.941 to 0.914 and 1 open regression remains. Neither skill was reclassified
and no assertion or tolerance was touched.

**factual-research: blind reviewer route unresolved.** A single retry (the first
attempt is in the entry above) exhausted all 3 reviewer attempts again and
reported `Reviewer process failed: kory-logfare-stateless-reviewer: failed;
diagnostics redacted. No completed review emitted.` (`availableAssignments` 1,
`reviewed` 0, `staged` 0). No further retry was made. The logfare key is present
and the literature review through the same adapter succeeded, so this is route
instability for this assignment, not a missing credential. It is recorded as an
unmet reviewer prerequisite.

**literature-research: blind review staged, verdict sealed.** The staged
assignment `blind-v5-6d7914624b773a64715c` produced a valid attestation
(`status: unimported`, `validatedReviews: 1`, `persistedReviews: 0`) and a sealed
adjudication. In that adjudication artifact A failed (quality 0.35, verification
0.3) and artifact B passed (quality 0.75, verification 0.65). The A/B to
skill-variant mapping is not present in the import envelope, so the
skill-attributed verdict is not observable from the stage and must not be
inferred. Stage path (temporary, may be cleaned):
`/private/var/folders/kf/5y26484x0571_3cq5b2hfk3w0000gn/T/kory-v5-blind-review-LCKcZa/`.

**feature-implementation: partial regression closure only.** Reran both open
regression scenarios (`bdca0aea…`, `904c8f44…`, `eae366f8…`, `141732df…`). All 4
pairs completed, 0 infrastructure failures. One pair passed on the skill arm
(FT-2 `eae366f8…`), the other three failed on both arms. Open regressions went
from 4 to 3, but observed pass rate went from 1.0 to 0.929 and new failing
current-contract attempts were recorded. Still blocked.

### Session 2026-11-08: independent subagent reviews

The native Claude reviewer was unavailable because `ANTHROPIC_API_KEY` is unset.
Blind judging therefore used the stateless logfare wrapper
(`scripts/kory-logfare-stateless-reviewer`, model
`deepseek-v4.1-flash-1017`) as an independent subagent. Every persisted record
checked had an `agentId` different from the skill steward and nonempty evaluator
provenance, which is the gate's requirement.

**Planning: blind prerequisite met.** A provenanced planning record already
existed when ingestion was attempted (`blind-v5-2dc2bbf1467eedadf0ce`, recorded
2026-11-08T19:10:12.329Z, preference B, with-skill passed, quality 0.86,
verification 0.8, no integrity failure). The importer refused the duplicate with
`EEXIST`, which is the correct protection. The live gate no longer reports a
missing blind review for planning; only 2 open regressions and 46 excluded runs
remain, and the exclusion reason alone does not block a skill.

**Literature: passing review staged but rejected as stale.** Two reviews were
staged. On full task 1 the with-skill artifact failed (quality 0.35, verification
0.3). On full task 2 the with-skill artifact passed (quality 0.78, verification
0.72, preference A, no integrity failure), but ingestion was refused with
`Blind assignment ... is stale; its exact current revision/contract pair is no
longer eligible`. The forced reruns had changed which complete pair the selector
returns, so the assignment no longer bound to a current pair. The review was not
forced in, and the gate still reports zero persisted provenanced reviews for
literature.

**Factual: reviewer route failed again.** One assignment ended in
`Reviewer process failed: kory-logfare-stateless-reviewer: failed; diagnostics
redacted. No completed review emitted.` No envelope was produced and nothing was
ingested.

**Reruns at that snapshot made the evidence worse, and that is recorded.** The
2026-11-08 campaign ran 3 open-regression pairs and 4 fresh full-task pairs with
codex `gpt-6-luna`. All 7 pairs completed with no infrastructure failure. Every
regression arm reported `withSkill:false`, so none closed. The fresh pairs added
failing current contract observations: literature pass rate moved from 0.914 to
0.821 and open regressions from 1 to 2; factual pass rate moved below both
floors, to 0.727 with verification below 0.8, and 2 regressions remained at that
snapshot. Later sanctioned campaigns changed the live aggregate; the final
measurement below and `j-logs/gate-2026-11-08-final.json` are the authority.

**Final measurement after all available executors.** The remaining regression
and pair campaigns ran through the two executor families that can execute these
environments: logfare for repository scenarios, and codex `gpt-6-luna` or
`gpt-5.6-sol` for public-web and repository scenarios. Logfare was tried with
`deepseek-v4.1-flash-1017`, then with `glm-5.3`, the strongest model the live
route actually serves. The config model list also names `claude-opus-4.6` and
other GPT entries, but the route returns 404 for them, so they were not usable. The
logfare open-regression campaign completed 6 of 6 runs with 0 failures: planning
failed both arms, feature with-skill passed 3 of 3 but the final compatible run
was a failing no-skill arm, and architecture passed both arms. The codex
`gpt-6-luna` open-regression campaign completed 6 of 6 runs with 0 failures, and
both arms failed on every planning, factual, and literature pair it queued. A
fresh logfare integration campaign completed one arm and then hit a provider
error on full task 1; its completed with-skill arm failed. A codex `gpt-5.6-sol`
campaign ran fresh integration and literature pairs: all 4 pairs completed, with
0 infrastructure failures, and every with-skill arm failed.

The live gate after those runs reported architecture-planning 0.909 pass with 1
open regression and a verification delta of -0.077; planning 0.971 pass with 2
open regressions; feature-implementation 0.867 pass with 3 open regressions;
integration-implementation 0.842 pass with 0 open regressions and one failed
active blind review; literature-research 0.914 pass with 1 open regression and no
blind review; factual-research 0.889 pass with 2 open regressions. One more
logfare campaign with `glm-5.3` reran both planning regression pairs and both
arms failed again; it did not queue feature or architecture regressions. The
stale model attempts are infrastructure failures and are excluded, not skill
failures. The live snapshot also reports 2 infrastructure failures under
refactor-implementation and 4 under repository-research; both are excluded and
neither ready status changed. No threshold was lowered and no failure was
reclassified.

**Incidental write outside this group.** A probe of the campaign script with
`--help` was not a help request. The script has no help flag, so it treated the
invocation as a request with no skill filter, started the default
`omnirush-text-patch` executor across 182 skills, and stopped on the first
scenario because OmniRush reports maintenance. That recorded two
infrastructure-failed runs for `accessibility-practice` at 19:12 (both arms,
provider omnirush, model gpt-6-astra). They are infrastructure failures and are
excluded from observed evidence, but they are ledger writes outside this group
and are reported rather than hidden. No skill file was edited.

## Final state

Every skill ends in `ready`, `blocked-external`, or a recorded refusal, and no
skill is `staged-awaiting-ingest`. A refusal means the live gate itself returned
not ready for a measured skill reason; it is not an external dependency.

| skill | final state | exact gate | evidence from this session |
| --- | --- | --- | --- |
| refactor-implementation | ready | none | regression pair rerun passed, gate clean |
| implementation | ready | none | none needed |
| developer-experience | ready | none | none needed |
| repository-environment-discovery | ready | none | none needed |
| repository-research | ready | none | none needed |
| architecture-planning | refused | 1 open regression; verification delta -0.077; 6 excluded runs | rerun passed both arms, so the negative delta is not a stale artifact |
| planning | refused | 2 open regressions | logfare deepseek, logfare glm-5.3, and codex gpt-6-luna reruns failed on the regression scenario |
| feature-implementation | refused | 3 open regressions | 3 logfare with-skill reruns passed, then the latest compatible run of the scenario was a failing no-skill arm, which reopens them under the latest-attempt rule |
| integration-implementation | refused | 1 active provenanced blind review failed | fresh logfare pair with-skill failed; full task 1 also hit a logfare provider error; codex gpt-5.6-sol with-skill failed on both full tasks |
| literature-research | refused | no persisted provenanced blind review; 1 open regression | codex gpt-5.6-sol with-skill failed on both full tasks, so no pair was blind-eligible |
| factual-research | refused | 2 open regressions | codex gpt-6-luna reruns failed both arms; no new blind review was possible |
| research | blocked-external | gate reports `insufficient-evidence`: no full-task coverage, no paired baseline, no blind review | corpus rules forbid a snapshot while roles are unresolved |
| market-competitive-research | blocked-external | evaluation contract conflict on both full-task scenarios; no full-task coverage or baseline; no blind review | materializer or scorer generation must change before requalification |

Count: 5 ready, 2 blocked-external, 6 refused, 0 staged-awaiting-ingest. The live
snapshot is `j-logs/gate-2026-11-08-final.json`.

## Actions refused or declined

No action was refused by a safety or approval layer. The following were
deliberately not done because they are out of agent scope or would fabricate or
cherry-pick evidence:

- Did not bump the market materializer or scorer generation, and did not
  invalidate a ledger cohort. Both would change shared promotion semantics to
  fit one package, which the work order forbids.
- Did not retry the failed integration-implementation blind review to seek a
  different verdict. The negative evidence describes real defects and stands.
- Did not retry factual-research's blind review beyond one retry after two full
  three-attempt failures.
- Did not run the research snapshot command, synthesize a dated source, or
  promote a discovery lead to a qualifying corpus.
- Did not modify the shared inventory script to bypass its concurrent-write
  guard, and did not write the promotion ledger or `stewards.json`.

## Shared files touched

No file under `skills-v5/`, `backend/`, or `.koryphaios/skills/stewards.json` was
edited, and no skill revision hash changed. Sanctioned campaigns appended
evaluation runs to `.koryphaios/skills/evaluations.json`: the earlier 3
open-regression pairs, 4 fresh full-task pairs, and 2 infrastructure-failed
accessibility-practice runs, plus the logfare and codex campaigns described in
the final measurement. No run was written by hand. The planning blind record already existed under
`.koryphaios/skills/blind-reviews/`; ingestion of a duplicate was refused with
`EEXIST`. No threshold, exclusion, or quarantine rule was changed. Added
artifacts:

- `outputs/skill-library-finish-plan/briefs/J-architecture-and-research.report.md`
- `outputs/skill-library-finish-plan/tools/j-gate-measure.ts` and `j-gate.json`
- `outputs/skill-library-finish-plan/tools/j-open-regressions.ts`
- `outputs/skill-library-finish-plan/tools/j-contract.ts`
- `outputs/skill-library-finish-plan/tools/j-run-dump.ts`
- `outputs/skill-library-finish-plan/tools/j-blind.ts`
- `outputs/skill-library-finish-plan/j-logs/*.log`
- `outputs/skill-library-finish-plan/j-logs/gate-2026-11-08-final.json`
- `outputs/skill-library-finish-plan/j-logs/gate-2026-11-08-after-runs.json`

## Where the library disagrees with observable reality

1. **The shared inventory cannot run under concurrency.**
   `scripts/report-skill-v5-promotion-inventory.ts` takes a digest of
   `.koryphaios/skills/evaluations.json` before and after a multi minute audit and
   aborts with `Evaluation ledger changed during audit; rerun snapshot` whenever
   another group writes a run. With several group agents active this is the normal
   case. A per skill `evaluateSkillPromotion` call is the reliable measurement.
2. **A materializer set change produces a false contract conflict.** For
   market-competitive-research the two cohorts share revision `89e475f0c892`,
   suite `v5.1.1`, materializer `real-public-sources-v1` and scorer
   `public-source-reconciliation-v1`, yet carry hashes `a3ba65734f9e` (5 runs,
   2026-10-10) and `64a08acd6d58` (2 runs, 2026-11-04). The task fixtures are not
   modified in the worktree. The current matching materializer set now also
   contains `market-competitive-research/external-environment-gate/…@1`, and the
   contract hash is computed over the full matching set while generation
   dominance is keyed on the single `materializerId` recorded on a run. Adding the
   gate therefore changes hashes without advancing a generation. This needs a
   shared gate decision, not a package edit.
3. **The market full task cannot currently retrieve its own sources.** Both
   cohorts failed every arm with `Authoritative HTTPS verification failed:
   posthog-pricing: source exceeds size limit` or `mixpanel-pricing: source
   exceeds size limit`, against the materializer's 1.5 MB cap. The fixture cannot
   certify a live result while the authoritative pages exceed that bound.
4. **Uncommitted planning fixture edits removed all full-task credit.**
   `skills-v5/planning/evals/tasks/scenario-{1,2}.json` were changed in this dirty
   worktree (mtime 2026-11-06 23:11, before this session) to replace
   `Acceptance criteria` with long observable-gate assertions, without a
   materializer or scorer generation change. Every earlier planning run is
   therefore excluded and full-task coverage reads 0 despite 47 excluded runs. The
   coordinator must decide whether to commit those edits and requalify or revert
   them; this agent preserved them untouched.
5. **Live full-task execution is currently hard for the research skills.** All
   factual and literature regression pairs failed on both arms on the codex
   `gpt-6-luna` route, and fresh codex `gpt-5.6-sol` integration and literature
   pairs failed every with-skill arm. This is a real capability result and is
   left as evidence.
6. **The logfare reviewer route is not reliable per assignment.** It completed
   literature-research and another group's postgres review, and failed two
   factual-research campaigns and one market-competitive-research campaign with
   `reviewer process failure` after retries. Route qualification is still the
   coordinator's, and the adapter itself declares the route and isolation
   unverified.

## Second pass (2026-11-07, same session)

After the first report I ran the remaining feasible campaigns and re-measured.
Commands, all with `--executor=codex --model=gpt-6-luna --concurrency=2
--wall-clock-ms=420000`:

- `--skill=planning` full-task qualification: 4 arms, 0 failed, 0 notStarted.
  Planning now has full-task coverage 2 and a paired full-task baseline, which
  removes its missing-coverage and missing-pair reasons.
- `--skill=architecture-planning --skill=feature-implementation
  --open-regressions`: 7 queued, 7 completed, 0 failed, 0 infrastructure
  failures.

Measured effect:

| skill | before | after | still open |
| --- | --- | --- | --- |
| architecture-planning | 4 open regressions, verification delta -0.083 | 1 open regression, verification delta -0.077, pass rate 0.909, verification 0.955 | verification delta is negative; 1 regression |
| feature-implementation | 3 open regressions, pass 0.929 | 3 open regressions, pass 0.867 | 3 regressions |
| planning | coverage 0, pair 0, 1 regression | coverage 2, pair 2, 2 regressions, pass 0.971 | blind review 0; 2 regressions |

Architecture-planning's verification delta stayed negative after the skill arm
won almost every rerun, so it is not a stale-run artefact. Feature's reruns did
not close a regression and lowered its pass rate. Planning's full-task pairs
revealed two failing regression scenarios that were previously untested.

### Why the blind-review blockers are not closable from this agent

Prepared assignments are persistent. `--prepare-only` writes
`<assignmentId>.prompt.txt` and `<assignmentId>.private.json` under
`.koryphaios/skills/blind-reviews/pending`, and the campaign seals those same
paths. The part that never persists is the review envelope. The campaign sets
`reviewOnly = true`, rejects `--ingest` outright, and `stageReviewOnly` records
`status: "unimported"` with `validatedReviews: 1, persistedReviews: 0`. Its stated
reason is that a generic adapter reports `routeVerified: false` and
`isolationVerified: false`; its detail says the evidence "requires coordinator
qualification before ingestion".

The official importer could read a staged envelope while the pending record still
exists, because the assignment is not in temp. Running it would persist a review
the campaign deliberately marked unqualified, which reclassifies the evidence, so
it was not done. The only adapter with a verification story is `chatgpt-web`.
Diagnosed on 2026-11-08 it returned `canAttempt: false`, `routeVerified: false`,
`browserBusy: false`, detail "ChatGPT Web route is inactive or does not match the
configured reviewer endpoint" against `http://127.0.0.1:17841/v1`. Playwright
Chromium is installed, but the control route is not active, so no qualified blind
review can be produced here.

Consequence: planning, factual-research, research and market-competitive-research
cannot gain the blind review the gate requires, and literature cannot persist the
review it already staged.

### Integration's failed review is an execution failure, not judge noise

The active failed review is `blind-v5-184d8f2d5384ca42ba21` on revision
`a2d3759...`, scenario `integration-implementation-full-task-1-individual`. Its
sealed mapping is A = without-skill, B = with-skill, and the judge preferred A.
The with-skill artifact scored `passed: false`, quality 0.5, verification 0.3, and
the rationale cites host checks that failed for both arms: duplicate and
correction upsert once per external id with the checkpoint after page commit, and
interruption checkpointing the last fully committed page. Re-judging the same
artifacts could not legitimately flip that, and the importer rejects reviews that
contradict source evidence. Fixing it needs a revised skill plus full-task
execution that actually passes those host checks, then a new persisted review. A
revision change also resets the revision-scoped blind review count to 0, so a
revision alone does not unblock it.

### Research is not closable from this agent

`skills-v5/research/evals/README.md` states the snapshot command must not be run
while any role is unresolved, that the sidecar refuses an incomplete corpus, and
that even a complete corpus leaves the synchronous readiness gate blocked until
the independent asynchronous preflight is integrated. The four recorded audits
remain index errors and verified Git pins, not qualifying bytes. Running the
snapshot now would either refuse or manufacture a corpus, so it was not run.

## Next actions for the coordinator

1. Planning needs 2 passing regression attempts on the current contract. Logfare
   `deepseek-v4.1-flash-1017`, logfare `glm-5.3`, and codex `gpt-6-luna` all
   failed them, so a revised skill is required before another campaign.
2. Literature needs a with-skill full-task pass before a blind review can be
   prepared. Codex `gpt-5.6-sol` failed both full tasks, so do not stage a review
   until an artifact passes.
3. Factual needs 2 regression closures and a stronger public-web executor. Codex
   `gpt-6-luna` failed every regression pair it ran, and the logfare route does
   not execute public-web scenarios.
4. Feature needs a later passing run of the scenario, including the no-skill arm.
   More with-skill passes alone do not help while the latest compatible run is a
   failing no-skill arm.
5. Integration needs a revised artifact that passes the host checks, then a fresh
   pair and a new blind review. The existing failed review stands.
6. Reconcile the market contract cohorts and the materializer set hashing, then
   requalify both full tasks and resolve the 1.5 MB source cap.
7. Research stays blocked until the corpus roles are resolved and the asynchronous
   preflight is integrated. Do not run the snapshot command before that.
8. Architecture-planning needs a current-contract rerun that turns the
   verification delta positive. The current negative delta is a measured result.
