# Experiential Labs cache benchmark — 2026-09-17

This run exercises Koryphaios's real custom OpenAI-compatible provider path against `https://api.experientiallabs.ai/v1`. The API key was supplied at runtime and was not written to the repository.

## Method

Each chat-capable model receives the same Kory cache plan with an approximately 5,000-token stable target and three requests:

1. `cold`: first request in tab A.
2. `warm`: appended history in tab A.
3. `sibling-tab`: the same warm history in tab B, using the same workspace-scoped stable prefix.

The benchmark records provider-reported input, cache-read and cache-write tokens plus local TTFT and total latency. Custom gateways participate in Kory's cache diagnostics, but Kory does not send OpenAI-only `prompt_cache_key`, `prompt_cache_options`, or OpenRouter `session_id` fields to an arbitrary gateway.

## Results

| Model                        | Cold cache read | Warm cache read / hit rate | Sibling cache read / hit rate | Cold latency | Warm latency | Sibling latency | Result                                                                                                                     |
| ---------------------------- | --------------: | -------------------------: | ----------------------------: | -----------: | -----------: | --------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `gpt-5.6-luna`               |       0 / 3,489 |     3,486 / 3,514 (99.20%) |        3,511 / 3,514 (99.91%) |     1,409 ms |     1,077 ms |        1,575 ms | Provider-confirmed cache reuse in the same tab and sibling tab                                                             |
| `nemotron-3-ultra-550b-a55b` |       0 / 3,700 |     3,072 / 3,730 (82.36%) |        3,072 / 3,730 (82.36%) |       987 ms |     1,657 ms |        1,656 ms | Provider-confirmed cache reuse; no latency win in this sample                                                              |
| `union-alpha`                |               — |                          — |                             — |            — |            — |               — | Upstream returned repeated HTTP 502 responses; no cache measurement                                                        |
| `jev-latest`                 |               — |                          — |                             — |            — |            — |               — | Rejected chat/streaming with `unsupported_capability`; provider directs this model to its native decision endpoint instead |

### GPT-5.6 Luna detail

- Cold: 3,489 input tokens, 0 cached, TTFT 1,214 ms, total 1,409 ms.
- Warm: 3,514 input tokens, 3,486 cached, TTFT 915 ms, total 1,077 ms.
- Sibling tab: 3,514 input tokens, 3,511 cached, TTFT 1,447 ms, total 1,575 ms.

The warm request was faster than cold in this run, but the sibling request was slower despite a higher cache-hit rate. Cache reuse and latency must therefore be reported separately.

### Nemotron 3 Ultra detail

- Cold: 3,700 input tokens, 0 cached, total 987 ms.
- Warm: 3,730 input tokens, 3,072 cached, total 1,657 ms.
- Sibling tab: 3,730 input tokens, 3,072 cached, total 1,656 ms.

The provider reported cache hits but did not emit visible content within the benchmark's small output allowance, so TTFT was unavailable. The input-cache measurements remain provider-reported evidence.

## What this proves

- Kory preserves enough stable prompt material for two very different gateway models to report substantial repeated-input cache hits.
- Workspace-equivalent sibling-tab requests can reuse provider cache state even through a custom OpenAI-compatible gateway.
- Kory now observes custom-gateway cached-token telemetry in the same diagnostic system used by direct OpenAI/OpenRouter routes.
- A cache hit is not a latency guarantee. Provider routing, queueing, model execution, and gateway overhead can dominate TTFT or total latency.

## What this does not prove

This is not a Koryphaios-vs-Empryo A/B. Experiential Labs owns its upstream gateway routing and may perform its own caching. Because Kory intentionally does not send undocumented provider-specific cache controls to arbitrary custom gateways, these runs prove byte-stable reuse and provider-confirmed cache observation, not that Kory alone caused the upstream hit.

A claim that Kory has lower real-world latency or cost than Empryo still requires the same model/provider workload through both harnesses with identical prompt history, tool schemas, cache age, region, and trial count.
