# ADR-006: Explicit stub marking for embeddings instead of fake vectors

## Status

Accepted

## Context

The now-retired `MemoryManagerService` had a `generateEmbedding()` method that returned random vectors (`Math.random() - 0.5`) as a "placeholder" for real embeddings. The `embedding-worker` generated deterministic but meaningless hash-based vectors.

Both were used for "semantic search" — cosine similarity was computed on these vectors, and the results were presented as relevance-ranked memory entries. The results were **completely meaningless** — random vectors have no semantic relationship to the content.

This was worse than having no embeddings at all, because:

- The UI showed "semantic search results" that looked real
- Developers assumed the feature was working
- Debugging memory retrieval issues was impossible (the "similarity" was noise)

## Decision

1. **Disable semantic-vector claims**: the legacy `MemoryManagerService` was removed; the remaining embedding worker stays explicitly unavailable until an authenticated embedding runtime is wired.
2. **Return no vector**: `processEmbeddingJob()` returns `success: false`, `isStub: true`, and a bounded error. Queue completion records that unavailable result; it does not mean an embedding was produced.
3. **Report readiness honestly**: `isEmbeddingServiceReady()` always returns `false` while the stub is active. Redis or queue availability alone is not embedding readiness.
4. **Keep only explicit integration seams**: the queue, worker lifecycle, status, and pure cosine-similarity helper remain, but no vector-storage or semantic-search capability is claimed.
5. **Document the activation boundary**: a future change must wire an authenticated provider, return and validate real vectors, connect them to the active memory runtime, add provider-specific regression proof, and only then change readiness.

## Consequences

- **Positive**: No more fake semantic search results. The feature is visibly absent instead of silently broken.
- **Positive**: Developers can see from logs that embeddings are not configured.
- **Positive**: The queue lifecycle and cosine-similarity utility remain as explicit integration seams for a future real provider.
- **Negative**: Users lose semantic memory search until a real provider is wired in. This is acceptable — the prior behavior was worse (fake results).

## Alternatives considered

- **Remove all embedding code**: Loses the queue and worker integration seams that would be useful for a real implementation.
- **Wire in OpenAI embeddings now**: Requires an API key and adds a network dependency. Should be a separate decision.
- **Keep the stub but log a warning**: Still produces fake results. The warning would be ignored in practice.
