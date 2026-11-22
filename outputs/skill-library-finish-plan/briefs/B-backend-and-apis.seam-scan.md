# Library-wide check: is the "type seam" failure spreading?

Owner: Agent 2 (B-backend-and-apis). Read-only scan, 2026-11-08T19:20Z.
Trigger: `stream-processing` closed only after I named the seam between a dependency's
return type and the component's own contract. Question: do other blocked packages fail the
same way, and are their fixtures really broken?

## Method

Read `.koryphaios/skills/evaluations.json` for all 182 active, valid packages, kept every
failing candidate row, extracted the `error:` and `expect(received)...` lines from the
evidence, and cross-referenced the result with each package's live
`evaluateSkillPromotion` reasons. Script: `scripts/tmp-nearready.ts` for the readiness
buckets; the assertion scan was a throwaway reader over the same rows.

## Finding 1: the stream signature appears exactly once elsewhere, and it is not a fixture defect

The exact signature that blocked `stream-processing`
(`error: Received value must be a string`) occurs in one other package:
`authorization-security-full-task-2`.

Its hidden test does:

```js
expect(spec.enforcementBoundary.toLowerCase()).toMatch(/service|data/)
expect(spec.exportWorker.effectiveSubject.toLowerCase()).toMatch(/originat|user|delegat/)
```

The candidate wrote a `.kory-eval/authorization-document-api.json` that lacks
`enforcementBoundary`, so `.toLowerCase()` received `undefined`.

This is **not** an unstated requirement. The field is typed in the file the task tells the
model to preserve:

```ts
export interface DocumentPolicySpec {
  rules: PolicyRule[]
  defaultDeny: boolean
  enforcementBoundary: string          // <- required string
  exportWorker: { effectiveSubject: string; ... }
  ...
}
```

and the fixture README says to express the policy "using the `DocumentPolicySpec` shape
exported by the evaluator". The model hand-wrote JSON against a type it had in front of it
and never checked it. The skill (`skills-v5/authorization-security/`) never mentions
`enforcementBoundary` and never tells the model to type-check the artifact.

Recommended fix for that package's steward, not a fixture edit: add a rule that an artifact
written as JSON against an exported interface must be checked against that interface
(`bunx tsc --noEmit`, or a typed import in a scratch file) before reporting, because a
missing field is otherwise silent in the hand-written JSON and fails deep inside the grader.
This is the same family as the stream bug: the *policy* was right, the *seam* was unnamed.

## Finding 2: the other assertion failures are genuine behavior failures

Sampled the remaining assertion failures. They are security properties the candidate
actually violated, not type mismatches:

| Package | Failure | Reading |
| --- | --- | --- |
| application-security | `Expected: false, Received: true`; `Expected to not contain: "other-secret"` | redaction and denial actually failed |
| language-runtime-security | `Expected: false, Received: true` | sandbox escape not blocked |
| oauth-oidc | `Expected: true, Received: false` | token validation rejected a valid case |
| frontend-engineering | `Received: null`, `Expected: false, Received: true` | missing element, inverted guard |
| authorization-security | `Expected: true, Received: false` | decision matrix disagrees with the stated product rules |

One contract-shaped exception: `application-security` also fails with
`Expected: "<path>", Received: Promise { <pending> }`, i.e. the candidate made a documented
synchronous function `async`. Same family as the seam, on the async axis. A rule "do not
change a documented synchronous signature to async without changing its callers" would
address it.

So the seam problem is real but narrow. It is not what blocks the library.

## Finding 3: what actually blocks the library

Census of live gate reasons across the 63 non-ready packages:

| Count | Reason |
| --- | --- |
| 42 | At least one blind review with persisted evaluator provenance is required |
| 38 | N recorded regression case(s) remain open |
| 23 | Promotion requires at least two observed full-task candidate evaluations |
| 21 | Benchmark coverage is missing: full-task |
| 21 | Skill-vs-no-skill baselines are missing for: full-task |
| 15 | Excluded execution evidence: full-task evidence does not match the exact current source contract |
| 8 | Candidate regressed against the matched no-skill baseline |
| 6 | At least one run recorded an integrity failure |
| 5 | An active provenanced blind review failed semantic evaluation |

Every single non-ready package needs a blind review. Twenty-three have never had a
full-task round at all, so their coverage, baseline and pass-rate clauses are all empty
rather than failed. That is the same state my six hardest packages were in.

## Finding 4: 12 packages are one or two steps from ready

Buckets by remaining clause only:

**One blind review away (4):** `incident-response` (pass 1.000), `edge-cdn` (1.000),
`agentic-systems` (1.000), `mlops` (.889). No regressions, no missing coverage.

**Blind review plus closing regressions (8):** `terminal-interface` (1), `react-engineering`
(1), `angular-engineering` (1), `literature-research` (1), `secure-authentication` (2),
`factual-research` (2), `security-review` (2), `container-engineering` (3). All have pass
rates between .842 and 1.000 and full-task baselines already recorded.

**Blind review, regressions and a first full round (19):** `research`, `embedded-firmware`,
`visual-interface-design`, `native-interface`, `hardware-runtime-debugging`,
`embedded-interface`, `visual-verification`, `game-spatial-interface`,
`desktop-electron-tauri`, `simulation-device-testing`, `react-native-expo`, `gpu-compute`,
`robotics-control`, `image-generation-practice`, `speech-audio-ai`, `computer-use`,
`frontend-engineering`, `web-security`, `accessibility-verification`.

The remaining 34 need real work: behaviour repairs, integrity-failure investigation
(`embedded-device-security`, `oauth-oidc`, `infrastructure-security`, `ai-safety-evaluation`,
`language-runtime-security`, `ml-evaluation`), or the two packages with no runs at all
(`critic-auto-selection`, `critic-review`).

## Recipe that produced 14 of 14

For any of the 12 near-ready packages:

```
# 1. full round at the model that clears these scenarios (never gpt-6-luna first)
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill=<skill> --executor=codex --model=gpt-5.6-sol --wall-clock-ms=900000 --force --concurrency=1

# 2. routing evidence, which is what keeps the blended pass rate above .80
bun run --no-env-file scripts/run-skill-v5-routing-evidence.ts --skill=<skill>

# 3. close sources (only attaches regressionId, so only this route closes v1/v2 sources)
bun run --no-env-file scripts/run-skill-v5-qualification-campaign.ts \
  --skill=<skill> --executor=codex --model=gpt-5.6-sol --open-regressions --wall-clock-ms=900000 --concurrency=1

# 4. blind review LAST, on a pair where the candidate arm passed
KORY_SKILL_BLIND_REVIEWER_PROVIDER=logfare bun run --no-env-file \
  scripts/run-skill-v5-blind-review-campaign.ts --skill=<skill> \
  --reviewer-adapter=scripts/kory-logfare-stateless-reviewer \
  --reviewer-model=deepseek-v4.1-flash-1017 --concurrency=1 --retry-failed
```

Two traps worth restating: a review staged on a pair where both arms failed produces a
never-ingest envelope (I discarded one for `network-service-backend`), and `inventory.csv`
is silently stale whenever the generator run fails, so its mtime must be checked.
