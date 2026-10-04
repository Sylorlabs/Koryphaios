# Dedicated capability providers

For the user-facing input, output, playback, and settings workflows, see [Images, video, audio, and speech](media.md).

Most providers in the catalog answer chat completions. Eight do not, and this document records how Koryphaios reaches them anyway.

| Provider    | Capabilities        | Surface                     | Notes                                                                                                 |
| ----------- | ------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lmnt`      | audio (TTS)         | `/api/voice`                | `X-API-Key` plus a required `lmnt-version` pin. No transcription endpoint, so never `stt`.            |
| `voyageai`  | embedding, rerank   | semantic memory retrieval   | Embeddings need `KORY_EMBEDDINGS_PROVIDER=voyageai`; a connected key alone deliberately does nothing. |
| `mem0`      | memory              | `/api/memory/external/*`    | v3 search requires entity ids nested inside `filters`.                                                |
| `letta`     | memory              | `/api/memory/external/*`    | Archival passages only; memory blocks are agent-managed and must not receive user facts.              |
| `prodia`    | image, video        | `/api/images`, `/api/video` | v2 unified job endpoint returns the asset directly, so there is no poll.                              |
| `luma`      | video, image        | `/api/video`, `/api/images` | Asynchronous generation jobs; assets in `assets` or `output[0]`.                                      |
| `klingai`   | video, image        | `/api/video`, `/api/images` | Host is `api-singapore.klingai.com`, not the older `api.klingai.com`.                                 |
| `replicate` | image, video, audio | `/api/images`, `/api/video` | `Prefer: wait=60`; video and audio outlast it and fall back to polling.                               |

## Why these stay out of the chat path

`UNSUPPORTED_CHAT_PROVIDER_NAMES` in [registry.ts](../backend/src/providers/registry.ts) still contains all eight. That is deliberate and must not regress: none of them speaks chat completions, so `createProvider()` returns `null` and the chat model picker never offers them. Forcing one into the generic OpenAI-compatible adapter would let a user pick a model that cannot answer a message.

What changed is that they are no longer dead ends. They moved into `DEDICATED_CAPABILITY_PROVIDER_NAMES`, so:

- a credential verifies against the provider's own endpoint instead of a `/models` probe that would always fail;
- `connectionState` resolves to `verified` and `configurationBlocked` stays false;
- the settings card shows capability badges and states plainly that the provider has no chat models.

`shared/src/provider-support.ts` records each one at tier `preview` with evidence `capability-adapter-contract`. Nothing is `certified`; the evidence describes the contract the adapter implements, never account entitlement, quota, or model access.

## The adapter framework

[capabilities/](../backend/src/providers/capabilities/) holds the contracts. An adapter implements only what its upstream API supports, so an embedding-only provider is not forced to declare a `generate` method:

- `verify(config)` — a cheap authenticated read proving the credential works.
- `listModels(config, capability)` — returns `[]` when the provider publishes no enumeration endpoint. It never invents a catalog, consistent with `backend/src/providers/models/index.ts`.
- `generate` / `synthesize` / `embed` / `rerank` — invocation, present only for advertised capabilities.
- `listVoices(config)` — a live voice catalog where one exists.
- `memory` — add, search, delete, and scope enumeration for Mem0 and Letta.

[capability-adapters.test.ts](../backend/src/providers/capabilities/__tests__/capability-adapters.test.ts) asserts every adapter's capability set matches what it actually implements, so a provider cannot advertise audio while exposing no `synthesize`.

### Configuration is passed per call

`ResolvedCapabilityConfig` travels in the request rather than in adapter state. Two concurrent generations from different configured providers must not be able to observe each other's endpoint or credential.

### Async generation

Luma, Kling, and Replicate are submit-then-poll. [poll.ts](../backend/src/providers/capabilities/poll.ts) owns that discipline once: bounded attempts, a wall-clock deadline, immediate abort propagation, and a translated deadline message that says the job may still finish upstream instead of implying failure. Prodia is the exception — its v2 endpoint returns the asset in the response body when an `Accept` header is set.

Finished media is downloaded immediately rather than linked. Kling clears generated assets after 30 days, so a stored URL would rot.

### Provider details that are easy to get wrong

- **Kling** answers with HTTP 200 and a non-zero `code` on some failures; the envelope must be inspected, not just the status. Task status is `succeed`, not `succeeded`.
- **Mem0 v3 search** rejects entity ids at the top level with a 400; they belong inside `filters`.
- **Voyage** returns embeddings with an explicit `index` and does not promise request order, so results are re-sorted into the caller's input order.
- **LMNT** rejects unversioned calls, so `lmnt-version` is sent on every request.
- **Replicate** output is polymorphic: a bare URL, an array of frame URLs, or objects. `outputUrls` normalizes all three.

## Image-to-video needs a hosted frame

Luma and Kling take a publicly reachable first-frame URL, not an upload. A file selected on the user's disk cannot be sent, so those adapters fail with an explicit message naming the alternative rather than silently ignoring the source image. Replicate and Prodia accept real uploads.

## Spend and durability

Video requests go through the same spend-cap gate as images before submission, and every completed job is written to the usage ledger under the new `video` kind. Clips are persisted to a dedicated gallery (`video_history`, migration `0049`) with a 30-day retention window, shorter than images because a few clips can fill the data directory.

Migration `0049` also rebuilds `api_usage` to widen the `kind` and `unit_measure` CHECK constraints to include `video` and `embedding`. SQLite cannot alter a CHECK in place, and the table is copied across unchanged; session and run attribution lives in the `detail` JSON envelope, so there are no extra columns to carry. `ensureSchema` in [api-usage-ledger.ts](../backend/src/billing/api-usage-ledger.ts) applies the same widening at runtime for databases that predate the migration.

## Opt-in boundaries

Three of these providers move user content to a third-party paid service, so a connected credential is deliberately not sufficient:

- **Voyage embeddings** require `KORY_EMBEDDINGS_PROVIDER=voyageai`. Semantic retrieval forwards memory documents, note content, and user queries, so the choice is never inferred from a saved key. The adapter expects 1024-wide vectors and rejects any other width rather than caching it, because mixing widths would make cosine similarity meaningless.
- **Voyage reranking** needs only a connected provider: it runs after retrieval has already narrowed candidates, and it only sends those candidates.
- **External memory** (Mem0, Letta) requires `externalMemoryEnabled` per project in Settings > Memory, and `normalizeMemorySettings` rejects any provider name without a memory adapter, so a hand-edited settings file cannot route memory writes to a chat provider.

## Agent tools

`generate_video`, `remember`, `recall`, and `forget` are registered in the runtime tool registry and in the MCP bridge catalog (`kory__`-prefixed). `generate_video` and `forget` are manager-only: video generation is billed per clip, and forgetting is irreversible. `remember` and `recall` are available to every role.

All four fail closed with an actionable message when the backing provider is off or unconnected. External memory is opt-in per project in Settings > Memory, and `normalizeMemorySettings` rejects any provider name without a memory adapter, so a hand-edited settings file cannot route memory writes to a chat provider.

## Verification

```bash
bun run --filter backend typecheck
bun run --filter backend test
bun run --filter frontend check
bun run --filter frontend test
```

No live provider call is made by the test suite. `capability-adapters.test.ts` and [video.test.ts](../backend/src/routes/v1/video.test.ts) exercise the contracts against stubbed transports; upstream endpoint changes are only caught by a real request.
