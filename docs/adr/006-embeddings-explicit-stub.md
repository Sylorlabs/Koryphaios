# ADR-006: Opt-in authenticated embeddings and active semantic retrieval

## Status

Accepted. Supersedes the explicit-unavailable implementation; fake vectors remain prohibited.

## Decision

The embedding worker and active Notes search share an authenticated OpenAI-compatible
embedding client. `search_notes`, query-based `recall_notes`, and the existing Notes
search route reach `searchNotes()`; when explicitly enabled it ranks scoped current
note chunks with validated real embeddings. `searchMemory()` in unified memory
also searches current enabled session/project/universal documents. Existing
synchronous prompt assembly and mandatory rules are unchanged.

No embedding requests occur by default. An ordinary chat provider credential alone
does not enable embeddings. Operators must explicitly configure all of:

```dotenv
KORY_EMBEDDINGS_ENABLED=1
KORY_EMBEDDING_ENDPOINT=https://your-provider.example/v1/embeddings
KORY_EMBEDDING_MODEL=your-embedding-model
KORY_EMBEDDING_DIMENSIONS=1536
# Choose a dedicated credential OR explicitly reference an existing environment key:
KORY_EMBEDDING_API_KEY_ENV=OPENAI_API_KEY
# KORY_EMBEDDING_API_KEY=<secret supplied by your environment>
KORY_EMBEDDING_TIMEOUT_MS=15000
```

The endpoint is the complete embeddings URL. No provider endpoint, credential, or
model is inferred. Dimensions are the expected model output size, not a request to
resize vectors. The request uses `model`, `input`, and `encoding_format: float` with
Bearer authentication. A dedicated key overrides a named environment key. Keys
are not persisted by this module. HTTPS is required except for explicit loopback
HTTP endpoints. URL credentials, query strings, fragments, and redirects are
rejected; private text is never redirected to another endpoint.

Enabling this configuration authorizes transmission of queried scoped memory/Notes
text and queries to that endpoint. Notes require an explicit project, enabled Notes,
and automatically allowed search/read permissions. Project/trash visibility is
applied before building provider inputs. Blocked and approval-required permissions
retain local FTS behavior. Final Notes results are rechecked for visibility and
concurrent edits/deletions after the asynchronous request.

## Validation, fallback, and operational bounds

- Vectors must contain finite numbers, have the configured length (1–16,384), and
  have nonzero norm. Missing, duplicate, out-of-range, or malformed result indexes
  fail the whole batch. Cosine similarity normalizes vectors and avoids overflow.
- Response bodies are streamed with an **8 MiB byte limit before JSON parsing**,
  including responses without Content-Length. Oversized bodies are canceled.
- Individual requests default to 15 seconds and accept an AbortSignal. Retrieval
  has **one shared deadline of at most 15 seconds** for all document batches plus
  the query; a lower configured/requested timeout shortens it. Cancellation reaches
  transport and body reads. The deadline does not include local project sync/DB
  work. The Notes agent tool and HTTP search route forward their cancellation signals and discard canceled results. Callers without a signal still have the deadline.
- Retrieval examines at most 256 chunks of 2,000 characters, batches up to 64
  chunks, and returns up to 51 hits (the extra hit supports the HTTP pagination sentinel). Notes considers the first 256 visible notes
  ordered by pinned/recent/id. This is bounded retrieval, not exhaustive vault
  indexing; large documents/vaults can have unsearched content.
- Cache entries contain only hashes and validated vectors, in process memory.
  Keys cover project/session scope, content, endpoint, model, dimensions, and a
  cryptographic digest of the credential. Edits, credential rotation, model changes,
  and scope changes miss the cache; deleted documents are never candidates. The
  cache is capped at 2,048 entries and 1,048,576 numeric components. No persistent
  vector database, background indexing, or additional dependency is introduced.
- Disabled/invalid configuration and transport, timeout, cancellation, or validation
  failure preserve local retrieval. Notes retains its established FTS fallback;
  `searchMemory()` reports lexical mode and an unavailable/disabled reason.
  No fallback creates a vector or claims semantic relevance.
- The worker returns `success: true` only with validated embeddings. Disabled
  jobs return `success: false, isStub: true`; configured failures return a sanitized
  error and `success: false, isStub: false`. These are bounded completed results,
  not automatic provider retries. Readiness means configuration is valid, not that
  remote authentication, billing, or availability has been verified.
- Provider bodies, raw transport errors, input text, and keys are never logged by
  the embedding client/retrieval path. Cache identities expose only a digest.

## Evidence and limitations

Tests use mock transports and the isolated backend environment/database preload.
They cover authentication, opt-out, semantic ordering, project/trash/permission
filtering, FTS fallback, invalid vectors, timeout/abort, total deadline, response
byte limits, edits/deletions, and model/scope/credential cache invalidation.
No paid or live provider calls were made. No claim is made about remote account
availability or production semantic quality without explicit live verification.
