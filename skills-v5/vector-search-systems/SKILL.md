---
name: vector-search-systems
description: Engineer vector indexes, approximate search, filtering, freshness, and recall versus latency. Use when vector database or ANN mechanics determine behavior; use embedding-systems for representation identity and rag-retrieval-systems for corpus, reranking, and grounded answers.
---

# Vector Search Systems

Own the storage and search mechanics around an already-defined vector representation. A faster ANN query is not correct merely because it returns plausible neighbors: compare it to an exact baseline, enforce metadata/tenant constraints, and measure recall together with latency and freshness.

## Workflow

1. **Pin the stored-vector contract without redefining it.** Record vector type/dimension, representation version, normalization expectation and the distance/operator used by the store. `embedding-systems` decides whether that representation is semantically appropriate; this skill ensures the index/query uses it compatibly.
2. **Define query correctness.** State top-k, tie/ordering semantics, metadata/tenant filters, score/distance output, duplicate-ID policy and any distance threshold. Preserve a fixed judged/exact-query set for regression.
3. **Establish an exact baseline.** For representative samples or full feasible partitions, run exact nearest-neighbor search and compare ANN results by Recall@K, overlap or task-appropriate candidate recall. Do not benchmark ANN latency without quantifying lost recall.
4. **Choose the index family by workload.** Evaluate exact scan, HNSW, IVF/IVFFlat or platform-specific alternatives against corpus size, update rate, filter selectivity, memory, build time and recall/latency needs. Do not copy tuning heuristics across engines without verifying current docs and workload behavior.
5. **Tune query-time search breadth explicitly.** Parameters such as HNSW `ef_search` or IVF probes trade work for recall. Sweep them on the same query set and report p50/p95/p99 latency plus recall rather than a single best-case query.
6. **Treat filtering as part of ANN correctness.** Determine whether metadata predicates are applied before, during or after ANN candidate generation. Highly selective filters can collapse returned top-k or recall; test filter selectivity distributions, iterative/oversampling behavior and tenant-specific cases.
7. **Enforce tenant/authorization isolation independently of vector similarity.** Candidate retrieval must never rely on semantic distance to enforce access. Verify filter/partition/routing behavior with cross-tenant canaries and zero-result cases.
8. **Measure index build and steady-state cost.** Record build duration, peak/resident memory, index/storage size, CPU/IO and any maintenance impact. A configuration that meets query latency but cannot be built, replicated or held in memory is not production-qualified.
9. **Validate updates, upserts and deletes.** Define ID uniqueness/idempotency, visibility lag, tombstone/delete semantics, compaction/vacuum/rebuild needs and consistency expectations. Test that deleted vectors stop appearing within the stated freshness SLO and that concurrent updates do not create duplicates.
10. **Quantize with measured reranking/recall tradeoffs.** Half precision, scalar/product/binary quantization or compressed indexes can reduce memory and latency, but compare against the uncompressed exact/reference results. If the engine expects reranking, include it in the measured query path.
11. **Plan capacity and partitioning.** Model corpus growth, vector bytes, metadata/index overhead, replicas, hot working set and query concurrency. For sharded systems, verify routing/fan-out and global top-k merge semantics; for Postgres-style systems, consider partitioning/filter indexes when they improve selective queries.
12. **Migrate indexes reversibly.** Build the new index/store from a versioned vector snapshot or dual-write stream, shadow the same queries, compare recall/filter correctness/latency/freshness, verify update catch-up and switch readers only after coverage. Keep the previous index until rollback is no longer required.
13. **Monitor the search layer.** Track query latency/errors, returned-k shortfalls, recall canaries versus exact/reference search, filter selectivity, index freshness/build state, memory/storage and delete lag. A healthy service metric alone does not prove neighbor quality.

## Boundaries

- `embedding-systems` owns provider/model/task/preprocessing/dimension/normalization representation identity and re-embedding migration. This skill owns how compatible vectors are stored, indexed, filtered and searched.
- `rag-retrieval-systems` owns corpus lifecycle, ACL-aware retrieval policy, hybrid/reranking, grounding and citation lineage. This skill owns the vector-search execution layer used by that pipeline.
- `recommendation-ranking` owns recommendation candidate/ranking objectives, exposure bias and online policy. This skill owns ANN mechanics when a recommender uses a vector index.
- `search-indexing` owns lexical inverted-index/search semantics. Hybrid systems may compose both; this skill does not own lexical analysis or fusion quality.
- Generic database schema design, embeddings-only changes or downstream answer quality do not activate this skill unless vector index/search mechanics are changing or being evaluated.

Use [the maintained source map](references/sources.md) before encoding engine-specific index, filter, maintenance or tuning behavior.
