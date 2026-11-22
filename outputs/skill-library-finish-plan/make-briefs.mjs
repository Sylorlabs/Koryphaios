import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./rows.json', import.meta.url), 'utf8'));
const groups = JSON.parse(readFileSync(new URL('./groups.json', import.meta.url), 'utf8'));
const status = new Map(rows.map((row) => [row.s, row]));

const REPORT_HEADER = `Koryphaios skill library V5, long horizon work order`;

const FOCUS = {
  'A-language-runtimes':
    'Toolchains matter most here. Confirm the real runtime for each language before claiming execution: a Java fixture needs a JDK that matches its Gradle wrapper, Go needs a toolchain that compiles the fixture, C and C++ need a linker that can actually produce a binary, Rust needs cargo, Ruby and PHP need interpreters, .NET needs the SDK, and Swift needs a compiler whose version matches the installed macOS SDK. Several of these currently fail at toolchain detection rather than at skill behavior, and a toolchain failure must be recorded as an environment blocker with the exact command and stderr, never as a skill failure and never as a pass.',
  'B-backend-and-apis':
    'Most scenarios here are protocol and lifecycle correctness: idempotency, retries, ordering, delivery guarantees, and contract compatibility. Verify against a live process or a real message broker where the fixture declares one. A mock that agrees with itself is not evidence.',
  'C-data-stores-and-search':
    'Real database engines and real indexes are required. The pinned containers are PostgreSQL 17.5, MySQL 8.4.6, MongoDB 8.0.12, Elasticsearch 8.19.4 and Toxiproxy 2.12.0 on the native ARM Colima profile. Use the native ARM profile, never the x86 QEMU profile, and never change the user global Docker context. A missing engine is an environment blocker, not a reason to score the skill by reading SQL.',
  'D-frontend-and-interfaces':
    'Browser evidence must come from a real rendered page with measured geometry, real focus and keyboard behavior, and a screen size that matches the claim. Accessibility scenarios that require a screen reader, browser zoom reflow, or alternate input must stay blocked unless that exact assistive technology was actually driven and recorded.',
  'E-native-mobile-and-devices':
    'This group carries the largest genuinely blocked surface: devices, simulators, hardware, GPU, and native window servers. An Android scenario needs a real API level device or emulator plus the specific assistive technology the fixture names. An iOS scenario needs an already booted simulator UDID passed explicitly. Firmware, robotics, and GPU scenarios need the declared target. Never substitute a host only simulation for a device claim. Report each blocked scenario with the exact missing prerequisite and the command that failed.',
  'F-security-and-crypto':
    'Security claims fail closed. A missing deny rule, a missing negative control, or a verifier that accepts a partial mitigation is a defect in the evaluator, not a pass. When you change a scorer, increment its contract generation and re-run the affected evidence, because old scores cannot silently qualify a new contract. Keep every historical negative result in place.',
  'G-cloud-and-operations':
    'Infrastructure behavior must be observed against something real: a container, a plan output, a rendered manifest, or a live endpoint. Recall and precision of an incident runbook can be reviewed semantically, but a claim about deployment behavior needs an actual execution or a deterministic plan comparison.',
  'H-agentic-and-llm':
    'Agentic and model behavior needs real model calls with recorded usage, retries, and budgets. A deterministic scorer cannot judge tone, tool choice, or reasoning quality. When a paired run is unaffordable or rate limited, record it as an infrastructure failure, never as uplift.',
  'I-verification-and-debugging':
    'The value of these skills is causal diagnosis. A verifier that only checks for the presence of a word is not a verifier. Build positive controls, negative controls, alternative valid solutions, and mutation cases before you trust any pass. Preserve every open regression until the exact current contract re-observes it.',
  'J-architecture-and-research':
    'Research skills need real retrieved sources with exact URLs, publication dates, and body hashes, plus contradiction handling. Architecture skills need decision artifacts that a reviewer can falsify. Do not fabricate dated snapshots and do not treat a generated plan as verification of a built system.',
  'K-product-and-business':
    'These artifacts are judged semantically. Blind review matters most here, and the reviewer must not know which artifact came from the skill. Keep numeric claims traceable to a stated source or a stated assumption, and separate recommendation from evidence.',
  'L-skill-system-and-routing':
    'This group is the library own tooling. A change here changes how every other skill is judged, so land it carefully, keep the gates at their current thresholds, and never widen a gate to make another package pass. The routing corpus must keep full coverage of every package after any metadata change.',
};

function groupBrief(group, skills) {
  const list = skills
    .map((skill) => {
      const row = status.get(skill);
      return `- \`${skill}\` (${row.st}): ${row.l}`;
    })
    .join('\n');

  return `# ${REPORT_HEADER}: ${group}

You own ${skills.length} skills in the Koryphaios V5 skill library. This is a multi session assignment, not a task. Work through the whole group, skill by skill, until every skill is either promotion ready under the real gate or blocked by a documented, reproducible external prerequisite. Do not deliver a plan and stop.

## Repository

Work in \`/Users/Shared/micah/Documents/koryphaios\`. The library lives in \`skills-v5/<skill>/\` with \`SKILL.md\`, \`kory.json\`, \`references/\`, and \`evals/\`. The gates live in \`backend/src/kory/\` and are driven by scripts in \`scripts/\`. Preserve every pre-existing uncommitted change in this repository. It is a heavily dirty worktree and losing someone else work is a failure.

## Your group

${list}

## Current gate state, measured 2026-11-07

182 packages. 42 ready, 120 blocked, 20 insufficient evidence. Static quality passes with zero errors, zero warnings, zero stale sources, zero dash findings, zero hierarchy gaps, and all 182 packages individually authored. Your group above shows live per skill labels. Read them as: status, blocked scenario count, open regressions, full task coverage, paired baseline coverage, blind review presence, and measured failure count.

## What ready actually requires

A package is ready only when \`evaluateSkillPromotion\` finds no reason to object. That means all of the following at once, against the exact current sidecar and source hashes:

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

${FOCUS[group]}

## Available execution routes

- Paired candidate and baseline runs: \`scripts/run-skill-v5-qualification-campaign.ts\` with a real provider. Model routes that have worked on this host include the ChatGPT Web bridge behind Codex and an OpenAI compatible endpoint at \`https://logfare.ai/v1\` with \`deepseek-v4.1-flash-1017\`. Evidence produced through the OpenCode route is quarantined for lack of a qualified isolation boundary and cannot be counted.
- Blind review staging: \`scripts/run-skill-v5-blind-review-campaign.ts\` with \`--reviewer-adapter=scripts/kory-logfare-stateless-reviewer --reviewer-model=deepseek-v4.1-flash-1017\`, and \`KORY_SKILL_BLIND_REVIEWER_PROVIDER=logfare\`. Live reviews run serially with \`--concurrency=1\`. The campaign stages evidence only.
- Ledger ingestion is the coordinator job. You do not write \`.koryphaios/skills/evaluations.json\`.
- Source freshness: \`bun run scripts/audit-skill-v5-quality.ts --summary\`.
- Promotion inventory: \`bun run scripts/report-skill-v5-promotion-inventory.ts\`.
- Dash free prose: \`node skills-v5/dash-free-writing/scripts/check-prose.mjs FILE...\`.
- Focused tests: \`bun run scripts/test-backend-isolated.ts --file backend/src/kory/__tests__/FILE.test.ts\`.

## Rules that decide whether your work counts

- Never fabricate a review, a run, a timestamp, a hash, or a device. If you cannot observe something, it stays blocked and you say so.
- Never lower a threshold, widen an exclusion, or reclassify a failure. A negative result is evidence and it stays in the ledger.
- Do not modify \`.koryphaios/skills/evaluations.json\`, \`stewards.json\`, or another group skills. If you believe a shared gate or shared fixture is wrong, write a precise finding in your report and stop that line of work.
- Editing \`SKILL.md\` or the package content changes the revision hash and invalidates every paired run bound to the old hash. Decide deliberately: if you edit, you owe fresh paired evidence for that package. Editing only a source \`verifiedAt\` date or a source URL does not change the revision hash, which is why source refresh is safe to do first.
- Do not retry an action that was refused by a safety or approval layer. Record it as refused and move on.
- Skill prose must contain no dash punctuation and no avoidable prose compounds. Rewrite the sentence, do not delete characters mechanically. Exact commands, identifiers, paths, versions, and quoted source text stay exact.
- Prefer a small, real, reproducible improvement over a large unverifiable rewrite.

## Per skill loop

For each skill in your group:

1. Read \`SKILL.md\`, \`kory.json\`, every file in \`references/\`, and the full task and routing fixtures in \`evals/\`.
2. Ask the promotion gate what is actually missing. Use the inventory row and \`evaluateSkillPromotion\` output, not your impression.
3. Refresh stale sources for real: fetch each URL, confirm the page is the same document and still covers the claim in its notes, then update \`verifiedAt\` and the date prose in \`references/sources.md\`. If a page moved, cite the new canonical URL. If a page is gone or bot blocked, record that and leave the old date alone rather than inventing a new one.
4. If a scorer or materializer is wrong, diagnose the actual defect with a positive control and a negative control, fix it, bump its contract generation, and re-run the affected evidence.
5. If the skill guidance is genuinely wrong, revise it from observed failure, then regenerate the evidence the new revision needs.
6. Run the paired qualification campaign for the specific skill and record the real outcome, including failures.
7. Stage an independent blind review and inspect the verdict before proposing ingestion.
8. Report the state: ready, blocked with a named prerequisite, or evidence staged and awaiting coordinator ingestion.

## Definition of done for your group

Every skill ends in exactly one of these states, and your final report must say which, with evidence:

- \`ready\`: the gate reports ready on the current revision.
- \`blocked-external\`: a named, reproducible external prerequisite is missing, with the exact command and error.
- \`staged-awaiting-ingest\`: passing evidence exists outside the ledger, with run ids and file paths.

Your report must also list every action you refused or that was refused by policy, every shared file you touched, and every place where the library disagrees with observable reality.

Write your report to \`outputs/skill-library-finish-plan/briefs/${group}.report.md\` as you go, updating it after each skill, so a coordinator can pick it up at any moment.
`;
}

const index = [];
for (const [group, skills] of Object.entries(groups)) {
  const body = groupBrief(group, skills);
  writeFileSync(new URL(`./briefs/${group}.md`, import.meta.url), body);
  index.push({ group, count: skills.length, env: skills.filter((s) => status.get(s).l.includes('env:')).length, ready: skills.filter((s) => status.get(s).st === 'ready').length });
}
writeFileSync(
  new URL('./briefs/INDEX.json', import.meta.url),
  JSON.stringify({ generatedFrom: 'outputs/skill-v5-promotion/audit.json 2026-11-07T19:53:55Z', groups: index }, null, 2) + '\n',
);
console.log(JSON.stringify(index, null, 2));
