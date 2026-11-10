# Source map

`rag-retrieval-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Retrieval providers and search engines change chunking, filtering, ranker, consistency and result-inspection behavior independently; refresh the exact deployed product/version before depending on those mechanics.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader llm-application-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI Retrieval API**: https://developers.openai.com/api/docs/guides/retrieval
  - Scope: rolling OpenAI Retrieval API guidance inspected 2026-10-25.
  - Use: vector-store ingestion, chunking, attributes/filters, semantic search, ranking options, hybrid semantic/text weighting and documented eventual consistency after file removal.
  - Verified: 2026-11-08; refresh after 14 days.
- **OpenAI file search**: https://developers.openai.com/api/docs/guides/tools-file-search
  - Scope: rolling OpenAI Responses API file-search guidance inspected 2026-10-25.
  - Use: hosted retrieval execution, result inclusion/inspection, metadata filtering and the quality/latency tradeoff from maximum result counts.
  - Verified: 2026-11-08; refresh after 14 days.
- **Elastic hybrid search**: https://www.elastic.co/docs/solutions/search/hybrid-search
  - Scope: rolling Elastic hybrid-search documentation as available 2026-10-04.
  - Use: current lexical-plus-vector retrieval and reciprocal-rank-fusion guidance; treat implementation details as Elastic-specific.
  - Verified: 2026-11-03; refresh after 30 days.
- **Elasticsearch ranking evaluation**: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-rank-eval
  - Scope: rolling Elasticsearch rank-evaluation API documentation as available 2026-10-04.
  - Use: relevance-judgment query sets and standard information-retrieval metrics including Precision@k, Recall@k, MRR and DCG/NDCG.
  - Verified: 2026-11-03; refresh after 30 days.
- **Elastic connector document-level security**: https://www.elastic.co/docs/reference/search-connectors/es-dls-overview
  - Scope: rolling Elastic connector DLS documentation as available 2026-10-04.
  - Use: a concrete production model for synchronizing per-document access-control data and filtering results by current identities. Do not generalize its field names or defaults to other backends.
  - Verified: 2026-11-03; refresh after 30 days.
- **Google Cloud search-quality evaluation**: https://docs.cloud.google.com/gemini/enterprise/docs/evaluate-search-quality
  - Scope: Gemini Enterprise search-quality documentation as available 2026-10-04; page reported last update 2026-07-30.
  - Use: sample-query target sets and document/page Recall, Precision and NDCG for comparing retrieval configurations.
  - Verified: 2026-11-03; refresh after 30 days.

## Interpretation rules

- Resolve the actual retrieval backend, index/corpus revision and parser/chunker/embedding/ranker versions before applying product-specific defaults.
- A provider metadata filter is an authorization boundary only when the application has correctly derived current user/tenant permissions into that filter and tested missing/revoked cases. Do not substitute post-generation redaction for retrieval authorization.
- Choose retrieval metrics from the information need: recall protects evidence coverage, while precision/MRR/NDCG capture different ranking concerns. Keep the judged query set versioned and inspect per-query failures.
- Citation correctness requires lineage to evidence actually retrieved and selected for the answer; corpus membership alone is not proof that a citation grounded the response.
- Model eventual-consistency windows explicitly. For example, current OpenAI retrieval documentation warns that removed vector-store files may remain in search results briefly; validate the deployed system's deletion/freshness behavior rather than promising instantaneous removal.
- Preserve retrieval and generation evidence separately so a fluent answer cannot hide an unauthorized, stale, missed or badly ranked source.
