# Source map

`embedding-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Embedding provider behavior is version-sensitive: model aliases, task-conditioning interfaces, input limits, shortening semantics and normalization rules can change independently. Refresh the relevant provider/model documentation before encoding exact limits or planning a representation migration.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI embeddings guide**: https://developers.openai.com/api/docs/guides/embeddings
  - Scope: rolling OpenAI embeddings documentation as available 2026-09-19.
  - Use: current `text-embedding-3-small` / `text-embedding-3-large` behavior, default dimensions, supported dimension shortening and provider-recommended similarity usage.
  - Verified: 2026-09-19; refresh after 14 days.
- **OpenAI embeddings API reference**: https://developers.openai.com/api/reference/resources/embeddings/methods/create
  - Scope: rolling OpenAI embeddings API reference as available 2026-09-19.
  - Use: accepted input forms, model and `dimensions` fields, request/response ordering and current input/batching limits.
  - Verified: 2026-09-19; refresh after 14 days.
- **OpenAI embeddings FAQ**: https://help.openai.com/en/articles/6824809-embeddings-frequently-asked-questions
  - Scope: rolling OpenAI help guidance as available 2026-09-05.
  - Use: current statement that OpenAI v3 embeddings are length-normalized, which affects cosine/dot-product interpretation. Reconfirm for any future model family before inheriting the assumption.
  - Verified: 2026-09-05; refresh after 30 days.
- **Gemini API embeddings**: https://ai.google.dev/gemini-api/docs/embeddings
  - Scope: rolling Gemini embeddings documentation as available 2026-09-19.
  - Use: current `gemini-embedding-2` multimodal shared-space behavior, supported output dimensions, model-specific normalization behavior and its task-instruction contract. Treat these semantics as model-version-specific rather than a drop-in continuation of `gemini-embedding-001`.
  - Verified: 2026-09-19; refresh after 14 days.
- **Vertex AI embedding task types**: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/task-types
  - Scope: rolling Vertex AI embedding task-type documentation as available 2026-09-05.
  - Use: asymmetric `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` roles and other supported task modes for models/surfaces that expose `task_type`; verify the selected model still uses this interface.
  - Verified: 2026-09-05; refresh after 30 days.
- **Vertex AI text embeddings API/model reference**: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/text-embeddings-api
  - Scope: rolling Vertex AI text-embedding reference as available 2026-09-05.
  - Use: exact model IDs, output dimensionality, sequence/input limits, auto-truncation and task-type semantics for the selected Vertex model. Prefer explicit stable model IDs over unqualified aliases when reproducibility matters.
  - Verified: 2026-09-05; refresh after 30 days.

## Interpretation rules

- A vector's schema is the full representation identity: provider/runtime, exact model/version, task type or task instruction, modality preprocessing/truncation revision, output dimension and normalization/similarity contract. Equal vector length does not imply compatibility.
- Do not mix vectors from incompatible representation identities in one similarity comparison. Treat model/version changes as data/schema migrations requiring version tags, re-embedding or isolated old/new spaces.
- Apply provider/model-specific task conditioning. Query/document task roles used by one model or surface are not evidence that a newer model exposes the same parameter or semantics.
- Dimension shortening is not semantically free. Compare supported dimensions on the same downstream labels and follow the selected provider/model's documented normalization behavior after shortening.
- Make truncation observable. Silent provider auto-truncation can remove the discriminating tail of an input while still returning a syntactically valid vector.
- Similarity thresholds are representation-specific calibration artifacts. Recalibrate after model, task, preprocessing, dimension or normalization changes instead of carrying an absolute threshold forward.
- Evaluate embeddings on the actual downstream decision and relevant slices. Use retrieval, similarity, classification, clustering or cross-modal labels as appropriate; raw vector-coordinate stability is not a general quality metric.
- Cache and persisted-vector keys must include every representation-affecting field. During migration, verify backfill coverage before reader/writer cutover and preserve a tested rollback while the prior representation remains recoverable.
