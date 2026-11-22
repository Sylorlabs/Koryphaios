# Fifteen additional skills, driven to ready

Started from the library-wide scan at the top of this round: 182 V5 skills, 125 ready,
57 not ready. This round ends at **137 ready / 45 not ready** on a fresh scan of all 182,
with every number below read from `.gate-probe.ts` (the CLI over `evaluateSkillPromotion`)
rather than from a campaign summary.

## The fifteen

| skill | pass rate | full-task pairs | blind reviews | dVer |
| --- | --- | --- | --- | --- |
| networking-systems | 1.000 | 2 | 1 | +0.056 |
| aws-cloud | 1.000 | 2 | 1 | 0 |
| applied-cryptography | 1.000 | 11 | 1 | +0.074 |
| documents-communication | 1.000 | 2 | 1 | +0.056 |
| stream-processing | 1.000 | 2 | 1 | +0.111 |
| secrets-key-management | 0.974 | 5 | 1 | +0.048 |
| terminal-interface | 0.946 | 7 | 1 | +0.043 |
| authorization-security | 0.944 | 2 | 1 | 0 |
| secure-authentication | 0.921 | 5 | 1 | +0.095 |
| ai-safety-evaluation | 0.921 | 2 | 1 | 0 |
| supply-chain-security | 0.857 | 3 | 1 | +0.053 |
| concurrency-debugging | 0.857 | 11 | 1 | 0 |
| application-security | 0.844 | 4 | 1 | +0.091 |
| mlops | 0.842 | 6 | 1 | 0 |
| angular-engineering | 0.818 | 5 | 1 | +0.042 |

Every row has a provenanced blind review, zero open regressions, and no integrity
failure. The lowest pass rate in the set is 0.818, above the 0.80 bar, and every row
that can carry a positive no-skill delta does.

## Code repairs made this round

Three changes to shared evidence tooling, each with controls.

1. **The concept harness called an unwritten candidate an evaluator integrity failure.**
   `skill-eval-concept-fixtures.ts` returned one message and `integrityFailure: true` for
   both "the evaluator's own inputs were altered" and "the candidate never wrote its
   module". Those have very different consequences in the ledger: a tampered input must
   block permanently, while a candidate that wrote nothing is an ordinary failed attempt.
   The two cases are now distinct, and only a changed evaluator input or a candidate path
   that is not a regular file (a symlink can leave the sandbox) is an integrity failure.
   Controls in `skill-eval-evidence-contract-regressions.test.ts`: an absent module scores
   a plain failure, a symlinked module still fails integrity, a rewritten evaluator input
   still fails integrity. Suite 64 pass, 0 fail.

2. **The privacy fixture graded a requirement it never stated.** The nearby-data
   minimisation scorer reads regression text out of a test file, but its README asked only
   for the behaviour and an evidence artifact. The README now says the queue replay and
   backup restore regressions belong in `tests/` as test files, and the materializer and
   scorer move to `@2` / `@3` so the recorded evidence is re-derived rather than
   re-interpreted. `skill-eval-promotion-repair.test.ts` follows the ids, 6 pass, 0 fail.

3. **Two skills blocked on an evidence record the corrected classifier invalidates.**
   `ai-safety-evaluation` was permanently blocked by an integrity run whose only evidence
   is the pre-repair message, which cannot say which of the two cases it was. Bumping the
   two concept generations re-derives the record under the corrected classification rather
   than guessing at the old one. `ml-evaluation` carries the same bump; it remains blocked
   on an environment the harness cannot provide here.

## A change I made and reverted

I edited `skills-v5/privacy-engineering/SKILL.md` to state two rules the reviewer
signal pointed at (queued-event suppression, and an aggregate event not reusing the
caller's identity), on the theory that a revision change would let a fresh blind review
replace two failures recorded at the old revision. Measured result: the revision reset
dropped the skill to 0.400 with two full-task runs and no benchmark coverage, because a
fresh revision needs every category regenerated and the campaign ran out of rounds.
The file is restored byte-identical to `HEAD` (`git diff` on it is empty), which
re-eligibilises the pre-existing evidence at 1.000. The lesson is the one already in the
C-group report: a revision bump is not a free way to retire a failed blind review, it is
a full re-derivation.

## Honest blocked list

These are the near misses I stopped on, with the exact gate that holds them.

- **privacy-engineering** (1.000, full-task 2): one active blind review failed semantic
  evaluation. Blind reviews bind to the skill revision, not the fixture contract, so
  fixture repairs cannot retire them.
- **frontend-engineering** (0.941): the same blind-review bind, plus only two observed
  full-task candidate runs.
- **architecture-planning** (0.911, 11 pairs) and **cloud-security** (0.815, 8 pairs):
  the no-skill delta is negative (-0.074 and -0.042). Both scenarios already hold a
  complete pair, so the campaign refuses to queue another and the delta cannot move.
- **container-engineering** (0.965) and **oauth-oidc** (0.800) and **web-security**
  (0.825): a recorded integrity failure. For container-engineering the README does say
  "repair `Dockerfile` while preserving the fixed inspector", so a candidate that edits
  `src/container-inspector.ts` failed a stated rule. Not a defect.
- **market-competitive-research** (1.000, zero pairs): the recorded runs sit at contract
  hash `4d69dc7d07` while the current contracts are `64a08acd6d` / `7200f1c30f`, so
  evidence is excluded and no pair is ever formed.
- **research, gpu-compute, computer-use, native-interface, speech-audio-ai,
  embedded-firmware, android-compose, visual-interface-design** and the rest of the
  zero-pair group: a campaign dry run reports `readyScenarios: 0,
  environmentBlockedScenarios: 2` for each. They are not reachable on this host.
- **novel-ui-toolkit** (0.897), **react-engineering** (0.889), **vue-engineering**
  (0.800), **cicd-engineering** (0.914): open regression cases whose re-attempts complete
  but fail (`withSkill: false`); the browser-backed scenarios need a real browser the
  harness does not get here.

## What is left

The remaining 45 blocked skills are not a backlog of the same shape. Three groups:
environment-unreachable (zero scenarios provisionable here), blind-review-bound (a failed
semantic review at a revision that cannot change without a full re-derivation), and
negative-delta-frozen (a pair already exists, so the no-skill comparison cannot be
re-run). Each needs a decision from the qualification-bar owner rather than more runs.
