# Embedding evidence and index compatibility

Use this contract when a result will be reviewed for promotion readiness. It
keeps provider documentation, observed API behavior, and downstream experiment
results separate. A citation can establish what a provider documents; it cannot
establish that a representation wins on a corpus or that a migration is safe.

## Classify every material claim

| Claim class                                  | Minimum record                                                                                                                                                                                                             | What it supports                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Documented provider/model fact               | Source URL, exact provider surface, model/version or alias, relevant task/modality, claim, `verifiedAt`, and the source's freshness policy                                                                                 | API contract facts such as accepted task modes, documented dimensions, input limits, or documented normalization behavior  |
| Observed provider behavior                   | Request/response receipt with observation time, runtime, exact model identifier, task fields, fixture or input IDs, response ordering, dimensions, norm summary, truncation/error result, retries, and usage when returned | What this provider invocation did for the recorded inputs; it does not generalize to every model version or future request |
| Empirical downstream result                  | Corpus and label revision, split, sample count, representation identity, index identity, metric and threshold-selection rule, quality results, latency percentile, storage, and measured cost                              | Retrieval, similarity, classification, clustering, or migration decisions for the tested setup                             |
| Inferred, simulated, or unavailable evidence | The missing observation, inference or simulation method, reason it was used, and the decision it cannot justify                                                                                                            | A bounded assumption or a blocked gate; never a completed provider or quality claim                                        |

The sidecar source records and this source map carry documented provider/model
facts. They do not record empirical quality results. Empirical results belong in
run receipts or evaluator artifacts with their corpus, labels, configuration and
runtime identity. If a result is a local fake, synthetic fixture, inferred value
or unavailable measurement, label it in the artifact rather than promoting it to
a provider fact.

## Representation-to-index handoff

Before writing vectors to an index or vector store, emit a representation
manifest containing at least:

- a stable representation ID derived from provider/runtime, exact model/version,
  task type or instruction, modality, preprocessing/truncation revision,
  dimension and normalization;
- semantic unit and role (`query`, `document`, item, image, audio segment, or
  another explicitly named unit), plus the downstream decision and similarity
  metric;
- index/store name, collection or namespace, vector field, corpus revision and
  index representation ID;
- expected dimension and normalization at the write and query boundaries; and
- cache-key fields, batch ordering contract, backfill watermark and the
  rejection behavior for missing, zero, malformed or incompatible vectors.

The write path must assert that representation ID, dimension, metric and
normalization agree at both sides of the seam. Reject a mismatch; do not pad,
slice, silently re-normalize, or route a new query representation into an old
space. Equal dimensions are not evidence of compatibility. Query/document task
roles must be checked independently even when the API accepts both strings.

`embedding-systems` owns the vector contract, manifest, compatibility checks and
re-embedding evidence. `vector-search-systems` owns ANN algorithm, graph/index
parameters, sharding, capacity and low-level search execution. A task that
changes both should leave both ownership boundaries visible and report which
index measurements are supplied by that specialist.

## Promotion-readiness checks

Use the following sequence for a real representation change:

1. Establish the semantic unit, downstream decision, provider/model identity and
   index seam before selecting a dimension or threshold.
2. Verify documented provider facts against the maintained source map; record
   observed behavior separately with request receipts.
3. Exercise long, short, multilingual, empty, low-information and degenerate
   inputs. Preserve input IDs and response order, and record truncation,
   invalid-vector and bounded-retry outcomes.
4. Compare old and candidate representations on the same labeled development
   and evaluation slices. Calibrate thresholds on development data only, then
   report quality, latency, storage and measured usage/cost with the tested
   runtime and index identity.
5. For migration, version namespaces and caches, prove backfill coverage against
   a corpus revision and watermark, demonstrate reader/writer switching, and
   exercise an interruption or rollback while the old representation remains
   recoverable.
6. Mark any unrun provider probe, unavailable measurement, synthetic fixture or
   inferred conclusion explicitly. A status boolean or successful API response
   alone is not coverage, quality, or rollback evidence.
