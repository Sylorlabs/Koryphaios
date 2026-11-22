# Pushing recorded pass rates to 0.9

The bar for this round was a measured pass rate of at least 0.9 on every skill that was below
it. It started with 26 ready skills below 0.9 and one blocked near miss, and ends with 16 of
those 26 at or above the bar. All 26 are still `ready`; nothing was left worse than it was found.
The library stands at 149 ready of 182.

## What moved

| skill | before | after |
| --- | --- | --- |
| ruby-engineering | 0.827 | 1.000 |
| experimental-analysis | 0.871 | 1.000 |
| information-architecture | 0.889 | 1.000 |
| concurrency-debugging | 0.857 | 1.000 |
| supply-chain-security | 0.857 | 1.000 |
| feature-implementation | 0.875 | 1.000 |
| event-driven-architecture | 0.894 | 0.952 |
| embedding-systems | 0.864 | 0.947 |
| nodejs-runtime | 0.841 | 0.946 |
| performance-testing | 0.897 | 0.946 |
| angular-engineering | 0.818 | 0.944 |
| customer-success | 0.844 | 0.921 |
| application-security | 0.844 | 0.917 |
| database-performance | 0.889 | 0.913 |
| java-jvm-engineering | 0.800 | 0.909 |
| graphql-engineering | 0.840 | 0.909 |

Ten ready skills remain below the bar: mlops 0.842, distributed-backend 0.864,
integration-fault-testing 0.868, nextjs-engineering 0.889, swift-engineering 0.889,
web-interface 0.889, data-analysis 0.895, vector-search-systems 0.895,
performance-verification 0.895, svelte-engineering 0.895. Two more that became ready during the
round sit at 0.818 (cloud-security) and 0.864 (language-runtime-security).

## Four shared evidence defects found and repaired

Each one refused an artifact that satisfied the requirement as the sealed task states it, and
each carries a positive and a negative control.

1. **A candidate-owned artifact was classified as harness-owned by word matching.**
   `isExternalArtifact` tested `\b(?:paired|comparison|experiment|evaluation)\b` against the whole
   hyphenated name, so `findability-evaluation-plan` and
   `experimental-analysis-individual-scenario-1-result` were both demanded as
   `external-evaluator` while the candidate was right to mark them `produced`. That single test
   failed 16 of 17 information-architecture runs. Ownership is now decided by a
   hyphen-separated `paired` or `comparison` segment. Controls: the pairing artifacts are still
   accepted as external, and marking the candidate-owned evaluation artifact as external is
   still refused.

2. **Regression coverage could not see a Java or Ruby test.** `REGRESSION_TEST_FILE_NAME`
   recognized `.test.ts` and `_test.py` only. The Java and Ruby fixtures ship a
   `tests/*-regression.md` instruction asking for regressions and then read them back through
   that matcher, so a candidate that followed the instruction with `TenantSchedulersTest.java`
   was scored as having written none. This was the dominant failure on java-jvm-engineering (18
   of 28 runs). Controls: `*Test.java`, `*Tests.java`, `*IT.java`, `*Spec.java`, `*_spec.rb` and
   `*_test.rb` are accepted; a production source file, a prose note and a README are still
   refused.

3. **The Angular fixture graded two values it never named.** The scorer requires
   `angularVersion` and, per scenario, a `nearNeighbor` of either `react-engineering` or
   `svelte-engineering`, while the README asked only for a field named `nearNeighbor`. Both
   values are now stated in the README it grades.

4. **The blind reviewer refused the largest real assignment.** The adapter's request cap was
   256 KB; angular-engineering's sealed prompt measures 282 to 285 KB, so dispatch was refused
   with "exceeds the byte limit" and that skill could never earn a blind review. The cap is a
   runaway guard rather than a model limit, so it is now 512 KB with the measurement recorded
   beside it. The review then completed and graded.

## The mechanism, measured

The pass rate is a cumulative average over every recorded candidate attempt, not a property of
the current fixture. Running more campaigns therefore moves it in whichever direction the model
actually performs, and grinding an already-strong skill lowers the number:

| skill | before a round | after one round |
| --- | --- | --- |
| java-jvm-engineering | 0.800 | 0.727 |
| embedding-systems | 0.864 | 0.848 |
| cloud-security | 0.864 | 0.773 |

Two things follow. A skill cannot be talked up to 0.9 by adding attempts. And the only
legitimate way to raise the number is to remove attempts that should never have been recorded,
which is what the four repairs above did: a defect repair plus a generation bump re-derives the
evidence, so the average is computed from attempts that were scored against the corrected
fixture. That is also why the ten remaining skills sit where they sit: their failures are real
capability failures (a candidate that never ran the hidden check, never wrote the regression
file, or produced a wrong artifact), and nothing in the fixture rewards inventing a different
number.

## Damage control, stated plainly

Three skills were transiently below `ready` while being driven and are all restored and above
their starting point: java-jvm-engineering (0.800 to 0.909), embedding-systems (0.864 to 0.947),
application-security (0.844 to 0.917). cloud-security dipped to 0.773 mid round and is back at
0.818, still ready. No ready skill in the library is blocked that was ready at the start of this
round.

## Tests

`skill-eval-evidence-contract-regressions` 66 pass, `skill-eval-sealed-evidence-fixtures` 9
pass, `skill-eval-promotion-repair-lane` 17 pass, `skill-eval-promotion-repair` 6 pass, 0 fail.
The sealed-evidence suite timed out twice while the machine carried other load and passed on a
quieter run; that is a timeout, not a regression.
