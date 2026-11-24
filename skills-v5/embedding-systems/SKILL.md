---
name: embedding-systems
description: Engineer how text or multimodal inputs become versioned, comparable vectors. Use when embedding identity, preprocessing, similarity, or representation quality changes; use vector-search-systems for index mechanics and rag-retrieval-systems for grounded retrieval workflows.
---

# Embedding Systems

An embedding is meaningful only inside a specific representation contract. Treat provider, model/version, task instruction/type, preprocessing, dimensionality and normalization as part of the vector's schema.

When the task supplies a bounded input/output contract, implement that contract exactly before applying broader migration practice. Preserve the requested field locations and return shape. Do not invent extra gates, alternate wrappers, plural collections, or migration prerequisites that the task did not request.

## Workflow

1. **Define the semantic unit and downstream decision.** State what one vector represents (query, document/chunk, product, image, audio segment or another unit) and whether the downstream use is asymmetric retrieval, symmetric similarity, classification, clustering, recommendation features or anomaly detection. Evaluate the representation on that task, not only on generic benchmark rankings.
2. **Pin the representation identity.** Record provider/runtime, exact model/version, task type or task instruction, modality, tokenizer/input limits, output dimension, normalization convention and preprocessing revision. Do not assume two versions of a model family occupy the same vector space or implement task conditioning the same way.
3. **Preflight input transformation.** Define canonical whitespace/Unicode/language handling, titles or task prefixes, image/audio preprocessing where relevant, empty/degenerate input behavior and token/sequence limits. Make truncation explicit and observable; provider auto-truncation must not silently remove the discriminating part of an input.
   Record the preflight result per batch: input ID/order, measured or unavailable token count, truncation decision and reason, empty input rejection, provider response index, invalid/zero vector result, retry count and usage/cost. A syntactically returned vector is not proof that the input was represented completely.
4. **Choose dimensionality empirically.** Compare supported dimensions on the same labeled downstream cases and follow the selected provider's normalization rules. Do not copy one model's shortening semantics to another.
5. **Respect asymmetric versus symmetric encoding.** Some models distinguish query and document roles or task instructions. Encode each side with the documented role and test mismatched role failure. Similarity tasks may require a different representation mode than retrieval even when the API accepts the same text.
6. **Make batching and retries deterministic.** Respect provider limits, preserve input-to-output IDs, reject missing vectors and bound retries/concurrency. Cache keys include model/version, task, dimension, normalization and preprocessing, not text alone.
7. **Calibrate similarity and thresholds per representation.** Cosine, dot product and Euclidean rankings can coincide only under specific normalization conditions. Measure the chosen metric on labeled positive/negative or relevance pairs and select thresholds on development data. Never carry an absolute similarity threshold across incompatible models/dimensions without recalibration.
8. **Evaluate downstream quality and slices.** Use task metrics such as judged retrieval quality, classification metrics, clustering stability or pairwise similarity error. Include short/long, multilingual, exact identifier, low information and degenerate inputs when material.
9. **Plan representation migrations as schema migrations.** Version stored vectors. Re-embed all items that must be compared in one space, or isolate old/new spaces behind explicit version aware routing during transition. Do not write new version query vectors against old version document vectors and interpret the resulting scores as valid.
10. **Run migrations in parallel before cutover.** Generate old/new embeddings for a controlled overlap, compare downstream quality, latency, cost and storage, backfill idempotently, verify coverage, then switch readers/writers with a rollback path. Keep old representations until the new index/store is proven complete or recovery no longer requires them.
11. **Monitor drift and reproducibility.** Preserve canary inputs and downstream outcomes so provider aliases, preprocessing changes or model replacements are detectable. Track dimension, invalid-vector rates, latency and errors, while using downstream behavior as the primary quality signal. Compare model revisions and threshold calibration on labeled slices; migration status booleans alone do not establish coverage, rollback readiness or drift safety.

Persist a reproducible evidence record for the requested boundary: semantic unit and downstream decision, old/new representation identities, labeled slice results, invalid-input/vector checks, and measured latency/usage/storage where available. For a real cutover, link coverage counts and catchup watermark to a corpus revision, demonstrate reader/writer switching and rollback, and retain canary results. A supplied gate function may consume status booleans exactly as its caller specifies; report that limited verification separately from operational proof. Preserve failed attempts and label simulated or unavailable provider measurements. Use the [evidence and index compatibility contract](references/evidence-contract.md) to distinguish documented provider facts, observed behavior, empirical results and unavailable evidence, and to define the handoff to `vector-search-systems`.

## Boundaries

Treat cutover as a conjunction of gates. Any representation identity change requires a distinct namespace, even when dimensions match. Required quality slices must pass, backfill and catchup must be complete, and coexistence or dual read plus rollback must be demonstrated. A headline gain cannot waive duplicate, rare identifier or missing modality failures. Multimodal compatibility is pair specific: claim only judged query/item modality pairs, and prove schema coexistence before mixed old and new representations share a serving path. Unjudged pairs fail closed.

- `vector-search-systems` owns ANN/index algorithms, vector store schema/capacity, search filtering execution and low level retrieval latency. This skill owns the vectors being indexed and their compatibility.
- `rag-retrieval-systems` owns corpus lifecycle, access controlled candidate retrieval, reranking, grounding and citation lineage. This skill owns one representation signal used by that pipeline.
- `recommendation-ranking` owns recommendation candidate/ranking objectives, feedback bias and product policy even when embeddings are features.
- `fine-tuning-training` owns changing model/adapter weights. This skill may compare an embedding model revision but does not own its training workflow.
- `computer-vision` and `speech-audio-ai` own the perception and preprocessing semantics of their modality; compose them when using image/audio/multimodal embedding models.
- `ml-evaluation` owns general predictive evaluation methodology; this skill defines representation, compatibility and migration evidence for embeddings.

Use [the maintained source map](references/sources.md) before encoding dimensions, task modes, limits or normalization behavior for a specific provider.

## Index handoff boundary

Before an index write or query, emit a representation manifest and assert the
same representation ID, dimension, metric and normalization at both seams.
Reject mismatches rather than padding, slicing, silently re-normalizing or
mixing namespaces. `embedding-systems` owns the manifest, vector compatibility
and re-embedding/backfill evidence. `vector-search-systems` owns ANN algorithm,
graph parameters, sharding, capacity and low level search execution. If both
change, report both contracts and identify which specialist supplied each
measurement.
