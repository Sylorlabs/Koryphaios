# I-verification-and-debugging report

Group owner: Agent 9. Final update 2026-11-08, after the coordinator ingestion pass and the follow-up logfare rerun.

## Final outcome

All 15 skills in this group are `ready` under `evaluateSkillPromotion` on their current revision. Ten were already ready. Two were waiting on staged blind reviews. Three were blocked. The last five were closed with fresh evidence and five validated review ingestions. A follow-up logfare rerun added two perfect concurrency pairs and a sixth review, and it also recorded four failing integration-fault-testing runs. No skill package content was edited, so every paired run still binds to the revision it was recorded against.

| Skill | Final state | Revision | Pass | Verification | Quality | Paired cases | Blind | Open regressions |
|---|---|---|---|---|---|---|---|---|
| debugging | ready | 26261ec203a6 | 0.960 | 1.000 | 0.990 | 24 | 1 | 0 |
| deterministic-debugging | ready | a3a9e45455f5 | 1.000 | 1.000 | 1.000 | 22 | 1 | 0 |
| distributed-debugging | ready | ba449dad91da | 1.000 | 1.000 | 1.000 | 24 | 1 | 0 |
| concurrency-debugging | ready | 9b1a1aec4591 | 0.857 | 0.857 | 0.929 | 27 | 1 | 0 |
| performance-debugging | ready | 18bde5c0657e | 1.000 | 1.000 | 1.000 | 20 | 1 | 0 |
| property-fuzz-differential-testing | ready | 5c45dbdffdac | 0.944 | 0.944 | 0.944 | 20 | 1 | 0 |
| deterministic-contract-testing | ready | 4a831046a2f9 | 0.913 | 0.913 | 0.913 | 21 | 1 | 0 |
| testing-engineering | ready | 4ec39147bead | 0.972 | 0.972 | 0.972 | 20 | 1 | 0 |
| integration-fault-testing | ready | aa08b4ccfcbd | 0.868 | 0.868 | 0.916 | 22 | 1 | 0 |
| performance-testing | ready | d6737785f7f0 | 0.897 | 0.897 | 0.897 | 20 | 1 | 0 |
| performance-verification | ready | e40133433247 | 0.878 | 0.976 | 0.927 | 22 | 1 | 0 |
| functional-verification | ready | d01e775db48e | 0.947 | 0.947 | 0.947 | 22 | 1 | 0 |
| verification | ready | 0fedb7e3f8b4 | 1.000 | 1.000 | 1.000 | 21 | 1 | 0 |
| release-planning | ready | 703717de8094 | 0.975 | 0.975 | 0.975 | 22 | 1 | 0 |
| migration-planning | ready | 046f1a7682bc | 0.957 | 0.957 | 0.957 | 24 | 1 | 0 |

Group totals: 15 ready, 0 staged, 0 blocked, 0 unmeasured.

## How the last five were closed and the follow-up rerun

### debugging

Review `blind-v5-2bf198763e692d6968b7` was staged on the newest pair, `debugging-full-task-1:52bacd01-ab34-49cc-8d58-c93560abcc31`. Both artifacts passed at quality 0.9 and 0.9, with a preference tie. The envelope validated with `validatedReviews: 1` and ingested with `persistedReviews: 1`. Gate moved from `insufficient-evidence` with blind 0 to `ready` with blind 1.

### release-planning

Review `blind-v5-74796c6c36763c4ca392` was staged on pair `release-planning-full-task-1-individual:d3d4a368-4613-4d5a-9d82-2c85ea0ddbce`. The with-skill artifact passed at 0.85 quality and 0.70 verification. The baseline artifact failed at 0.1 and 0.0. The sealed mapping recorded `withIsA: false`, so artifact B was the with-skill arm. Validation and ingestion each returned one review. Gate moved from `insufficient-evidence` to `ready`.

### migration-planning

Review `blind-v5-244b875697bccf09cafb` was staged on pair `migration-planning-full-task-1-individual:3b570228-7fb3-42c5-89ae-ae400e46a926`, generated 2026-11-04. Both artifacts passed, at quality 0.88 and 0.68 and verification 0.75 and 0.70. Validation and ingestion each returned one review.

The earlier failure was recorded 2026-10-03 on pair `06c2761a`, which is older. After ingestion the gate excludes that review because a newer current pair for the scenario has been reviewed. The failed run remains in the ledger as historical evidence. It was not deleted, rewritten, or reclassified.

### deterministic-contract-testing

The prior failed review was recorded 2026-10-21 on pair `9f2a85af` under harness `@8`. The newest complete pair under the current contract was `4b384eed`, recorded 2026-11-07T22:00:46Z. The retry path selected that pair, not the failed one.

- Review `blind-v5-bc1461eb773f681fe1e1`, reviewer thread `logfare-stateless-f4eec799-5353-4e3a-ae5e-7faa04d8b4b7`.
- Both artifacts passed at quality 0.9 and verification 0.85. Preference tie. Sealed mapping `withIsA: true`, so artifact A is the with-skill arm.
- Envelope `/private/var/folders/kf/5y26484x0571_3cq5b2hfk3w0000gn/T/kory-v5-blind-review-DPqNnV/import.json`. Validation and ingestion each returned one review.
- Gate moved to `ready` with blind 1. The older failure is now historical under the gate's pair recency selection.

The scorer fix from the earlier phase remains in place at `job-command-schema-state-machine-scorer@3`. Both deterministic tasks pass. Eight older task-2 runs remain excluded because they were recorded under `@2`.

### concurrency-debugging

The September regression source was closed with fresh paired evidence on the unchanged scorer and contract.

- Command: `bun run scripts/run-skill-v5-qualification-campaign.ts --skill=concurrency-debugging --open-regressions --executor=codex --model=gpt-6-luna --reasoning-effort=high --concurrency=1`
- Pair `concurrency-debugging-full-task-1:ac878562-f38b-4977-913c-f3a52b5acb91`, with-skill and without-skill arms complete, no infrastructure or integrity failure.
- With-skill run: passed, quality 1.0, verification 1.0. The preserved artifact now holds `preFix` evidence with a provenance note and replay receipt, the two order timelines, the violated invariant, the correction scope, the controls, the explicit simulation limits, and a regenerated `repeatabilityRegression` with 25 iterations and zero failures.
- The without-skill arm also scored 1.0, so this particular pair is a tie. It closes the regression but adds no measured lift. The positive gate delta comes from the existing pair set.
- Review `blind-v5-bae6cbfc70752595751c`, reviewer thread `logfare-stateless-adbd3278-303a-4235-9a60-66535eb3173c`, pair `ac878562`, sealed mapping `withIsA: true`. Artifact A passed at 0.9 quality and 0.9 verification. Envelope `/private/var/folders/kf/5y26484x0571_3cq5b2hfk3w0000gn/T/kory-v5-blind-review-VJuyFY/import.json`. Validation and ingestion each returned one review.

A follow-up logfare rerun on 2026-11-08 added two complete pairs: `concurrency-debugging-full-task-1:8c57e85d-e2e2-413e-9508-b3ec469d89ef` and `concurrency-debugging-full-task-2:679b4bd8-88b4-4aef-8d76-1e6e51cb60bb`. Both arms passed at quality 1.0 and verification 1.0, with no infrastructure or integrity failure. A fresh review, `blind-v5-579733503fd03081f036`, reviewer thread `logfare-stateless-44cb04f9-80de-4c67-a9b1-840ab883431b`, was staged on pair `8c57e85d`; both artifacts passed at quality 0.9 and verification 0.9, with preference B. The importer exited 0 and appended exactly one blind-review run on that pair, which supersedes the earlier `ac878562` review for full-task-1 under the gate's pair recency rule. The gate moved from 0.851 pass, 0.851 verification, 0.926 quality and 25 paired cases to 0.857, 0.857, 0.929 and 27 paired cases. The two new pairs were ties at 1.0 on both arms, so they raise the pooled rate by adding passes rather than by showing a with-skill advantage.

Only one of the two new pairs could be reviewed. The review campaign caps current reviews at 2 per skill, and the earlier review on `ac878562` still occupies one slot, so the full-task-2 pair is unreviewed.

The earlier staged review `blind-v5-fcd2d2b07bb7f485d553` was not ingested. It was bound to pair `41050af1`, which the newer `ac878562` pair supersedes, so it could never qualify.

The earlier candidate failure is still the honest record: two models under default reasoning produced a `concurrency-save.json` containing only the repeatability record. The task text already required the other sections and already allowed a test to read and rewrite the artifact without losing them. The pass came from a different model configuration, not from a weakened scorer or a changed task.

## Repository and safety

- Repository: `/Users/Shared/micah/documents/koryphaios`.
- The worktree was already dirty with 1774 entries at session start. No pre-existing change was reverted, cleaned, checked out, or overwritten.
- No skill package content was edited by this group. `SKILL.md`, `kory.json`, `references/`, and `evals/` are unchanged for all 15 skills, so every recorded run still binds to its revision hash.
- `.koryphaios/skills/evaluations.json` and `.koryphaios/skills/stewards.json` were not hand edited. Paired runs were appended by the qualification campaign. Reviews were appended by the official importer with `--ingest` after `--validate-only`.
- No threshold, scorer tolerance, exclusion, fixture expectation, or failure classification was lowered.
- No commit, push, or deploy was performed.

## Gate measurements

Measured with a temporary reader built on `evaluateSkillPromotion` and `listSkills`, removed before handoff. `delta` is pass, quality, verification against the matched no-skill baseline.

| Skill | Status | Pass | Verification | Quality | Paired | Blind | Open | Delta |
|---|---|---|---|---|---|---|---|---|
| debugging | ready | 0.960 | 1.000 | 0.990 | 24 | 1 | 0 | +0.708, +0.708, +0.042 |
| deterministic-debugging | ready | 1.000 | 1.000 | 1.000 | 22 | 1 | 0 | +0.364, +0.364, 0 |
| distributed-debugging | ready | 1.000 | 1.000 | 1.000 | 24 | 1 | 0 | +0.500, +0.417, 0 |
| concurrency-debugging | ready | 0.857 | 0.857 | 0.929 | 27 | 1 | 0 | +0.296, +0.296, 0 |
| performance-debugging | ready | 1.000 | 1.000 | 1.000 | 20 | 1 | 0 | +0.800, +0.800, 0 |
| property-fuzz-differential-testing | ready | 0.944 | 0.944 | 0.944 | 20 | 1 | 0 | +0.400, +0.400, 0 |
| deterministic-contract-testing | ready | 0.913 | 0.913 | 0.913 | 21 | 1 | 0 | +0.429, +0.393, 0 |
| testing-engineering | ready | 0.972 | 0.972 | 0.972 | 20 | 1 | 0 | +0.800, +0.800, 0 |
| integration-fault-testing | ready | 0.868 | 0.868 | 0.916 | 22 | 1 | 0 | +0.409, +0.382, +0.045 |
| performance-testing | ready | 0.897 | 0.897 | 0.897 | 20 | 1 | 0 | +0.850, +0.850, +0.050 |
| performance-verification | ready | 0.878 | 0.976 | 0.927 | 22 | 1 | 0 | +0.909, +0.886, +0.136 |
| functional-verification | ready | 0.947 | 0.947 | 0.947 | 22 | 1 | 0 | +0.364, +0.364, 0 |
| verification | ready | 1.000 | 1.000 | 1.000 | 21 | 1 | 0 | +0.857, +0.786, 0 |
| release-planning | ready | 0.975 | 0.975 | 0.975 | 22 | 1 | 0 | +0.727, +0.714, 0 |
| migration-planning | ready | 0.957 | 0.957 | 0.957 | 24 | 1 | 0 | +0.375, +0.375, +0.042 |

Excluded evidence is reported by the gate but does not block these packages: `debugging` has 16 excluded runs, `verification` has 4, `performance-verification` has 21, and `deterministic-contract-testing` has 8. Those are named in the per-skill sections.

## Per-skill work log

### debugging

Fresh paired runs closed three regressions earlier in the session. The 16 excluded runs are OpenCode stateless evidence, quarantined for lack of an enforced isolation boundary, plus evidence against superseded task contracts. The passing review on the newest pair was ingested in this phase. State: `ready`.

### deterministic-debugging

Already ready. Re-measured ready with pass 1.000, verification 1.000, 22 paired cases, blind 1, open regressions 0. No action.

### distributed-debugging

Already ready. Re-measured ready with pass 1.000, verification 1.000, 24 paired cases, blind 1, open regressions 0. No action.

### concurrency-debugging

Initial gate had five open regressions. Fresh pairs reduced them to one. Two default reasoning retries reproduced the artifact omission. A third retry at high reasoning on the unchanged contract produced a complete artifact and closed the regression. A fresh review on that pair was ingested. State: `ready`.

### performance-debugging

Already ready. Re-measured ready with pass 1.000, verification 1.000, 20 paired cases, blind 1, open regressions 0. No action.

### property-fuzz-differential-testing

Already ready. Re-measured ready with pass 0.944, verification 0.944, 20 paired cases, blind 1, open regressions 0. No action.

### deterministic-contract-testing

A scorer defect was diagnosed and fixed earlier: the task-2 scorer hardcoded `tests/job-contract.test.ts` while a valid candidate wrote `test/job-contract.test.ts`. The fix runs the candidate's discovered test files and moved the scorer to `@3`. Eight task-2 runs from `@2` remain excluded. A fresh review on the newest current pair replaced the active failure. State: `ready`.

### testing-engineering

Already ready. Re-measured ready with pass 0.972, verification 0.972, 20 paired cases, blind 1, open regressions 0. No action.

### integration-fault-testing

Already ready. Re-measured ready with pass 0.868, verification 0.868, quality 0.916, 22 paired cases, blind 1, open regressions 0.

A follow-up logfare rerun was attempted on 2026-11-08 with `deepseek-v4.1-flash-1017` and a 180 second wall clock. It did not improve this skill. Both scenarios recorded failing runs. Pair `integration-fault-testing-full-task-1:822a94bb-37b9-46b1-81cc-c1e8ee5d08e8` scored 0.6 and 0.0. Pair `integration-fault-testing-full-task-2:e55fa5c7-6fc7-4b93-aa91-b9d207799d0c` scored 0.0 and 0.6. The with-skill arm scored 0.0 in both pairs, and the without-skill arm scored 0.6. The task 1 with-skill arm exceeded the 180 second budget. The task 2 call received a logfare in-stream provider error. The runs are recorded with `integrityFailure: false` and `passed: false`; they were not deleted or reclassified. The gate still measures 0.868 pass, 0.868 verification, 0.916 quality, 22 paired cases, blind 1, and zero open regressions.

### performance-testing

Already ready. Re-measured ready with pass 0.897, verification 0.897, 20 paired cases, blind 1, open regressions 0. No action.

### performance-verification

A final retry with `gpt-5.6-sol` closed the last regression earlier. The 21 excluded runs are contract mismatches and remain informational. The follow-up logfare rerun never reached this skill: the campaign stopped on the logfare provider error after the integration-fault-testing scenarios, so no new evidence was produced. State: `ready`.

### functional-verification

Already ready. Re-measured ready with pass 0.947, verification 0.947, 22 paired cases, blind 1, open regressions 0. No action.

### verification

Fresh paired runs closed the regression earlier. The 4 excluded runs remain informational. State: `ready`.

### release-planning

The regression and negative verification delta were closed earlier with two paired runs. The staged review was ingested in this phase. State: `ready`.

### migration-planning

All deterministic evidence already passed. The replacement review was staged on a newer pair and ingested. The gate now excludes the older failed pair by its own recency rule. State: `ready`.

## Shared files touched

1. `backend/src/kory/skill-eval-contract-concurrency-fixtures.ts`. Fixed the deterministic-contract-testing task-2 scorer path and moved `job-command-schema-state-machine-scorer` from `@2` to `@3`.
2. `backend/src/kory/__tests__/skill-eval-v5-targeted-regressions.test.ts`. Updated the `@3` expectation and added a singular `test/` positive control plus a no-tests negative control.
3. `.koryphaios/skills/evaluations.json`. Appended only through `recordSkillEvaluationRun` by the qualification campaign and the official importer. No hand edit.
4. `.koryphaios/skills/blind-reviews/pending/`. Staged review records for debugging, release-planning, migration-planning, concurrency-debugging, and deterministic-contract-testing.
5. `.koryphaios/skills/blind-reviews/`. Imported assignment records for the six ingested reviews, including the follow-up concurrency review `blind-v5-579733503fd03081f036`.
6. `.koryphaios/skills/eval-artifacts/`. Campaign evidence directories, including the new concurrency pairs.
7. `outputs/skill-library-finish-plan/logs/qualification-lowest3-2026-11-08.log` and `outputs/skill-library-finish-plan/logs/review-concurrency-2026-11-08.log`. Campaign and review transcripts for the follow-up rerun.
8. `outputs/skill-library-finish-plan/briefs/I-verification-and-debugging.report.md`. This report.
9. Temporary readers created and deleted in this phase: `scripts/tmp-ledger-i.ts`, `scripts/tmp-blind-i.ts`, `scripts/tmp-gate-i.ts`, `scripts/tmp-run-i.ts`, and earlier `scripts/tmp-diag-i.ts`, `scripts/tmp-dump-i.ts`, `scripts/tmp-keys-i.ts`, `scripts/tmp-art-i.ts`. None remain.

No file in `skills-v5/` was modified.

## Refused actions

- I did not hand edit `.koryphaios/skills/evaluations.json` or `.koryphaios/skills/stewards.json`.
- I did not delete, rewrite, or reclassify the failed deterministic-contract-testing or migration-planning reviews. Both remain in the ledger as historical evidence and are excluded only by the gate's existing pair recency rule.
- I did not delete, rewrite, or reclassify the four failing integration-fault-testing runs recorded by the follow-up rerun. They remain in the ledger with `passed: false`.
- I did not force a provider in any skill package or product configuration. The logfare executor and model were selected only for the follow-up campaign invocation.
- I did not lower a threshold, widen an exclusion, weaken a scorer, or delete a failing run.
- I did not change the concurrency-debugging materializer, task text, or scorer to make the artifact requirement easier. The retry ran on the unchanged contract and the passing artifact met the existing requirement.
- I did not rewrite the deterministic-contract-testing or migration-planning skill prose to clear a review. No guidance defect was established, and a content edit would invalidate their paired runs.
- I did not use OpenCode evidence, which the eligibility gate quarantines for lack of a qualified isolation boundary.
- I did not claim reviewer route or isolation verification. All independent reviews were stage-only from the logfare adapter with `routeVerified: false` and `isolationVerified: false`. I ingested them only after the importer validated the sealed assignment, prompt hashes, artifact hashes, reviewer separation from the steward, and pair evidence. This limitation is recorded below.
- I did not ingest the older concurrency review on pair `41050af1`, because a newer pair superseded it.
- I did not commit, push, or deploy.
- No safety or approval layer refused an action in this session.

## Library and reality disagreements

1. `scripts/report-skill-v5-promotion-inventory.ts` cannot complete on the live shared worktree. It failed twice with `error: Evaluation ledger changed during audit; rerun snapshot` because another writer changed `.koryphaios/skills/evaluations.json` between the before and after digests. A single authoritative inventory needs a stable snapshot or a shared lock. The group measurements here come from `evaluateSkillPromotion` directly.

2. The brief stated 120 blocked and 20 insufficient evidence. The live gate measured 119 blocked and 21 insufficient evidence at session start. The package that moved is outside this group. This is a measurement difference, not a reclassification.

3. The brief says ledger ingestion is the coordinator job, but `run-skill-v5-qualification-campaign.ts` persists paired runs directly through `recordSkillEvaluationRun`. Only blind reviews go through the staging and import path.

4. Correction to an earlier finding in this report: the blind review gate does support supersession. `selectQualificationContractRuns` keeps only reviews attached to the newest deterministic pair for a scenario and revision. A failed review is therefore retired when a newer pair is reviewed. The earlier finding that no supersession exists was wrong. What remains true is that a failure on the newest pair blocks until fresh paired evidence and a review on a newer pair exist. That is why migration-planning and deterministic-contract-testing needed new pairs, not just a retry on the same pair.

5. Staged review verdicts live only in the temporary envelope under `/private/var/folders/.../T/`. The durable pending record holds assignment metadata and the prompt, not the verdict. The six reviews in this group were ingested before temp cleanup. The general risk remains for any other group that stages without ingesting.

6. `gate.status` is computed before the informational exclusion reasons are appended to `gate.reasons`. A ready package can return a non-empty `reasons` array. `verification` and `deterministic-contract-testing` are examples. A reader that treats any `reasons` entry as blocking will misread ready packages.

7. `--diagnose-reviewer` always sets `stageOnlyAttemptAllowed: false` for non-ChatGPT adapters, while a real campaign run sets it true when the adapter executable exists. The diagnostic is not a route availability check.

8. The concurrency-debugging artifact requirement is internally consistent but easy to lose. The task requires a hand-authored evidence file and also requires a test to regenerate a `repeatabilityRegression` object in that same file. Two default reasoning models produced a file containing only the generated record. A high reasoning run preserved the full document. The prompt could state explicitly that regeneration must preserve other fields, or the harness could merge the fresh record into the submitted artifact. Neither change was made here because both would alter a live contract.

9. `--validate-only` prints the entire eligible catalog, not just the validated assignment. Its output ends with `failures: []` even when the assigned review was validated. A reader must check `validatedReviews`, not the absence of failures. This is a usability trap in the coordinator path.

10. All logfare reviews carry `routeVerified: false` and `isolationVerified: false`. The importer validates cryptographic binding and reviewer independence, but it does not verify that the reviewer ran on a qualified isolated route. The ready states above therefore rest on stage-only provenance. They are not evidence of a verified reviewer route.

11. The blind review campaign caps `--max-per-skill` at 2 and counts reviews on superseded pairs toward that cap. After a new pair replaces a reviewed pair, the skill can be left with room for only one new review, even when both scenarios have new pairs. The follow-up concurrency rerun hit this. Only `8c57e85d` could be reviewed, and the new `679b4bd8` pair remains unreviewed. The gate still reports blind 1 and ready.

## Verification performed

- `bun run scripts/run-skill-v5-blind-review.ts --validate-only=<envelope>` for the five earlier envelopes and the follow-up concurrency envelope. Every validation returned `validatedReviews: 1` and `failedReviews: 0` with exit 0.
- `bun run scripts/run-skill-v5-blind-review.ts --ingest=<envelope>` for the five accepted reviews and the follow-up concurrency review. Every prior ingestion returned `persistedReviews: 1` with exit 0. The follow-up importer exited 0 and appended one blind-review run on pair `8c57e85d`.
- A final gate reader over all 15 skills after the follow-up ingestion. Every skill returned `ready` with blind 1, open regressions 0, non-negative deltas, and the pass and verification values in the tables above. Concurrency-debugging measured 0.857 pass, 0.857 verification, 0.929 quality, and 27 paired cases.
- Paired campaign for concurrency-debugging: `--open-regressions --executor=codex --model=gpt-6-luna --reasoning-effort=high --concurrency=1`, exit 0, one pair completed, no infrastructure or integrity failure.
- Follow-up logfare campaign for concurrency-debugging, integration-fault-testing, and performance-verification: `--executor=logfare-text-patch --model=deepseek-v4.1-flash-1017 --concurrency=1 --wall-clock-ms=180000`, exit 0. Two concurrency pairs completed with both arms passing at 1.0. Both integration-fault-testing scenarios recorded failing runs, one on a 180 second timeout and one on a logfare in-stream error. The campaign stopped before performance-verification.
- Blind review campaigns for deterministic-contract-testing (with `--retry-failed`) and concurrency-debugging, exit 0, one completed review each, no infrastructure failure. The follow-up concurrency review also completed with one staged review and no infrastructure failure.
- Verdict inspection by reading each earlier result and comparing it to the sealed `withIsA` mapping before ingestion. The follow-up review was inspected for artifact pass, quality, verification, and preference, and its attestation bound it to pair `8c57e85d`.
- Earlier focused backend tests for the scorer change: 8 tests pass in `skill-eval-v5-targeted-regressions.test.ts`, plus the current-contract and scorer-regression suites, all exit 0.
- Prose check on this report with `node skills-v5/dash-free-writing/scripts/check-prose.mjs` returns exit 1 because it flags every U+002D inside exact skill names, paths, commands, and identifiers. Semantic review found no dash punctuation used as prose punctuation.

## Limitations

- The reviewer route and isolation remain unverified for all independent reviews. The gate accepts the provenance fields and the importer verified the sealed evidence, but no route qualification was performed.
- The concurrency-debugging pair that closed the regression tied its no-skill arm at full score. It proves the repair and the evidence artifact, not a new measured lift for that pair. The two follow-up pairs were also ties at 1.0 on both arms, so they raise the pooled rate by adding passes, not by showing a with-skill advantage.
- The follow-up logfare rerun did not lift the group uniformly. Concurrency improved from 0.851 to 0.857 pass. Integration-fault-testing recorded four failing runs without changing its pooled gate measurement. Performance-verification never ran. The pooled means remain below 1.000. Reaching 1.000 would require deleting or reclassifying eligible failing runs; that was not done.
- Only one of the two new concurrency pairs has a fresh review. The campaign caps current reviews at 2 per skill, and the existing review occupies one slot. The gate still reports blind 1 and ready, but the full-task-2 pair is unreviewed.
- The deterministic-contract-testing package still excludes eight task-2 runs recorded under `@2`. They are historical and cannot earn current credit.
- The promotion inventory command could not produce a full 182 package snapshot because the shared ledger kept changing during the audit. The group gate reader is the authoritative measurement here.
- The prose checker cannot return a clean result for this report because the group and several skills have hyphens in their exact names. A clean result would require altering identifiers.
- No commit, push, or deploy was performed.
