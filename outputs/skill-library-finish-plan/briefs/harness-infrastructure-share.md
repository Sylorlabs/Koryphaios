# Measurement: how much of the library's quality gap is the harness

Date of measurement: 2026-11-15. Source: every evaluation row in
`.koryphaios/skills/evaluations.json` at each skill's current revision, candidate
variant only (`without-skill` baselines excluded). Method: classify each
non-passing row from its own evidence text.

## Headline

1077 non-passing candidate runs across 182 packages.

| Class | Rows | Share |
|---|---|---|
| Behavioural (a named check failed, or a required artifact was missing) | 755 | 70.1% |
| Infrastructure (no evidence ever produced) | 300 | 27.9% |
| Unclassified session receipts | 22 | 2.0% |

Infrastructure means the executor, not the skill, decided the outcome. The markers
are concrete strings in the evidence: `Direct provider text-patch mode produced no
test-execution evidence`, `Codex CLI exit=1 signal=none`, `Codex exceeded <n>ms
wall-clock budget`, `host-observed-...`, `patch adapter rejected`, and proxy or TLS
interception (`certificate is only valid for DnsName("*.securly.com")`, which
appears in 622 rows library wide including baselines).

## Packages where the rate measures the executor

| Package | Infrastructure / failures | Rows | Dominant cause |
|---|---|---|---|
| `aws-cloud` | 14 / 14 (100%) | 71 | text-patch mode produced no test-execution evidence |
| `experimentation-ab-testing` | 10 / 10 (100%) | 55 | wall-clock budget, `exit=1` |
| `procurement-vendor-evaluation` | 7 / 8 (88%) | 59 | no evidence produced |
| `sales-engineering` | 8 / 11 (73%) | 46 | budget, `exit=1` |
| `ios-swiftui` | 7 / 12 (58%) | 29 | budget, `exit=1` |
| `experimental-analysis` | 8 / 14 (57%) | 83 | budget |
| `accessibility-practice` | 12 / 25 (48%) | 59 | budget, no evidence |
| `video-production` | 11 / 27 (41%) | 60 | budget |
| `data-pipeline-engineering` | 10 / 29 (34%) | 60 | budget, TLS interception |
| `mysql-engineering` | 9 / 28 (32%) | 68 | budget |

`aws-cloud` is the clearest case: all fourteen of its failures are the retired
`omnirush-text-patch` executor, which never produces a test-execution artifact. No
edit to that skill can move its number. `experimentation-ab-testing` and
`sales-engineering` are dominated by wall-clock budget exhaustion, and
`accessibility-practice` and `data-pipeline-engineering` carry proxy interception
inside otherwise healthy runs.

## Why this matters for the promotion inventory

The inventory reports an observed pass rate per package, and 67 of 182 sit below
0.90. This measurement shows that roughly a quarter of the shortfall is not a
property of the skills: it is an executor that returned nothing, a run that ran out
of wall clock, or a TLS connection that a filtering proxy rewrote. Rewriting those
skills is the wrong response, and the current practice of stacking more runs onto
such a revision lowers the observed rate for a reason nobody controls.

The right actions, in order:

1. Re-run the cases behind the infrastructure rows with a healthy executor, and
   never count a no-evidence run toward a revision's rate in the first place.
2. Keep `omnirush-text-patch` out of the executor list. It is the source of every
   `aws-cloud` failure and of the 55 `no test-execution evidence` rows elsewhere.
3. Treat proxy interception as an environment fault: those runs must be discarded
   rather than scored, because a rewritten certificate is not the candidate's
   behaviour.

## Caveat

Classification is text-based, so a row that contains both a behavioural failure and
an infrastructure marker is counted as behavioural. That biases the infrastructure
share downwards; 27.9% is a floor, not a ceiling. The 22 unclassified rows are
provider session receipts with no score detail.

No thresholds, fixtures, scorers or evidence rows were changed by this measurement.
