# literature-research: required source hashes are not reproducible

Status: DEFECT PROPOSED, NOT APPLIED. The fixture, materializer and scorer files were
not modified. This document records the evidence and a patch for review.

## Symptom

`literature-research` cannot reach readiness on merit. Every full-task run fails the
same checks regardless of what the candidate writes:

- `openalex-routellm direct HTTPS provenance: fail`
- `openalex-routerbench direct HTTPS provenance: fail`
- the corresponding `quotations anchored to fetched bytes` rows

Observed full-task result over the current revision: 0 passing of 5 candidate runs,
with those checks failing in every one. Earlier revisions behaved the same (0 of 7).

## Cause, measured

Two required sources in the literature scenario are OpenAlex search endpoints:

```
https://api.openalex.org/works?search=RouteLLM&per-page=10
https://api.openalex.org/works?search=RouterBench&per-page=10
```

OpenAlex embeds per-request server timing in the response body itself. Three
consecutive requests to the identical URL, two seconds apart:

```
call 1  sha256 9f4e17a6e650...
call 2  sha256 a6fbe037028f...
call 3  sha256 a6fbe037028f...
meta.db_response_time_ms: 9    (call 1)
meta.db_response_time_ms: 33   (call 2)
meta.cost_usd, meta.notice     (also per-request)
```

The result set is identical between calls; only the volatile `meta` block differs.

`backend/src/kory/skill-eval-public-research-runtime.ts` requires raw byte equality:

```
line 477   digest: hash(body),                       // grader's own refetch
line 968   item.sha256 === digest && ...             // candidate must match it
```

So the candidate records the hash of the body it fetched, the grader refetches and
records the hash of a different body, and the check fails with probability
approaching one. No skill text can satisfy it.

Control measurement, same method, same host:

```
STABLE  https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=RouteLLM&format=json
STABLE  https://arxiv.org/abs/2406.18665
STABLE  https://api.crossref.org/works/10.48550/arXiv.2406.18665
STABLE  https://nodejs.org/en/about/previous-releases     (factual-research source)
UNSTABLE https://api.openalex.org/works?search=RouteLLM&per-page=10
```

The defect is confined to the two OpenAlex rows. `factual-research` uses only stable
sources and reached ready at 0.947, which is consistent with this diagnosis.

## Proposed patch, for review only

Give a source spec an explicit volatile marker and compare a projection instead of raw
bytes. Volatility is a property of the endpoint, so it belongs next to the spec rather
than in the scorer's comparison logic.

```ts
// near SourceSpec
interface SourceSpec {
  // ...existing fields
  /** Fields whose values change per request and are excluded from the digest. */
  volatilePaths?: readonly string[];
}
```

```ts
// hash used for evidence, replacing hash(body) at both fetch sites
function evidenceDigest(spec: SourceSpec, body: string): string {
  if (!spec.volatilePaths?.length) return hash(body);
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const strip = (value: unknown, path: string[]): void => {
      if (!value || typeof value !== 'object') return;
      const [head, ...rest] = path;
      if (!head) return;
      const record = value as Record<string, unknown>;
      if (!rest.length) {
        delete record[head];
        return;
      }
      strip(record[head], rest);
    };
    for (const path of spec.volatilePaths) strip(parsed, path.split('.'));
    return hash(JSON.stringify(parsed));
  } catch {
    return hash(body);
  }
}
```

With the two OpenAlex specs declaring:

```ts
volatilePaths: ['meta.db_response_time_ms', 'meta.cost_usd', 'meta.notice'],
```

The candidate and the grader then hash the same projection, and every other source
keeps strict raw byte equality, so no check is weakened for stable endpoints.

## Alternative, smaller change

Remove the two OpenAlex rows from `evidence.sources` for the literature case and keep
the arXiv, Europe PMC,PubMed and Crossref rows, which are byte-stable. This loses the
OpenAlex corroboration path but needs no new field.

## Why it was not applied

The work order forbids editing fixtures, scorers and materializers without direction.
Both options above change scoring behaviour for a package that is currently blocked,
so the choice needs a coordinator decision rather than an agent edit.
