---
name: rag-retrieval-systems
description: Engineer grounded retrieval with governed corpora, access filtering, ranking, citations, and abstention. Use when answer quality depends on ingested or retrieved evidence; use vector-search-systems for index mechanics and prompt-context-engineering for packing already selected context.
---

# RAG Retrieval Systems

Treat retrieval as an evidence pipeline with its own correctness contract. A fluent generated answer does not repair a missed, unauthorized, stale, or wrongly ranked source.

## Workflow

1. **Define the corpus contract.** Identify source systems, authority, tenant/visibility rules, canonical document IDs, revisions, timestamps, deletion/tombstone behavior, supported media/parsers, and the freshness target. Keep source identity stable enough to trace every retrieved chunk back to an exact document revision.
2. **Make ingestion reproducible.** Record parser/chunker/embedding/index versions and ingestion status. Preserve structural boundaries and useful metadata, deduplicate revisions, give chunks stable identities, and surface parse/index failures. Do not tune chunk size or overlap from intuition alone; test it against representative information needs.
3. **Enforce authorization before evidence reaches the model.** Carry ACL/tenant metadata through ingestion and apply the user's current authorization at retrieval time or an equivalent protected boundary. Missing ACL metadata must have an explicit safe policy. Test cross-tenant, revoked-access and metadata-missing cases; post-generation redaction is not an adequate retrieval security model.
4. **Design retrieval stages around the query mix.** Establish lexical, dense/sparse semantic, metadata-filter, query-rewrite and hybrid candidate paths as justified by actual queries. Keep candidate generation, fusion and reranking observable separately. Exact identifiers, names and error codes often need lexical support even when semantic retrieval is strong.
5. **Tune ranking against judgments.** Choose candidate counts, fusion weights/windows, score thresholds and reranker settings from a versioned query set with relevance judgments. Track metrics that match the product need, commonly Recall@k for evidence coverage plus Precision@k, MRR or NDCG for rank quality. Inspect query-level regressions rather than only aggregate means.
6. **Preserve grounding lineage.** Pass source/chunk/revision/locator metadata with selected evidence. Citations must map to evidence actually retrieved and used, not merely to a document that exists in the corpus. Keep retrieval provenance available for debugging even if the user-facing citation format is simplified.
7. **Handle missing, stale and deleted evidence explicitly.** Define index-lag expectations, update/reindex behavior, tombstones and cache invalidation. If authoritative evidence is absent, conflicting or outside the freshness target, prefer a bounded abstention or uncertainty path over filling the gap from model memory.
8. **Separate retrieval from generation failures.** Persist the retrieved candidate/reranked sets for benchmark queries so a bad answer can be classified as retrieval miss, authorization/filtering fault, ranking/context-selection fault, citation fault, or generation fault. Evaluate answer groundedness separately from search relevance.
9. **Gate changes on corpus-versioned evidence.** Re-run the same query/judgment suite when parser, chunker, embedding, index, query rewrite, filter, fusion, reranker or corpus revision changes. Include ACL leaks, deletions/freshness, no-answer queries, exact-keyword queries and semantic paraphrases, plus latency/cost at the deployed top-k/candidate settings.

## Boundaries

- `vector-search-systems` owns vector database/index selection, ANN algorithms, index construction, filtering execution semantics, capacity and low-level search performance. This skill owns the end-to-end evidence retrieval policy used for grounded generation.
- `embedding-systems` owns embedding model selection, dimensionality, normalization, batching, drift and representation-quality evaluation. This skill consumes those representations as one retrieval signal.
- `prompt-context-engineering` owns how already-selected passages are delimited, prioritized and trusted inside the prompt/context window. This skill owns which passages are selected and why.
- `llm-application-engineering` owns the surrounding model/API schema, authorization of actions, retries, fallback and product-level inference contract.
- `llm-evaluation` owns general benchmark/judge methodology; this skill owns retrieval-specific qrels, ranking metrics, citation lineage, ACL/freshness cases and evidence-pipeline regressions.

Use [the maintained source map](references/sources.md) for current provider/search-engine behavior. Refresh product-specific chunking, ranking, consistency and filtering semantics before depending on them.
