# Empryo public claims vs Kory cache evidence — 2026-09-17

This note keeps unlike metrics separate. A cache-hit percentage, a reduction in raw input tokens, a provider bill, and growth in cached-token count are not interchangeable.

## Evidence quality

### Empryo first-party benchmark evidence

Empryo publishes a reproducible benchmark repository and reports provider-console billing from separate API keys. The provider bill is useful independent evidence for how many tokens/dollars the benchmark accounts consumed, but Empryo still owns the task selection, harness configuration, and benchmark presentation.

Published claims include:

| Claim                          |              Published numbers |                  Normalized result |
| ------------------------------ | -----------------------------: | ---------------------------------: |
| Round 1 raw input              |          1.09M vs 6.21M tokens |           5.70x fewer input tokens |
| Round 1 billed cost            |                 $1.13 vs $1.58 |                        28.5% lower |
| Round 2 billed cost            |                 $7.08 vs $9.19 |                        23.0% lower |
| Round 3 Opus billed cost       |                 $2.27 vs $3.10 |                        26.8% lower |
| Public GPT proxy cache example | 3,456 -> 21,900+ cached tokens | 6.34x growth in cached-token count |

The 5.70x result is **raw input-token volume**, not a prompt-cache discount. The 6.34x result is **growth in cached-token count**, not a reduction in total bill.

### Third-party/user evidence found

The strongest cache-specific user report found is GitHub Discussion #85 from Firewave118. Before Empryo's May fix, the user observed roughly 95-99% prefix preservation during stable-mode tool loops and identified mode/tool-schema transitions as the main cache-break source. The maintainer later reported fixing both transition sources and measured 97-99% hit ratios after mode switches.

An independent Agent Memory Atlas review exists for Empryo's memory/retrieval architecture, but it is a static code review and does not evaluate prompt-cache cost or latency. LibHunt/Hacker News mentions establish awareness, not cache performance. No independent third-party reproduction of Empryo's provider-billed benchmark or current prompt-cache hit rate was found in this review.

## Kory live GPT-5.6 Luna scale tests

These requests used Kory's real custom OpenAI-compatible provider path against Experiential Labs. The endpoint is free, so its actual bill is $0. The provider-reported cache-read counts are still useful evidence for prefix reuse.

| Approx stable target | Warm input | Warm cache read | Warm hit rate |  Sibling hit rate |
| -------------------: | ---------: | --------------: | ------------: | ----------------: |
|                   5k |      3,514 |           3,486 |        99.20% |            99.91% |
|                  25k |     17,391 |          17,363 |        99.84% |            99.98% |
|                  32k |     22,245 |          22,221 |        99.89% |            99.99% |
|                 100k |     69,428 |          69,405 |        99.97% | 100.00% (99.996%) |

The 32k-target run deliberately lands near Empryo's advertised `21,900+` cached-token example. Kory reported **22,221 cached tokens out of 22,245 input tokens** on the warm request. This exceeds 21,900 as an absolute cached-token count, but it does not prove superiority because Empryo did not publish the total prompt denominator for its example.

## Paid-equivalent input math

OpenAI's published GPT-5.6 Luna rates on this date are $0.20/M uncached input and $0.02/M cached input. Applying those rates to Kory's provider-reported hit profile gives the following **warm-turn input-only equivalent** versus paying fresh-input rate for the whole request:

| Test | Paid-equivalent warm input reduction | Cost ratio vs fully uncached input |
| ---- | -----------------------------------: | ---------------------------------: |
| 5k   |                               89.28% |                      9.33x cheaper |
| 25k  |                               89.86% |                      9.86x cheaper |
| 32k  |                               89.90% |                      9.90x cheaper |
| 100k |                               89.97% |                      9.97x cheaper |

This is not the actual Experiential Labs bill and it excludes output tokens. It answers only: "If this exact hit profile were billed at direct GPT-5.6 Luna fresh-vs-cached input rates, what would the warm input portion cost?"

GPT-5.6 cache writes are published at 1.25x fresh input. If the first request paid a full cache write and only the second request reused it, the two-turn input-only amortized saving is about **32.5%**, or about **1.48x cheaper** than two fully uncached requests. Additional warm turns push the amortized result toward the approximately 10x warm-read limit.

## What Kory can and cannot claim

- Kory **does beat 21,900 cached tokens in an absolute live test**: 22,221 cached on a 22,245-token warm request, and 69,405 cached on the 100k-target run.
- Kory's measured 99.2-99.97% warm hit rates are at least as strong as the 95-99% cache-friendly behavior described in the Empryo user discussion, but the workloads/providers differ.
- Kory's warm-input paid-equivalent reduction approaches 10x versus a fully uncached GPT-5.6 Luna input. That is numerically larger than Empryo's 5.70x raw-token benchmark, but the metrics are different and must not be presented as "Kory is 10x vs Empryo 5.7x."
- Kory has **not yet reproduced Empryo's 5.70x reduction in total raw input tokens on the same coding workload**.
- Kory has **not yet reproduced or beaten Empryo's 23-28.5% end-to-end provider-billed task-cost advantage** against the same competing harness on the same bug set.

The next decisive benchmark is a same-task harness comparison using separate provider keys, hidden acceptance tests, and provider billing as the source of truth. That is the test required for an honest end-to-end cost superiority claim.
