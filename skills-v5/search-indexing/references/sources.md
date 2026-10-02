# Source map

## Adopted principles

- Text analysis is a pipeline that runs at index time and search time. Elastic documents that matching generally benefits from compatible analyzers at both boundaries.
- Relevance changes should be evaluated against typical judged queries rather than a few anecdotes. Elasticsearch exposes rank evaluation specifically for this purpose.
- Reindex is a data migration into a separately configured destination. Elasticsearch does not copy destination settings or mappings automatically, so cutover planning must include explicit destination configuration.

## Conditional recipes

- Elasticsearch is used as a precise primary reference for transferable search concepts. The skill does not require Elasticsearch, OpenSearch, Lucene, a particular analyzer, or a specific ranking metric.
- Different search analyzers, custom analyzers, synonyms, fuzziness, hybrid retrieval, and zero-downtime alias cutovers are conditional architecture choices.

## Verification scope

Documentation establishes analyzer, rank-evaluation, and reindex mechanics. It does not prove relevance for the product corpus, authorization correctness, freshness targets, index throughput, query latency, or cutover safety. Those require judged data and target-system evidence.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Elastic text analysis concepts**: https://www.elastic.co/docs/manage-data/data-store/text-analysis
  - Scope: Elastic documentation checked 2026-09-06.
  - Use: analyzer pipeline and index/search analysis concepts.
- **Elastic index and search analysis**: https://www.elastic.co/docs/manage-data/data-store/text-analysis/index-search-analysis
  - Scope: Elastic documentation checked 2026-09-06.
  - Use: index-time versus search-time analyzer compatibility.
- **Elasticsearch rank evaluation API**: https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-rank-eval
  - Scope: Elasticsearch API documentation checked 2026-09-06.
  - Use: judged-query ranking evaluation mechanics.
- **Elasticsearch reindex API**: https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-reindex
  - Scope: Elasticsearch API documentation checked 2026-09-06.
  - Use: destination configuration and reindex migration behavior.
