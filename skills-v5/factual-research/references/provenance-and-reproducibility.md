# Provenance and reproducibility

Use this guide for current claims, checks across multiple sources, and full task evaluation artifacts. It describes the evidence contract. It does not turn a template, mock response, cached snippet, or source discovery result into evidence.

## 1. Preflight record

Before retrieval, record:

| Field            | Required record                                                     |
| ---------------- | ------------------------------------------------------------------- |
| `checkedAt`      | UTC time for the run                                                |
| `startingState`  | Starting page, endpoint, or supplied evidence set                   |
| `asOf`           | Date or version at which the claim is judged                        |
| `scope`          | Jurisdiction, product, runtime, population, or eligibility boundary |
| `sourceOfRecord` | Authority that owns the fact, when one exists                       |
| `access`         | Available, blocked, stale, simulated, or otherwise limited          |

Do not replace an unavailable environment with an assumed one. A live public web task needs a real retrieval run. A historical task needs the package's dated source contract and its independent provenance gate.

## 2. Source ledger

Keep one row for every source used to support or reject a material claim. Preserve the exact values observed by the retrieval surface.

| Field                           | Meaning                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `id`                            | Stable local source identifier                           |
| `url`                           | Exact HTTPS URL requested and verified                   |
| `status`                        | Observed HTTP status                                     |
| `retrievedAt`                   | UTC retrieval time                                       |
| `sha256`                        | SHA256 of the raw response body when available          |
| `lastModified`                  | HTTP value, or `null` when absent                        |
| `publishedAt` / `effectiveDate` | Date asserted by the source, not the retrieval date      |
| `scope`                         | What the source actually covers                          |
| `excerpt`                       | Verbatim text that supports or contradicts the claim     |
| `role`                          | Primary, corroborating, contradictory, or discovery only |

The URL, response identity, body digest, and excerpt serve different purposes. A matching URL does not prove that the returned bytes were the expected document. A digest proves byte identity, not semantic authority. An excerpt proves that the text is present, not that it applies beyond its stated scope.

## 3. Verification sequence

1. Confirm the response URL remains on the expected HTTPS origin and has the expected content type.
2. Preserve the raw response digest and retrieval time before interpreting the body.
3. Confirm the source identity and quote the relevant passage verbatim.
4. Compare publication, effective, and retrieval dates separately.
5. Corroborate consequential claims with an independent authority or a source that tests a different failure mode.
6. Mark the claim `unverified` when a required source, date, scope, or contradiction remains unresolved.

For the public research evaluation, the runtime independently refetches declared sources and checks exact URLs, status, recent UTC timestamps, raw response hashes, last modified values, and excerpts. Its controlled transport is validation input only. It cannot certify a live run.

For historical research evaluation, the source corpus sidecar checks the required role inventory, original bytes, archive or Git provenance, cutoff, source hashes, and verbatim quotations. A Git commit date is not a dated retrieval of a different public URL. An archive outage, an empty inventory observed later, a candidate URL, or generated controlled bytes is not a historical snapshot.

## 4. Failure and recovery evidence

Record the attempted request, observed status or exception, time, and resulting claim boundary for an unavailable or negative path. Record recovery only after the recovery request or interaction is actually observed. Label injected outages and controlled transports as negative controls. Do not describe a hypothetical retry, a planned live lookup, or a later unrelated success as completed recovery.

The final report should distinguish:

- `verified`: the required source and claim checks passed;
- `partly true`: only a bounded portion of the proposition is supported;
- `unverified`: a required source, scope, date, or recovery observation is missing;
- `unavailable`: the environment or source could not be reached;
- `inferred`: a synthesis that is not directly stated by a source.

Keep the narrowest verdict supported by the recorded evidence. Never invent a retrieval date, source bytes, response hash, archive capture, or live web result.
