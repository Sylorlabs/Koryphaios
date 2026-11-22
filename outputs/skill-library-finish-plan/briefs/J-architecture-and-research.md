# Koryphaios skill library V5, long horizon work order: J-architecture-and-research

You own 13 skills in the Koryphaios V5 skill library. This is a multi session assignment, not a task. Work through the whole group, skill by skill, until every skill is either promotion ready under the real gate or blocked by a documented, reproducible external prerequisite. Do not deliver a plan and stop.

## Repository

Work in `/Users/Shared/micah/Documents/koryphaios`. The library lives in `skills-v5/<skill>/` with `SKILL.md`, `kory.json`, `references/`, and `evals/`. The gates live in `backend/src/kory/` and are driven by scripts in `scripts/`. Preserve every pre-existing uncommitted change in this repository. It is a heavily dirty worktree and losing someone else work is a failure.

## Your group

- `architecture-planning` (blocked): blocked,regr:4,fails:1
- `planning` (blocked): blocked,regr:1,ft:0,pair:0,noblind
- `feature-implementation` (blocked): blocked,regr:4
- `refactor-implementation` (blocked): blocked,regr:1
- `implementation` (ready): ready
- `integration-implementation` (blocked): blocked,fails:1
- `developer-experience` (ready): ready
- `repository-environment-discovery` (ready): ready
- `repository-research` (ready): ready
- `research` (insufficient-evidence): insufficient-evidence,env:2,ft:0,pair:0,noblind
- `literature-research` (blocked): blocked,regr:1,noblind
- `factual-research` (blocked): blocked,regr:2,noblind
- `market-competitive-research` (blocked): blocked,ft:0,pair:0,noblind

## Current gate state, measured 2026-11-07

182 packages. 42 ready, 120 blocked, 20 insufficient evidence. Static quality passes with zero errors, zero warnings, zero stale sources, zero dash findings, zero hierarchy gaps, and all 182 packages individually authored. Your group above shows live per skill labels. Read them as: status, blocked scenario count, open regressions, full task coverage, paired baseline coverage, blind review presence, and measured failure count.

## What ready actually requires

A package is ready only when `evaluateSkillPromotion` finds no reason to object. That means all of the following at once, against the exact current sidecar and source hashes:

1. No evaluation contract conflict and no integrity failure in any run.
2. At least three observed candidate runs and benchmark coverage across every required category.
3. At least two observed full task evaluations for a V5 package.
4. At least two paired skill versus no skill full task baselines, on the same model, tools, starting state, budget, and task.
5. Routing precision and recall at or above 0.95 for a V5 package, measured through the real resolver on held out cases.
6. Observed pass rate at or above 0.80 and verification score at or above 0.80.
7. At least one blind review with persisted evaluator provenance that passed.
8. No open regression case, and no negative delta on pass rate, quality, or verification against the matched no skill baseline. At least one positive delta is required, so a tie is not uplift.
9. No stale source under its declared policy.

Anything that fails to meet one of these is not ready, and you must name the exact missing gate in your report. Never edit a threshold, a scorer tolerance, or a fixture expectation to make a package fit.

## Environment for this group

Research skills need real retrieved sources with exact URLs, publication dates, and body hashes, plus contradiction handling. Architecture skills need decision artifacts that a reviewer can falsify. Do not fabricate dated snapshots and do not treat a generated plan as verification of a built system.

## Available execution routes

- Paired candidate and baseline runs: `scripts/run-skill-v5-qualification-campaign.ts` with a real provider. Model routes that have worked on this host include the ChatGPT Web bridge behind Codex and an OpenAI compatible endpoint at `https://logfare.ai/v1` with `deepseek-v4.1-flash-1017`. Evidence produced through the OpenCode route is quarantined for lack of a qualified isolation boundary and cannot be counted.
- Blind review staging: `scripts/run-skill-v5-blind-review-campaign.ts` with `--reviewer-adapter=scripts/kory-logfare-stateless-reviewer --reviewer-model=deepseek-v4.1-flash-1017`, and `KORY_SKILL_BLIND_REVIEWER_PROVIDER=logfare`. Live reviews run serially with `--concurrency=1`. The campaign stages evidence only.
- Ledger ingestion is the coordinator job. You do not write `.koryphaios/skills/evaluations.json`.
- Source freshness: `bun run scripts/audit-skill-v5-quality.ts --summary`.
- Promotion inventory: `bun run scripts/report-skill-v5-promotion-inventory.ts`.
- Dash free prose: `node skills-v5/dash-free-writing/scripts/check-prose.mjs FILE...`.
- Focused tests: `bun run scripts/test-backend-isolated.ts --file backend/src/kory/__tests__/FILE.test.ts`.

## Rules that decide whether your work counts

- Never fabricate a review, a run, a timestamp, a hash, or a device. If you cannot observe something, it stays blocked and you say so.
- Never lower a threshold, widen an exclusion, or reclassify a failure. A negative result is evidence and it stays in the ledger.
- Do not modify `.koryphaios/skills/evaluations.json`, `stewards.json`, or another group skills. If you believe a shared gate or shared fixture is wrong, write a precise finding in your report and stop that line of work.
- Editing `SKILL.md` or the package content changes the revision hash and invalidates every paired run bound to the old hash. Decide deliberately: if you edit, you owe fresh paired evidence for that package. Editing only a source `verifiedAt` date or a source URL does not change the revision hash, which is why source refresh is safe to do first.
- Do not retry an action that was refused by a safety or approval layer. Record it as refused and move on.
- Skill prose must contain no dash punctuation and no avoidable prose compounds. Rewrite the sentence, do not delete characters mechanically. Exact commands, identifiers, paths, versions, and quoted source text stay exact.
- Prefer a small, real, reproducible improvement over a large unverifiable rewrite.

## Per skill loop

For each skill in your group:

1. Read `SKILL.md`, `kory.json`, every file in `references/`, and the full task and routing fixtures in `evals/`.
2. Ask the promotion gate what is actually missing. Use the inventory row and `evaluateSkillPromotion` output, not your impression.
3. Refresh stale sources for real: fetch each URL, confirm the page is the same document and still covers the claim in its notes, then update `verifiedAt` and the date prose in `references/sources.md`. If a page moved, cite the new canonical URL. If a page is gone or bot blocked, record that and leave the old date alone rather than inventing a new one.
4. If a scorer or materializer is wrong, diagnose the actual defect with a positive control and a negative control, fix it, bump its contract generation, and re-run the affected evidence.
5. If the skill guidance is genuinely wrong, revise it from observed failure, then regenerate the evidence the new revision needs.
6. Run the paired qualification campaign for the specific skill and record the real outcome, including failures.
7. Stage an independent blind review and inspect the verdict before proposing ingestion.
8. Report the state: ready, blocked with a named prerequisite, or evidence staged and awaiting coordinator ingestion.

## Definition of done for your group

Every skill ends in exactly one of these states, and your final report must say which, with evidence:

- `ready`: the gate reports ready on the current revision.
- `blocked-external`: a named, reproducible external prerequisite is missing, with the exact command and error.
- `staged-awaiting-ingest`: passing evidence exists outside the ledger, with run ids and file paths.

Your report must also list every action you refused or that was refused by policy, every shared file you touched, and every place where the library disagrees with observable reality.

Write your report to `outputs/skill-library-finish-plan/briefs/J-architecture-and-research.report.md` as you go, updating it after each skill, so a coordinator can pick it up at any moment.
