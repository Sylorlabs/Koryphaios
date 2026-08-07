# ADR-006: Explicit stub marking for embeddings instead of fake vectors

## Status

Accepted

## Context

The `MemoryManagerService` had a `generateEmbedding()` method that returned random vectors (`Math.random() - 0.5`) as a "placeholder" for real embeddings. The `embedding-worker` generated deterministic but meaningless hash-based vectors.

Both were used for "semantic search" — cosine similarity was computed on these vectors, and the results were presented as relevance-ranked memory entries. The results were **completely meaningless** — random vectors have no semantic relationship to the content.

This was worse than having no embeddings at all, because:
- The UI showed "semantic search results" that looked real
- Developers assumed the feature was working
- Debugging memory retrieval issues was impossible (the "similarity" was noise)

## Decision

1. **Disable vector search**: `MemoryManagerService.semanticSearch()` returns empty results with a warning log when no embedding provider is configured.
2. **Skip vector storage**: `storeVector()` returns early when no embedding provider is configured.
3. **Mark the embedding worker as a stub**: Log a warning on every job, set `isStub: true` in the result.
4. **Add `embeddingProviderAvailable` flag**: Currently `false`. Set to `true` when a real embedding API is wired in.
5. **Document how to enable real embeddings**: In the embedding-worker comments, list the steps to replace the stub.

## Consequences

- **Positive**: No more fake semantic search results. The feature is visibly absent instead of silently broken.
- **Positive**: Developers can see from logs that embeddings are not configured.
- **Positive**: The infrastructure (vector storage, cosine similarity, embedding queue) remains for when a real provider is added.
- **Negative**: Users lose semantic memory search until a real provider is wired in. This is acceptable — the prior behavior was worse (fake results).

## Alternatives considered

- **Remove all embedding code**: Loses the infrastructure that would be needed for a real implementation.
- **Wire in OpenAI embeddings now**: Requires an API key and adds a network dependency. Should be a separate decision.
- **Keep the stub but log a warning**: Still produces fake results. The warning would be ignored in practice.
