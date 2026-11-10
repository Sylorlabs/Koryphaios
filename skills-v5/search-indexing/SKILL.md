---
name: search-indexing
description: Engineer full-text and structured search around indexing, analyzers, ranking, freshness, faceting, and relevance evaluation. Use when the request specifically requires full text search, search index, elasticsearch, opensearch; prefer a narrower child only when its boundary is established.
---

# Search Indexing

## Responsibility

Define search intents, corpus fields, language, analyzers, synonyms, filters, facets, ranking signals, freshness, and update/delete semantics before tuning queries. Separate lexical retrieval quality from UI presentation and make index rebuild/versioning a deployable lifecycle.

Verification focus: Maintain judged query sets spanning head/tail, exact/fuzzy, multilingual, empty/noisy, cases filtered by authorization, and freshness-sensitive cases. Measure retrieval and ranking changes against that set plus index/update performance.

Failure boundaries: Do not tune from a handful of favorite queries, expose unauthorized documents through search, use wildcard scans as a default, or change analyzers without a reindex strategy.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.
- Required skills: verification, ml-evaluation.

## Decision rules

- Start from search intents and judged relevance examples, then define indexed fields, analyzers, filters, facets, ranking signals, freshness, and authorization constraints.
- Keep index-time and search-time analysis compatible unless a measured relevance need justifies a deliberate difference. Analyzer changes are schema changes because existing documents keep the old tokenization until reindexed.
- Separate retrieval correctness from ranking quality. First ensure eligible documents can be found and unauthorized documents cannot be returned, then tune ordering against judged queries.
- Treat synonyms, fuzziness, stemming, wildcard behavior, and query expansion as recall/precision tradeoffs that require evaluation rather than defaults.
- Make index versioning, reindex, cutover, rollback, and delete/update propagation part of the deployment lifecycle before changing mappings or analysis.

## Observable checks

- Maintain a judged query set that includes exact, ambiguous, typo, empty/noisy, multilingual where relevant, authorization-filtered, and freshness-sensitive cases.
- Use analyzer inspection on representative text to verify the tokens produced at index and query time before attributing relevance changes to ranking.
- Compare ranking metrics or judged outcomes before and after search changes using the same query set.
- Reindex into a separately configured destination and verify mappings, analyzers, document counts, freshness, and authorization behavior before cutover when the platform supports that workflow.
- Measure indexing latency, query latency, and update/delete visibility in the actual deployment when making performance or freshness claims.

## Completion evidence

- Search-intent and analyzer/mapping decision tied to representative corpus and judged-query evidence.
- Relevance evaluation plus authorization, freshness, and reindex/cutover checks that were actually run.
- Explicit unknowns for production corpus distribution, latency, and operational cutover behavior.

For bounded fixtures, treat supplied input field names and the required JSON result shape as part of the executable contract. Read the fields exactly as supplied, return only the required result fields, and do not invent aliases, precomputed match flags, or extra diagnostic fields. Consume the supplied warm-cache field exactly when present. Derive lexical matches from the provided query and document text unless the fixture explicitly supplies another matching contract. Apply authorization before cache reuse, candidate ranking, or pagination.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
