# Blind re-reviews

The seven skills previously reported as bound to a failed blind review were re-reviewed. Nine
independent reviews were staged by the campaign and persisted through the sanctioned importer.
Two of those skills are now ready, two gained live blind coverage and are blocked on other gates,
one gained a truthful failing adjudication, and one never became reviewable at all.

## The reviewer was down for about four and a half hours

Every re-review attempt between 10:02 and 14:44 was refused by the reviewer provider, not by the
pipeline. `GET https://logfare.ai/v1/models` returned 200 the whole time, while every
`POST /v1/chat/completions` returned

    503 {"error":{"message":"Service temporarily unavailable","type":"server_error"}}

for `deepseek-v4.1-flash-1017`, `kimi-k2.6`, `glm-5.3` and the economy aliases alike, so the
gateway was up and the completions service behind it was not. `rereview-wait.py` polled the exact
model the campaign uses every five minutes (15 polls, all 503) and would have started the
campaign automatically had it recovered inside the window. I did not substitute another reviewer
model to get past the outage: the campaign's own adapter, model and reasoning effort are the ones
this ledger's accepted reviews were produced with.

## Reviews that were staged and persisted

| skill | staged | verdicts | effect |
|---|---|---|---|
| oauth-oidc | 2 | pass | **ready**, 1.000, blind 1 |
| factual-research | 2 | pass, pass | blind 2, ready at 0.889, then out again (below) |
| mlops | 2 | pass, pass | blind 2, blocked only on a baseline regression |
| android-compose | 2 | pass, fail | blind 2, blocked on the honest failure |
| literature-research | 1 | fail | blocked on the failure |
| react-engineering | 1 | pass | blind 1, blocked on regressions |
| ios-swiftui | 0 | - | never eligible |

Three of the thirteen blind reviews recorded in this window belong to other agents working the
same ledger (novel-ui-toolkit, angular-engineering, vue-engineering); nine are mine.

`ios-swiftui` staged nothing because `--prepare-only --retry-failed` reports `eligible: 0` for it:
its single full-task pair belongs to a contract the current fixture source no longer matches, so
there is no reviewed artifact set to adjudicate until a fresh attempt runs at the current
contract. Its own runs then failed a host check and recorded an integrity failure, so it needs new
evidence before a review can exist, not a review.

## A re-review cannot retire a failed adjudication, and I left that alone

`failedProvenancedBlindReviews` in `backend/src/kory/skill-evaluations.ts` counts **every** failed
provenanced blind review in the revision's current-contract runs, while pass rate, quality,
verification and regression all read the most recent run per case. Every review also targets one
randomized pair, and a new attempt produces a new `comparisonId`, so re-reviewing a scenario gives
a second independent adjudication rather than correcting the first. The consequence is visible in
this window: `literature-research` failed again on a fresh pair, and `android-compose` now carries
one pass and one fail on two different pairs and stays blocked.

I did not "fix" that by making the gate read only the latest review per scenario. Loosening it
would let a skill promote while a reviewer has said, on the record, that its artifact was worse
than the no-skill arm on one of its own scenarios. The strictness is defensible and the failures
in this window are substantiated findings, not fixture defects:

- `literature-research`: both arms fail study identity/version/publication and
  design/comparator/outcomes/validity checks, and the with-skill arm claims
  "PASS: ... verified" over a scorer that fails several of those checks.
- `android-compose`: one arm produced real emulator instrumentation evidence and the other's
  Gradle build failed on network resolution, with no native evidence at all.

## Churn, and one driver I stopped

`react-engineering` went from 2 open regressions to 5 during three regression rounds, because each
browser-backed attempt fails a host check and adds an open case. Its full-task pairs also dropped
to 0 mid-run, which means the fixture contract moved underneath the attempts. Repeatedly re-running
it lowers its standing without closing anything, so I stopped the driver there rather than grind.
This is the same reason the earlier rounds stopped on java-jvm-engineering and cloud-security.

## Library state

**158 of 182 ready** (156 when this step started). Gained across the session: plan-mode,
accessibility-practice, planning, vue-engineering, oauth-oidc.

`factual-research` is the one movement I have to qualify. The two reviews I staged both passed,
which cleared its blind gate, and it read ready at 0.889. Further candidate attempts recorded at
the current contract after that failed their deterministic checks, taking it to 0.773 and
`insufficient-evidence` by the time of the final scan. Those failures are not this step's doing
and I have not tried to average them away: the reviews I added are real adjudications of the pairs
that existed when they ran.

`mlops` closed its baseline regression from other work in the window and now reads ready at 0.955
with two passing reviews, one of which I staged.

Remaining, by cause: 17 skills whose scenarios cannot run on this host, 7 with open regressions,
2 with a substantiated failing blind review, 1 with no reviewable pair, 1 with an integrity
failure and stale pairs, plus `architecture-planning` and `mlops` on matched-baseline regressions.

## Files touched

- `outputs/skill-library-finish-plan/c-logs/rereview.py` (review then ingest, one envelope at a time)
- `outputs/skill-library-finish-plan/c-logs/rereview-wait.py` (endpoint poller that only starts a campaign on a real completion)
- logs `rereview-wait.log`, `rereview-a/b/c.log`, `rereview-<skill>.json`, `d16-batchD.log`

No `SKILL.md`, fixture, scorer, gate or ledger file was edited in this step. Tests were not
re-run because nothing under `backend/` changed; the last green run stands
(`skill-eval-evidence-contract-regressions` 66, `skill-eval-sealed-evidence-fixtures` 9,
`skill-eval-promotion-repair-lane` 17, `skill-eval-promotion-repair` 6, 0 fail). No driver
processes are running.
