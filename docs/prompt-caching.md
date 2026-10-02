# Prompt caching architecture

Koryphaios treats prompt caching as a harness-level contract with provider-specific adapters. The goal is to keep reusable prompt material byte-stable, route equivalent work back to the same provider cache, detect when that expectation fails, and avoid spending money to keep a cache warm when reuse is unlikely.

This document is the source of truth for the prompt-cache design. Evidence caching for workspace artifacts lives separately in `backend/src/cache/`.

## Design invariants

1. The compiled system prompt is the source of truth. A cache plan may describe an immutable prefix, but it never rewrites prompt contents.
2. Cache identities are opaque hashes. Prompt text, workspace paths, account data, and task goals are never embedded in provider cache keys.
3. One workspace may reuse a provider route across sibling tabs. Different workspaces do not share a cache namespace.
4. Manager, worker, critic, compaction, research, and memory work use distinct cache lanes. A role change must not silently reuse another role's diagnostics slot.
5. Tool declarations are canonicalized before hashing. Equivalent tool belts remain stable across registration order and JSON-schema key order.
6. Dynamic tool eligibility must not force declaration churn when the provider supports an allow-list separate from the declared tool universe.
7. A warm candidate is a Kory expectation, not proof of a provider hit. Provider usage telemetry is the authority for confirmed cache reads.
8. Keepalive traffic is optional maintenance work. Economic mode schedules it only when estimated reuse savings exceed refresh cost.

## Ownership map

| File                                              | Responsibility                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/providers/prompt-cache.ts`           | Cache-plan construction, stable-prefix validation, canonical tool hashing, provider routing keys, lane derivation             |
| `backend/src/providers/cache-fabric.ts`           | Lane identities, cache-break attribution, warm/cold diagnostics, provider-confirmed outcomes, adaptive TTL, refresh economics |
| `backend/src/providers/cache-capabilities.ts`     | Provider/model cache-domain policy; reasoning sharing/isolation and conservative fallback                                     |
| `backend/src/providers/cache-capability-store.ts` | Durable, expiring provider/model reasoning compatibility probe results                                                        |
| `backend/src/providers/cache-maintenance.ts`      | Scheduled keepalive, prewarm, cooldowns, stale-route cancellation, unattended refresh limits                                  |
| `backend/src/providers/openai.ts`                 | OpenAI, OpenRouter, and OpenAI-compatible gateway telemetry; OpenAI native cache controls; OpenRouter sticky routing          |
| `backend/src/providers/anthropic.ts`              | Anthropic cache controls, TTL selection, provider cache telemetry                                                             |
| `backend/src/tools/deferred-tools.ts`             | Stable resident tool surface and deferred schemas used to shrink the cached prefix                                            |
| `backend/src/kory/manager.ts`                     | Assigns manager, worker, critic, and compaction lanes; prewarm orchestration                                                  |
| `backend/src/bootstrap.ts`                        | Isolated research lane                                                                                                        |
| `backend/src/kory/prompts/index.ts`               | Produces stable prompt components and the base cache plan                                                                     |
| `backend/src/cache/context-window-projection.ts`  | Non-destructive large-context projection for smaller destination windows                                                      |
| `scripts/benchmark-cache-fabric.ts`               | Deterministic architecture benchmark                                                                                          |
| `scripts/benchmark-cache-live.ts`                 | Live cold/warm/sibling-tab benchmark using Kory provider adapters                                                             |
| `scripts/benchmark-cache-switch-matrix.ts`        | Live reasoning/mode/model switch matrix plus deterministic 500k-class window-downshift report                                 |

## Cache lanes

| Lane         | Typical owner                                        | Reuse boundary                                                           |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `manager`    | Main Kory turn                                       | Workspace, provider cache-domain policy, model, stable prompt, tool belt |
| `worker`     | Worker and one-turn fallback worker                  | Same inputs as manager, isolated from manager state                      |
| `critic`     | Review/verification agent                            | Isolated from worker and manager state                                   |
| `compaction` | Context compaction                                   | Dedicated lane; unattended keepalive is disabled                         |
| `research`   | Native web/research subprocess                       | Dedicated lane; unattended keepalive is disabled                         |
| `memory`     | Reserved for future model-backed memory distillation | No model-backed caller currently requires it                             |
| `default`    | Compatibility fallback                               | Used only when no stronger lane can be inferred                          |

A provider routing key is workspace-scoped and includes the lane kind, stable prefix, model, and canonical tool fingerprint. Reasoning joins that provider-domain key only when the resolved provider/model capability is isolated. Shared-scope routes keep reasoning in the execution-lane identity and transition telemetry without splitting the provider route. A diagnostic slot additionally includes the conversation identity so Kory can explain a local cache break while still recognizing workspace-wide reuse from another tab.

## Provider cache capability policy

`cache-capabilities.ts` resolves provider-native cache behavior before a route is derived. The policy records native cache style, model-domain requirements, reasoning scope, tool policy, provider key control, supported TTLs, telemetry availability, and account scoping.

Reasoning uses four declared states:

- `shared`: medium/high variants may share one provider-native route while remaining distinct execution variants.
- `isolated`: reasoning is part of the provider cache-domain identity.
- `probe`: Kory isolates by default until a provider-confirmed compatibility probe proves shared or isolated behavior.
- `unknown`: Kory fails closed and isolates.

Verified probe results are stored under `<KORYPHAIOS_DATA_DIR>/cache/provider-cache-capabilities.json`. Records expire after 14 days and the store is bounded to 256 provider/model results. Corrupt, missing, stale, or unverified evidence never widens cache sharing. The controlled benchmark override used to test a candidate shared route is diagnostic evidence and is not a product-default policy.

## Provider behavior

### OpenAI

Kory sends a stable `prompt_cache_key` derived from the workspace cache route. GPT-5.6-family requests also receive the supported implicit cache options. Tool declarations stay stable while per-turn eligibility can vary through `allowed_tools`.

OpenAI usage telemetry drives confirmed cache-read accounting and unexpected-warm-miss detection. Keepalive is available for supported GPT-5.6 routes and uses the full successful lane rather than only the static system prefix.

### Anthropic

Kory uses Anthropic cache controls and selects 5-minute or 1-hour TTL behavior from observed reuse. Stable declarations and prewarm behavior preserve the same prefix while preventing tool execution during maintenance calls.

### OpenRouter

Kory uses the workspace-scoped cache route as `session_id` so sibling tabs return to a compatible upstream route. The final message receives an ephemeral cache breakpoint where appropriate.

OpenRouter reasoning compatibility is probe-gated because the upstream provider may vary. Until Kory has provider-confirmed evidence for the selected model, reasoning variants receive isolated native routes.

### Custom OpenAI-compatible gateways

Kory records lane diagnostics and consumes OpenAI-shaped `cached_tokens` / cache-write usage when a custom provider uses the OpenAI wire format. It does **not** automatically send OpenAI-only `prompt_cache_key`, `prompt_cache_options`, or OpenRouter `session_id` fields to arbitrary gateways. A compatible gateway may reject unknown parameters or own upstream routing itself.

This lets Kory measure real cache behavior from gateways such as Experiential Labs without lying about controls the gateway may not support.

Custom OpenAI-compatible gateways are also probe-gated for reasoning compatibility. A successful live matrix can persist a provider/model result; otherwise medium/high variants remain isolated.

## Cache-break attribution

Kory attributes a cold transition to concrete causes:

- new lane
- stable-prefix change
- model change
- reasoning change
- reasoning cache-policy change
- tool-set/schema change
- history rewrite
- base cache-policy change

Named stable prompt components are hashed independently, which makes a stable-prefix change explainable without storing the prompt text in diagnostics.

## Provider-confirmed outcomes

A Kory warm candidate becomes a confirmed hit only when the provider reports cache-read tokens. An unexpected miss is recorded only when Kory expected the lane to be warm, the provider reports zero cache-read tokens, and the provider reports a positive cache write. That avoids false alarms for providers that omit write telemetry or prompts below a provider's cache minimum.

Live per-turn receipts include cache-read tokens, cache-write tokens, estimated turn cost when pricing is known, and estimated cache savings or write premium. Durable accounting also records TTFT and total latency for provider scorecards.

## Keepalive and prewarm

`promptCacheKeepaliveMode` has three values:

- `economic`: estimate expected reuse and schedule only positive-value refreshes.
- `always`: keep eligible routes warm regardless of the economic estimate.
- `off`: never schedule unattended refreshes.

The controller separately prices cached replay tokens and fresh tail tokens. It cancels stale identity routes, limits unattended refreshes, supports sibling-tab prewarm, and rate-limits repeated prewarm attempts. Cold first-turn typing prewarm remains opt-in because it can spend tokens before the user actually sends a request.

## Deferred tool schemas

Manager tools use a stable resident declaration set plus deferred schemas. The deterministic benchmark records total declarations, resident/deferred counts, full/resident serialized schema size, and reduction percentage. This reduces the part of the prompt that must remain byte-stable while preserving tool availability through the deferred-tool path.

## Cross-window model switches

Kory treats a model switch that reduces the available context window as a derived-view problem, not a destructive compaction. `backend/src/cache/context-window-projection.ts` plans the destination view before manager prompt compilation and provider dispatch.

For a switch such as a 1M-context model with roughly 500k live tokens to a 256k-context model:

1. The canonical conversation lineage remains untouched in the message store.
2. Kory reserves destination capacity for the system/tool prefix, model output, tool results, and a safety margin.
3. The oldest portion of the conversation becomes a model-independent checkpoint source while a large exact recent tail is retained.
4. Oversized checkpoint sources are summarized in bounded chunks and pairwise merged so no summarizer request itself exceeds the destination window.
5. The derived checkpoint is cached by a content hash of the summarized prefix and its projection budget. Appending messages to the recent tail can therefore reuse the existing checkpoint instead of re-summarizing the old prefix.
6. Returning to the larger model loads the original full lineage again. The downshift never commits a conversation compaction or replaces the active boundary.

Native provider cache state is still model-specific. Kory does not transfer KV state from the 1M model into the 256k model. Instead, the cache-maintenance controller keeps a bounded bank of up to four recent provider routes per session/role slot so the old model lane can remain warm for switch-back while the destination builds its own lane. Workspace routes retained by sibling tabs are reference-safe: one slot cannot evict a route that another slot still retains.

Reasoning effort is always tracked as an execution variant. It is omitted from the provider routing key only for a shared-scope provider/model policy. Isolated, unknown, and unverified probe routes keep reasoning in the provider domain, so Kory no longer assumes that one provider's compatibility applies universally. Provider telemetry remains authoritative: an unexpected provider-side rewrite is recorded as a cache miss and can be persisted as isolated evidence by the controlled probe path.

Projection checkpoints use an in-memory front cache plus an integrity-checked disk store under `<KORYPHAIOS_DATA_DIR>/cache/context-projections`. Files are owner-only, content hashes are verified before reuse, writes replace through a temporary file, and the store is bounded by age/count pruning. Canonical conversation lineage remains the source of truth, so a missing or corrupt derived checkpoint is simply regenerated.

## Verification

Run the deterministic cache checks:

```sh
bun test backend/src/providers/__tests__/prompt-cache.test.ts \
  backend/src/providers/__tests__/cache-capabilities.test.ts \
  backend/src/providers/__tests__/cache-fabric.test.ts \
  backend/src/providers/__tests__/cache-maintenance.test.ts \
  backend/src/providers/__tests__/custom-cache-diagnostics.test.ts \
  backend/src/cache/context-window-projection.test.ts \
  backend/src/cache/context-projection-store.test.ts
bun run benchmark:cache
```

Run the provider runtime test through the isolated backend harness:

```sh
bun run test:backend:isolated --file backend/src/kory/services/TurnRuntime.test.ts
```

Run a live built-in provider benchmark:

```sh
KORY_CACHE_BENCH_PROVIDER=openai \
KORY_CACHE_BENCH_MODEL=<model> \
OPENAI_API_KEY=<key> \
bun run benchmark:cache:live
```

Run the same Kory path against an OpenAI-compatible gateway:

```sh
KORY_CACHE_BENCH_PROVIDER=custom \
KORY_CACHE_BENCH_BASE_URL=https://gateway.example/v1 \
KORY_CACHE_BENCH_MODEL=<model-slug> \
KORY_CACHE_BENCH_API_KEY=<key> \
bun run benchmark:cache:live
```

The live runner executes cold, warm, and sibling-tab trials and reports TTFT, total latency, cache reads/writes, hit rate, and estimated cost when Kory has pricing for that provider/model. A supplied baseline can be checked in strict mode. Do not claim real-provider cost or latency superiority from deterministic tests alone.

Run the switch matrix against a provider/model:

```sh
KORY_CACHE_BENCH_PROVIDER=custom \
KORY_CACHE_BENCH_BASE_URL=https://gateway.example/v1 \
KORY_CACHE_BENCH_MODEL=<model-slug> \
KORY_CACHE_BENCH_API_KEY=<key> \
KORY_CACHE_MATRIX_PROBE_REASONING=1 \
bun run benchmark:cache:switches
```

The switch matrix records cold/warm reasoning changes, act/plan changes, sibling-tab reuse, optional second-model switch-back, TTFT, latency, cache reads/writes, hit ratio, cost, route/lane state, exact transition reasons, tool ABI hash, and workspace-context hash. It also runs a deterministic roughly-500k-token canonical-history projection through 1M → 256k → 1M → 256k and verifies checkpoint reuse without mutating canonical history. Set `KORY_CACHE_MATRIX_RECORD_REASONING_PROBE=1` only when the run has provider cache telemetry; ambiguous evidence is never persisted as shared.

A dated live run is kept under [`docs/cache-benchmarks/`](cache-benchmarks/). The 2026-09-17 Experiential Labs run records provider-confirmed cache reuse for GPT-5.6 Luna and Nemotron 3 Ultra plus unsupported/unavailable outcomes for the other tested free models. The companion [Empryo comparison](cache-benchmarks/2026-09-17-empryo-comparison.md) keeps public competitor claims, third-party/user evidence, Kory scale tests, and paid-equivalent cache math separate by metric.

The forward architecture for preserving cache value across model, reasoning, mode, and provider switches is tracked in the [Universal Model Caching Master Plan](cache-universal-masterplan.md).

## Adding or changing provider caching

Before adding a provider-specific cache control:

1. Confirm the provider documents the field and its cache semantics.
2. Keep the generic cache plan and lane identity provider-neutral.
3. Gate provider-only request fields to that provider or an explicitly declared capability.
4. Preserve canonical tool order and stable-prefix bytes.
5. Parse provider cache-read/write telemetry when it exists.
6. Add a regression for cold, warm, and workspace/sibling reuse when the provider exposes enough evidence.
7. Update this document and the live benchmark path.

Provider compatibility is a measured capability, not a name-based assumption.
