# Universal Model Caching Master Plan

Status: active implementation; cross-window projection, multi-lane switch-back, provider capability policy, and switch-matrix runner landed by 2026-09-18

## Objective

Make Koryphaios preserve useful cache value across normal user behavior: mode changes, reasoning-effort changes, tab changes, worker/critic transitions, model switching, provider switching, conversation branches, compaction, and workspace updates.

The goal is not to pretend one provider's model KV cache can be copied into another model. Provider-native prompt caches are model/provider execution artifacts. The universal layer must instead make every reusable input artifact model-independent, keep compatible provider-native lanes warm, and make unavoidable cold model switches cheap and predictable.

Success means users can change models or reasoning freely without having to understand cache mechanics. When native cache reuse is physically possible, Kory preserves it. When it is not, Kory reuses all model-independent work, prewarms the destination when economical, and keeps the old route available for a cheap switch back.

### Implemented in the first universal-cache slice

- Reasoning routing is provider/model capability-scoped. Verified shared routes omit reasoning from the provider cache-domain key; isolated, unknown, and unverified probe routes fail closed and keep separate provider routes.
- `cache-capabilities.ts` centralizes native caching style, model-domain rules, reasoning scope, tool policy, cache-key control, TTLs, telemetry, and account-scoping policy.
- Provider/model reasoning probes persist with expiry in an owner-only bounded store; stale or ambiguous evidence cannot widen sharing.
- Prompt-cache maintenance retains a bounded LRU bank of recent native routes per session/role slot instead of cancelling the previous route immediately on model switch.
- Switch-back diagnostics recognize a previously seen route as a warm candidate rather than classifying it as a new cold lane.
- Typing/model-picker prewarm resolves the selected destination route instead of returning early after refreshing whichever session route happened to be current.
- `context-window-projection.ts` derives a non-destructive checkpoint plus exact recent tail when the destination verified context window is smaller than the canonical conversation.
- Projection checkpoints are keyed independently of model/reasoning and can be reused across appended recent-tail messages when the summarized prefix is unchanged.
- Projection checkpoints survive app restarts through an integrity-checked, owner-only, bounded disk store; missing or corrupt derived state is regenerated from canonical history.
- A 500k-class synthetic source → 256k destination → 1M switch-back case is covered by deterministic regression tests. Canonical history is never committed as compacted merely because the user changed models.
- `benchmark-cache-switch-matrix.ts` now records reasoning/mode/model transitions, provider cache telemetry, route state, exact break reasons, tool/workspace hashes, cost/latency, and the 1M → 256k → 1M → 256k projection sequence. Live competitive cells still need to be run.

## Competitive baseline: where Empryo still wins

Empryo currently has the stronger end-to-end benchmark evidence even though Kory has stronger live cache-hit evidence on the tested Luna workloads.

| Area                         | Empryo public evidence                                                    | Current Kory evidence                                                                                   | Gap to close                                                                          |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Round 1 raw input            | 1.09M vs 6.21M input tokens, 5.70x fewer                                  | No same-workload Kory run                                                                               | Beat 1.09M while matching or exceeding 8/9 fixed                                      |
| Round 1 provider bill        | $1.13 vs $1.58, about 28.5% lower                                         | No same-workload Kory run                                                                               | < $1.13 with >= 8/9 fixed                                                             |
| Round 1 wall clock           | 4m16s vs 10m00s, about 57% lower                                          | No same-workload Kory run                                                                               | < 4m16s with >= 8/9 fixed                                                             |
| Round 2 provider bill        | $7.08 vs $9.19, 23% lower; 7/10 vs 6/10 fixed                             | No same-workload Kory run                                                                               | <= $7.08 and >= 7/10 on the exact fixture                                             |
| Round 2 wall clock           | 22m30s vs 32m55s, about 32% lower                                         | No same-workload Kory run                                                                               | < 22m30s with >= 7/10 fixed                                                           |
| Round 2 agent steps          | 274 vs 382, about 28% fewer                                               | No same-workload Kory run                                                                               | < 274 steps without accuracy loss                                                     |
| Round 3 Opus 5 cost          | $2.27 vs $3.10, 27% lower; both 4/4                                       | No same-workload Kory run                                                                               | < $2.27 and 4/4                                                                       |
| Round 3 Opus 5 wall clock    | 5m45s vs 9m35s, 40% lower                                                 | No same-workload Kory run                                                                               | < 5m45s median with equal accuracy                                                    |
| GPT-5.6 Luna accuracy        | 100% fixed vs 88%                                                         | No same-workload Kory run                                                                               | 100% on the same benchmark cells                                                      |
| Haiku wall clock             | 11% lower, same bugs fixed; helper-model assist is part of Empryo's setup | No same-workload Kory run                                                                               | Beat the billed and latency result with all helper cost included                      |
| Mode switching cache         | Maintainer-reported 97-99% hit ratio after mode switches                  | 99.20-99.97% on ordinary warm Luna turns; no switch-specific benchmark yet                              | Prove >= 99% across act/plan/mode transitions                                         |
| Reasoning switch             | Explicit warning that a warm 619k session drops its whole cache           | Kory now shares only verified-compatible provider/model routes; probe/unknown routes isolate by default | Prove provider-confirmed >=99% reuse on shared-scope routes in the live switch matrix |
| Tool schema churn            | Stable declarations; mode restriction via allow-list                      | Stable/canonical declarations and deferred tools; 74.5% schema reduction                                | Kory has strong architecture; needs cross-mode proof                                  |
| Productized switch economics | Cost Center and pre-switch cache-loss warning                             | Per-turn receipts and diagnostics exist                                                                 | Add destination-lane cost prediction and automatic prewarm                            |

### The 619k reasoning-switch penalty

Empryo documents a warm 619k-token GPT-5.6 session where changing reasoning effort drops the whole prompt cache. Kory previously had the same structural behavior because `reasoningLevel` participated in `createCacheLane()` and therefore changed `deriveProviderPromptCacheKey()`. Kory now removes reasoning from provider routing identity only when the provider/model capability resolves to `shared`; all other routes isolate until evidence says otherwise. Live provider-confirmed reasoning-switch benchmarks are still required before claiming the 619k penalty is avoided on a particular route.

At the current GPT-5.6 Luna prices of $0.20/M fresh input, $0.02/M cached input, and a cache write at 1.25x fresh input:

- 619k cached read: about **$0.01238** input cost.
- 619k fresh input without a new write premium: about **$0.12380**, or **10x** the cached-read input cost.
- 619k cache write at $0.25/M: about **$0.15475**, or **12.5x** the cached-read input cost.
- Incremental write-vs-read penalty for that one switch: about **$0.14237**.

This is the first universal-cache target because it is both expensive and architecturally avoidable on providers where reasoning effort is not part of cache identity.

## Fundamental constraint

Native KV/prefix caches generally cannot cross these boundaries:

- different model weights or model revisions;
- different providers or provider cache domains;
- different accounts/projects/regions when the provider scopes cache there;
- incompatible tokenizers or prompt renderers;
- provider-defined request options that participate in cache identity.

Kory must never claim to transfer native cache state across those boundaries unless the provider explicitly documents or empirically proves compatibility.

The universal system therefore has two layers:

1. **Universal context cache**: model-independent content-addressed artifacts that can be reused everywhere.
2. **Provider lane bank**: provider-native warm lanes for specific cache domains, maintained and selected intelligently.

## Remaining Kory implementation gaps found in the code

These are concrete boundaries in the current implementation, not speculative future concerns.

1. **Provider cache-domain capability rules now exist, but coverage still needs evidence.** The registry and durable reasoning probe store are implemented. OpenRouter/custom gateway routes are probe-gated and unknown providers fail closed; more provider/model revisions still need documented or live-confirmed entries.
2. **The native lane bank is implemented, but routing policy is still simple.** `PromptCacheMaintenanceController` retains up to four recent routes per slot and preserves sibling-owned workspace routes. It does not yet score likely next models, TTL remaining, or switch cost to decide which lanes deserve maintenance budget.
3. **Cold prewarm currently supports only direct OpenAI and Anthropic.** `performColdCachePrewarm()` returns `provider-does-not-support-prewarm` for OpenRouter and custom gateways even when those routes may expose useful cache behavior.
4. **Universal deterministic evidence exists but is a separate subsystem.** `backend/src/cache/evidence-cache.ts` and Git evidence caching already provide content/revision reuse, but prompt-cache identity does not treat those artifacts as one universal context graph.
5. **Diagnostics still expose a previous-slot view rather than the whole warm portfolio.** Switch-back is now recognized through route history and the maintenance controller keeps multiple live routes, but UI/telemetry does not yet expose TTL and economics for every retained route together.
6. **Prompt compilation already has a useful stable prefix boundary.** `compilePrompt()` separates `stableSections` from task and skill material. That is a strong base to preserve. The universal design should extend that segmentation to mutable manager additions such as memory, research, permission/mode state, and other turn-specific system suffixes rather than replacing the compiler.
7. **Tool stability is already a Kory strength.** Canonical declarations, dynamic `allowedToolNames`, and deferred manager schemas should be retained as the tool-ABI layer. The measured 74.5% schema reduction is useful evidence and should become part of switch-matrix reporting.
8. **The switch-matrix runner exists, but the full live proof still needs provider-confirmed runs.** The runner captures reasoning/mode/model transitions plus deterministic 500k-class → 256k projection and switch-back. Kory still needs live billed/cache telemetry for the target providers, provider switches, branch/rewind cases, and exact Empryo benchmark cells before claiming universal performance superiority.

The plan below is therefore a refactor around existing working pieces, not a rewrite of prompt caching from scratch.

## Architecture: split content identity from execution identity

The current route key mixes prompt content with model and reasoning execution choices. Replace that with three explicit identities.

### 1. Universal context identity

`UniversalContextKey` describes reusable semantic input independent of model execution:

- Kory base policy version;
- workspace instruction graph;
- repository snapshot revision plus dirty-tree delta;
- stable tool ABI version;
- committed memory/checkpoint revisions;
- immutable conversation-prefix node;
- stable skill/evidence artifacts.

It must not include model, reasoning effort, temperature, fast mode, max output, or provider account.

### 2. Provider cache-domain identity

`ProviderCacheDomainKey` describes what the provider itself requires for native cache reuse:

- provider and endpoint;
- account/project/organization identity hash when relevant;
- region/cache shard when known;
- exact provider model revision or proven cache-compatible alias family;
- provider wire adapter and tokenizer/prompt-renderer family;
- stable tool declaration fingerprint;
- only request options proven to affect provider cache identity.

Reasoning level must not be included by default. It should be included only when documentation or a live compatibility probe proves that the provider invalidates cache across effort changes.

### 3. Execution variant identity

`ExecutionVariantKey` tracks behavior without forcing cache separation:

- reasoning effort;
- fast/priority mode;
- temperature/top-p;
- output-token cap;
- permission/interaction mode;
- dynamic allowed-tool set;
- current task state.

This key belongs in telemetry, correctness, and routing decisions. It only enters the native cache-domain key when a provider capability policy says it must.

## Core component 1: Universal Context Graph

Add a content-addressed DAG rather than rebuilding one monolithic prompt on every route.

Suggested module: `backend/src/cache/universal-context.ts`.

Each node has:

```ts
interface UniversalContextNode {
  hash: string;
  kind:
    | 'base-policy'
    | 'workspace-instructions'
    | 'repo-snapshot'
    | 'repo-delta'
    | 'tool-abi'
    | 'memory-checkpoint'
    | 'conversation-message'
    | 'state-event'
    | 'evidence'
    | 'skill-artifact';
  parents: string[];
  content: string | structured payload;
  revision?: string;
}
```

The graph provides an immutable longest-common-prefix path for every conversation branch. A rewind or regenerate creates a new branch without destroying the previous reusable prefix.

The existing Git-addressed evidence cache should become one source of graph nodes rather than a parallel caching concept.

## Core component 2: Append-only session state

Any mutable session setting should stop rewriting early prompt bytes.

Represent these changes as append-only state events placed immediately before the next user turn:

- act <-> plan/mode changes;
- permission-mode changes;
- allowed-tool changes;
- reasoning-effort changes when the model needs textual guidance;
- review/coder lane transitions;
- workspace/repo delta notifications;
- memory updates that became relevant after the previous turn.

Example logical transcript:

```text
[stable base]
[stable tool ABI]
[workspace snapshot]
[conversation through turn N]
[KORY_STATE mode=plan reasoning=high allowedTools=...]
[user turn N+1]
```

The prior prefix remains byte-identical. This is the same structural principle behind Empryo's successful 97-99% mode-switch result, but Kory should apply it to every mutable session dimension.

## Core component 3: Provider cache-capability registry

Implemented in `backend/src/providers/cache-capabilities.ts` with durable empirical results in `cache-capability-store.ts`.

Every provider/model route should resolve a policy such as:

```ts
interface PromptCacheCapabilities {
  nativeCaching: 'explicit' | 'implicit' | 'gateway' | 'local-prefix' | 'none';
  modelRequiredInDomain: boolean;
  reasoningScope: 'shared' | 'isolated' | 'probe' | 'unknown';
  toolPolicy: 'stable-declarations-allowlist' | 'stable-meta-tools' | 'exact-toolset';
  cacheKeyControl: 'native-key' | 'sticky-session' | 'none';
  ttl: Array<'5m' | '30m' | '1h' | 'provider-managed'>;
  writeTelemetry: boolean;
  readTelemetry: boolean;
  accountScoped: boolean;
}
```

Sources, in priority order:

1. provider-documented contract;
2. Kory-maintained verified catalog entry;
3. live non-destructive compatibility probe;
4. conservative unknown policy.

Unknown must fail closed: isolate routes rather than silently assuming compatibility.

## Core component 4: Reasoning-compatible cache routing

Current behavior is capability-scoped: changing `medium` to `high` shares a provider route only when the resolved provider/model policy is `shared`. Unknown and unverified probe routes isolate.

New behavior:

- `reasoningScope: shared`: reasoning is removed from `ProviderCacheDomainKey`; same native cache route, different `ExecutionVariantKey`.
- `reasoningScope: isolated`: keep one lane per effort level.
- `reasoningScope: probe`: run a tiny cache-read experiment once per provider/model revision, then persist the result with provenance and expiry.
- `reasoningScope: unknown`: isolate until proven.

Regressions now assert both directions: shared-scope models keep the provider key while diagnostics retain the effort transition, and isolated/unknown routes produce separate provider keys.

## Core component 5: Native Cache Lane Bank

Add `backend/src/providers/cache-lane-bank.ts`.

Today Kory mostly thinks in terms of one current route per session. Replace that with a portfolio of recent native lanes:

```ts
interface NativeCacheLaneRecord {
  universalContextKey: string;
  providerCacheDomainKey: string;
  providerRoutingKey: string;
  provider: string;
  model: string;
  executionVariantsSeen: string[];
  lastConfirmedReadAt?: number;
  lastWriteAt?: number;
  expiresAt?: number;
  estimatedReusableTokens: number;
  hitRateEwma: number;
  switchCount: number;
  refreshCostUsd?: number;
  expectedReuseValueUsd?: number;
}
```

Switching away from a model does not discard its lane. Switching back inside TTL should immediately reuse it.

## Core component 6: Shadow-lane prewarming

Model switching cannot reuse a different model's native KV cache. Hide that limitation with selective shadow lanes.

Prewarm candidates from:

- the user's recent model-switch history;
- currently visible/favorited model choices;
- lane defaults such as coder/reviewer pairs;
- an explicit user model selection while they are still typing;
- expected fallback routes.

Do not prewarm every model. Use a portfolio optimizer:

```text
expected value = P(switch before expiry) * expected read savings
                 - prewarm/write cost
                 - keepalive cost
```

Keep the top K positive-EV lanes, with K bounded by user budget and provider limits.

This extends the existing economic keepalive controller rather than creating a separate uncontrolled scheduler.

## Core component 7: Switch Coordinator

Add `backend/src/cache/cache-switch-coordinator.ts` and a small UI/store integration.

On model/reasoning selection:

1. Resolve the destination cache domain.
2. Check for a confirmed live lane in the bank.
3. If same-domain and reasoning-compatible, switch immediately with no prewarm.
4. If a destination lane is warm, route to it.
5. If cold and prewarming is positive-EV, start a one-token prewarm in parallel with user typing/composer activity.
6. Reuse universal context graph artifacts without recomputing repo maps, instructions, evidence, or summaries.
7. Surface an optional estimate such as `Warm`, `Likely warm`, or `Cold (~$0.14 input rebuild)`; never block the user's switch.

## Core component 8: Stable tool ABI virtualization

Keep Kory's current strengths and make them universal:

- canonical tool ordering;
- stable resident declarations;
- deferred schemas;
- dynamic allow-list where the provider supports it;
- stable meta-tool fallback where it does not.

Add an explicit `ToolAbiVersion` hash so model and mode switches can prove the declaration prefix is unchanged.

Target: act/plan/permission changes must never alter the declared tool-schema bytes unless a real tool implementation/schema changed.

## Core component 9: Workspace snapshot plus append-only deltas

Empryo already documents this pattern. Kory should make it first-class and measurable.

Build one immutable workspace snapshot keyed by:

- Git HEAD;
- dirty-tree fingerprint;
- applicable instruction-file hashes;
- selected deterministic repository metadata.

Changes after the snapshot become append-only repo-delta nodes. A cold provider lane can rebuild from the current snapshot; a warm lane only sees the delta.

The existing Git evidence cache provides much of the deterministic substrate.

## Core component 10: Model-independent compaction checkpoints

Compaction output should be a committed universal context artifact, not owned by the model that produced it.

Once validated and committed:

- every model consumes the same checkpoint payload;
- provider adapters render it in their preferred wire shape;
- subsequent deltas append after it;
- switching models does not trigger a new summary just because the tokenizer/model changed.

Record the producer model for provenance, but keep it out of the context identity.

## Core component 11: Provider adapter mapping

Map the universal graph to each provider without leaking provider quirks upward.

### OpenAI

- stable `prompt_cache_key` from `ProviderCacheDomainKey`;
- explicit/implicit breakpoints as supported;
- reasoning omitted from cache key when verified shared;
- dynamic allowed-tools separate from declarations;
- 30-minute cache-life-aware lane bank.

### Anthropic

- explicit cache boundaries at universal graph segment cuts;
- adaptive 5m/1h TTL;
- keep tool declarations stable;
- separate reasoning lane only if Anthropic semantics require it.

### OpenRouter

- sticky `session_id` derived from provider cache domain;
- tail cache control on newest append-only segment;
- preserve upstream/provider identity when known;
- never pretend two upstream models share a native cache.

### Custom OpenAI-compatible gateways

- observe cached-token telemetry;
- do not send undocumented cache controls;
- allow capability opt-in only after explicit configuration or successful probe.

### Local vLLM/Ollama/llama.cpp-style providers

- use exact model-artifact/tokenizer fingerprint where exposed;
- preserve byte/token sequence across modes;
- treat model reload or engine restart as a cold-domain event;
- avoid provider-specific assumptions when telemetry is absent.

## Core component 12: Account, endpoint, revision, and region isolation

The universal content cache may be shared locally, but native provider lane identities must include every security/cache-domain boundary known to matter.

At minimum include hashed:

- provider endpoint;
- account/project/org identity when available;
- model revision/fingerprint;
- region/shard if the API exposes it.

This prevents false warm expectations and accidental cache affinity across credentials.

## Core component 13: Cache-aware model routing

Model selection should consider quality, cost, and existing warm state.

Do not force a worse model just because it is warm. Instead expose cache state as one routing feature:

```text
score = quality_fit
      - expected_total_cost
      - expected_latency
      + warm_lane_bonus
      + switch_back_value
```

Auto routing can prefer an already-warm equivalent model when quality is effectively tied, while explicit user selections always win.

## Core component 14: Cold-recovery planner

When a lane expires, Kory should know exactly what must be rebuilt.

Classify artifacts as:

- still valid and reusable locally;
- provider-native cache expired only;
- workspace snapshot stale;
- history branch changed;
- tool ABI changed;
- model/provider domain changed.

Only recompute stale artifacts. A cold provider cache should not cause repo discovery, memory retrieval, tool schema generation, or evidence collection to repeat unnecessarily.

## Benchmark suite required before claiming victory

### A. Cache switch matrix

Implemented as `scripts/benchmark-cache-switch-matrix.ts`; remaining work here is collecting repeatable live evidence across the target providers and Empryo-equivalent workloads.

Sequence example:

```text
Luna medium act
Luna high act
Luna medium act
Luna medium plan
Luna medium act
Terra medium act
Luna medium act
Anthropic model A medium
OpenRouter model A medium
```

For each transition record:

- input/cache-read/cache-write tokens;
- hit ratio;
- first-token and total latency;
- provider-billed cost when available;
- universal-context artifacts reused;
- native lane reused/prewarmed/cold;
- exact break reason;
- tool ABI hash;
- workspace snapshot hash.

### B. Reasoning-switch matrix

For every model with multiple reasoning levels:

- cold level A;
- warm level A;
- switch A -> B;
- switch B -> A;
- repeat after 5m, 30m, and provider TTL where practical.

Promote `reasoningScope` from `probe` only after repeated provider-confirmed evidence.

### C. Mode/permission switch matrix

Target >= **99% cache-read ratio** of the reusable prefix across act/plan and permission changes for providers capable of prefix caching.

This directly beats Empryo's public 97-99% mode-switch result if reproduced on equivalent workloads.

### D. Model-switch bank test

Round robin between 2, 3, and 5 models for at least 20 switches.

Measure:

- first switch to a never-used model, expected cold;
- switch-back hit rate within TTL;
- total prewarm spend;
- total avoided write/read spend;
- lane eviction decisions.

Target: after initial warm-up, >= **95% switch-back native-cache hits** for lanes retained by the portfolio optimizer.

### E. Large-context switch test

Run 32k, 100k, 300k, and ~619k reusable prefixes where model limits permit.

Primary acceptance test: a compatible reasoning change must not force a full new write.

### F. Empryo benchmark reproduction

Use the public `empryo-bench` fixtures with:

- separate provider keys per harness;
- identical model, reasoning, timeout, and tool permissions;
- hidden acceptance tests unchanged;
- at least the published repetition count;
- provider bill as source of truth.

Kory victory gates:

- Round 1: **< 1.09M raw input tokens**, **< $1.13 billed**, **< 4m16s**, >= 8/9 fixed.
- Round 2: **< $7.08 billed**, **< 22m30s**, **< 274 steps**, >= 7/10 fixed.
- Round 3 Opus 5: **< $2.27 billed**, **< 5m45s median**, 4/4 fixed.
- Luna: **100% fixed** across the same evaluated cells.

These gates are intentionally stricter than merely matching Empryo.

## Acceptance gates for the universal cache system

### Correctness

- No native cache-domain sharing across unproven model/provider/account boundaries.
- No permission or tool-policy weakening for cache stability.
- History rewrites branch cleanly and never reuse post-branch state.
- Universal context artifacts include revision/provenance checks.

### Cache performance

- Ordinary warm turns: >= 99% reusable-prefix hit where provider telemetry allows.
- Mode switches: >= 99% reusable-prefix hit.
- Shared-scope reasoning switches: >= 99% reusable-prefix hit with no full cache write.
- Switch-back to retained model lanes: >= 95% native-cache hit within TTL.
- Tool declaration changes only when real schema changes.

### Cost

- Prewarm/keepalive portfolio must have positive measured expected value in `economic` mode.
- No unbounded background refreshes.
- A user model switch must never trigger duplicate cache writes for the same provider domain and universal context key.
- Large-context reasoning switch should approach cached-read cost on shared-scope providers rather than a full write.

### Latency

- Warm-to-warm reasoning/mode switches: <= 15% TTFT regression versus a same-setting warm turn at p50.
- Retained-model switch-back: <= 20% TTFT regression versus that model's same-lane warm baseline.
- Universal context assembly should remain local-cache-bound and not redo repository discovery.

### Observability

Every turn should answer:

- what universal context key was used;
- what provider cache domain was used;
- whether the native lane was warm, prewarmed, cold, or expired;
- why a cache break occurred;
- cache read/write/fresh tokens;
- estimated dollars saved or spent by the switch;
- whether a prewarm paid off.

## Implementation phases

### Phase 0 — Proof and invariants

- Add the switch-matrix benchmarks before changing routing semantics.
- Capture current medium/high key split as a regression fixture.
- Add mode-switch and model-switch baselines.
- Add provider capability fixtures for OpenAI, Anthropic, OpenRouter, custom gateway, and local prefix-cache provider.

Exit: current losses are reproducible and measured.

### Phase 1 — Identity split

- Introduce `UniversalContextKey`, `ProviderCacheDomainKey`, `ExecutionVariantKey`.
- Refactor `cache-fabric.ts` so reasoning is no longer hard-coded into every provider route.
- Preserve old diagnostics during migration.

Exit: identical prompt content can have different execution variants without automatically receiving different native keys.

### Phase 2 — Provider capability registry

- **Implemented:** static verified capabilities and conservative unknown policy.
- **Implemented:** provenance and expiry for empirical reasoning probes.
- **Implemented:** OpenAI/OpenRouter/custom-compatible and Anthropic/Bedrock cache routing use the resolver; cold prewarm derives the same provider-aware destination route.

Exit status: reasoning-domain policy is explicit and test-covered. Full model/tool/account-domain provenance remains part of the broader identity-split work.

### Phase 3 — Append-only state events

- Move mode, permission, and mutable turn state to late session events.
- Keep stable base/tool ABI byte-identical.
- Add exact-prefix tests around act/plan transitions.

Exit: Kory proves >=99% mode-switch cache reuse on supported providers.

### Phase 4 — Reasoning reuse

- **Implemented:** remove reasoning from provider cache key on verified shared-scope routes.
- **Implemented:** maintain isolated effort lanes for isolated, unknown, and unverified probe routes.
- **Implemented in the lane portfolio:** return-to-previous-effort routes remain retained when they are distinct native domains.

Exit remains open until a provider-confirmed 619k-class compatible effort switch avoids a full cache rewrite in the live matrix.

### Phase 5 — Universal Context Graph

- Content-address prompt/context artifacts.
- Integrate Git evidence cache, workspace snapshots, memory checkpoints, and immutable conversation branches.
- Cache provider rendering/token estimates by model revision.

Exit: model/provider switches reuse all model-independent preprocessing.

### Phase 6 — Lane Bank and switch coordinator

- Keep multiple recent native lanes.
- Add destination lookup, switch-back reuse, expiry handling, and lane eviction.
- Connect model/reasoning picker events to non-blocking cache preparation.

Exit: repeated 2-5 model switching remains warm after first use where TTL permits.

### Phase 7 — Economic shadow prewarming

- Extend existing maintenance economics into a multi-lane portfolio.
- Learn switch probabilities locally from recent behavior.
- Cap concurrency, spend, and unattended refresh count.

Exit: prewarm only increases measured net savings in economic mode.

### Phase 8 — Cold-recovery and compaction integration

- Rebuild only expired provider-native state.
- Reuse committed universal compaction checkpoints across models.
- Refresh repo snapshot only when its revision changed.

Exit: cache expiry does not cause unrelated discovery/retrieval work to repeat.

### Phase 9 — Product UX and diagnostics

- Add cache state beside model/reasoning choices: Warm / Likely warm / Cold.
- Show estimated switch rebuild cost for large contexts without blocking.
- Add lane-bank and switch-savings views to cache diagnostics.

Exit: user can understand the effect, but never has to manage it manually.

### Phase 10 — Competitive proof

- Run public Empryo benchmark fixtures with provider-billed accounting.
- Publish raw Kory results, failures, configuration, model versions, and keys/account separation methodology.
- Do not claim superiority until Kory clears the gates above.

## Files expected to change

Core:

- `backend/src/providers/prompt-cache.ts`
- `backend/src/providers/cache-fabric.ts`
- `backend/src/providers/cache-maintenance.ts`
- `backend/src/providers/types.ts`
- `backend/src/kory/prompts/index.ts`
- `backend/src/kory/manager.ts`

New:

- `backend/src/cache/universal-context.ts`
- `backend/src/cache/cache-switch-coordinator.ts`
- `backend/src/providers/cache-capabilities.ts`
- `backend/src/providers/cache-lane-bank.ts`
- `scripts/benchmark-cache-switch-matrix.ts`
- dedicated tests for reasoning/mode/model switch behavior.

UI/telemetry:

- provider/cache diagnostics route and store;
- model/reasoning picker cache-state presentation;
- Cost Center / cache diagnostics aggregate views.

## Do not do

- Do not semantic-cache arbitrary model answers and substitute them across models. That changes model behavior and can return stale or incorrect results.
- Do not share provider-native cache identities merely because two model names look related.
- Do not include user secrets, raw paths, account ids, or prompt text in provider routing keys.
- Do not preserve cache by weakening tool permissions or exposing a larger executable tool set to the model than policy permits.
- Do not prewarm every route or keep caches alive indefinitely.
- Do not call a model switch "cache-preserving" when only local context assembly was reused; distinguish native provider cache from universal context reuse.

## Final target

Kory should make the following sequence routine:

```text
Luna medium -> Luna high -> Luna max -> Terra high -> Luna medium
-> plan mode -> act mode -> reviewer model -> original coder model
```

The user should experience one unavoidable cold native write only when entering a provider/model cache domain that has never been warmed or has genuinely expired. Everything else should reuse either the same provider-native lane, a retained shadow lane, or the universal context graph.

That is the practical definition of universal model caching: **native cache reuse whenever physically possible, universal context reuse everywhere else, and automatic economic preparation for the next route.**
