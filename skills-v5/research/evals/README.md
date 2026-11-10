# Research V5 historical corpus acquisition

The two `research-full-task-*-individual` fixtures require **original, dated source
bytes**, with a cutoff of **2026-09-04T23:59:59Z**. Source discovery and an
apparently plausible answer are not sufficient. The source contracts are in
`backend/src/kory/skill-eval-research-history-runtime.ts`, which independently
checks the acquired bytes before materialization and scoring.

## Status checked through 2026-10-12 00:05 UTC (2026-10-11 PDT)

| Scenario                          | Required source roles | Pinned candidates | Unresolved roles                                                                                                       |
| --------------------------------- | --------------------: | ----------------: | ---------------------------------------------------------------------------------------------------------------------- |
| `research-full-task-1-individual` |                     4 |                 0 | Exact-day Agent Skills and Cursor documentation, dated misleading community claim, authentic pre-support internal note |
| `research-full-task-2-individual` |                     5 |                 3 | Final same-vendor compatibility evidence, independently archived contradictory forum answer                            |

`source-corpus-plan.json` records the source roles and unresolved reasons. Its
three GitHub candidates are pinned to original repository paths, commit IDs,
Git blob IDs, commit metadata timestamps, and consequential literal quotations.
The pins came from source inspection, but **no complete historical corpus has
been acquired or certified**. Git commit metadata is an authored timestamp,
not an independent attestation of when a document first became publicly
available. A release-candidate document that calls its revision non-final
cannot prove compatibility with a finalized protocol.

The exact-day Internet Archive CDX lookup was repeated for **both** required
original URLs (`https://agentskills.io/specification` and
`https://cursor.com/docs/skills`), with `from=20260904`, `to=20260904`,
`filter=statuscode:200` and indexed digest requested. The CDX endpoints and
response hashes are recorded under the two `roleId` values in each audit:

| Observation (UTC)      | Both exact URL/day CDX responses           | Original response SHA-256 (each)                                   | What can be concluded                                                    |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 2026-10-11 18:39       | HTTP 503, 11,832 bytes                     | `e084d527921708642a79724e9f0210da659bbc0905c6ce9a3a1f416e4628091c` | Index unavailable                                                        |
| 2026-10-11 18:44–18:45 | Request timeout                            | No response bytes                                                  | Index unavailable                                                        |
| 2026-10-12 00:01       | HTTP 200, parsed empty JSON array, 3 bytes | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` | No indexed HTTP-200 capture returned for either required URL on that day |
| 2026-10-12 00:05       | HTTP 503, 11,832 bytes                     | `e084d527921708642a79724e9f0210da659bbc0905c6ce9a3a1f416e4628091c` | Index unavailable on retry                                               |

The latest audit stores the **actual HTTP 503 response bytes**, base64-encoded
in `responseBodyBase64`, with the observed length, SHA-256, request URL and
status. Its offline validator checks identity and checksum before an audit is
saved. This is a snapshot of an **index error response**, never a snapshot of
the historically required pages. The earlier HTTP 200 empty-index response is
recorded by length and SHA-256 but was not persisted verbatim; it must not be
reconstructed and claimed as acquired bytes. An empty CDX response at a
particular retrieval time does **not** establish that a source never existed.
No qualifying indexed capture plus original replay bytes has been recovered.

On **2026-10-11 18:45:21Z–18:45:22Z**, the three pinned scenario 2 GitHub
documents were retrieved and verified against original Git blob identities:

| Role                      | Verified original SHA-256                                          | Byte count |
| ------------------------- | ------------------------------------------------------------------ | ---------: |
| Normative protocol        | `c8151ab8d7f26ab46785fd34b23f7197db1a98ca8318967faa01e401909667b5` |      5,694 |
| Official migration        | `8269eb627990eee0f0d001801b54bb88076f59a013015bb29714d3b5d7967164` |     45,919 |
| Legacy Microsoft tutorial | `1b6405d7d19476d19a06e4772b96febc79f3b5a8f9edb8e5fa176182175dfa0d` |     39,426 |

There is still no qualifying Microsoft document attesting finalized protocol
runtime support before the cutoff, nor an original contradictory forum answer
with independent archive provenance. Discovery leads such as a later main
branch document or a draft conformance patch cannot replace either role.

### Investigated exclusions and negative controls

These are **discovery leads**, not provenanced evaluator sources:

| Source/ID                                                                                                                                                                               | Required role                  | Reason it cannot be promoted                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Groundwork skills portability note](https://github.com/seanwinslow28/groundwork/blob/main/research/2026-07-16-skill-md-portability.md) (`research/2026-07-16-skill-md-portability.md`) | `cursor-skills-docs`           | Author reports a July 16 documentation fetch. This is not an independently indexed September 4 capture of the exact Cursor URL.                                                                            |
| [Cursor forum topic 148875](https://forum.cursor.com/t/skills-vs-commands-vs-rules/148875)                                                                                              | `community-client-extension`   | January 2026 community discussion describes Agent Skills as portable. It is not a false claim universalizing a Cursor-only field; no qualifying original Git revision/archive replay has been identified.  |
| [Microsoft curriculum changelog](https://github.com/microsoft/mcp-for-beginners/blob/main/translations/en/changelog.md), **September 9 final alignment**                                | `current-vendor-compatibility` | Published date stated in the changelog is after the September 4 cutoff, and curriculum version alignment is not proof that its earlier tutorial/runtime supported the finalized revision.                  |
| [Microsoft Wassette release list](https://github.com/microsoft/wassette/releases), **v0.7.0, August 29**                                                                                | `current-vendor-compatibility` | A different Microsoft repository and runtime; the evaluator requires the compatibility source to match the pinned `microsoft/mcp-for-beginners` vendor history. No cross-project substitution.             |
| [VS Code issue 329848](https://github.com/microsoft/vscode/issues/329848), **opened August 9**                                                                                          | `contradictory-forum-answer`   | Describes VS Code client negotiation limitations, not a contradiction of the TypeScript SDK's opt-in migration guidance. Also lacks a qualifying independently indexed original archive digest and replay. |
| `backend/src/kory/__fixtures__/research-history/agent-skills-spec-git-2026-08-09.provenance.json`                                                                                       | `agent-skills-spec`            | Already labeled a nonqualifying Git provenance control; a pre-cutoff Git revision does not prove the specified page was retrieved September 4.                                                             |

The unverified pre-support **internal** note also remains absent. Public guidance
cannot be renamed or recreated as an internal note. No dated source page has
been synthesized, and no qualification gate, score, or cutoff was changed.

The nonqualifying audit records are preserved in `source-audits/`:

- `research-full-task-1-individual-2026-10-11T18-44-49-244Z-52e53087.json`
- `research-full-task-2-individual-2026-10-11T18-45-22-033Z-c23e1574.json`
- `research-full-task-1-individual-2026-10-12T00-01-32-877Z-26927aa3.json` (HTTP 200 empty inventories)
- `research-full-task-1-individual-2026-10-12T00-05-23-351Z-9bbac984.json` (HTTP 503, saved original response bytes)

They record exact request URLs, observation times, failure categories, and
response hashes or verified Git object identities. They are **not source
snapshots or runtime fixture manifests**. Neither scenario is execution-ready.
Their `sourcePlanSha256` identifies the plan bytes at probe time; the unresolved
reason descriptions in the plan were subsequently updated with these findings.
An attempted fresh scenario-2 audit was rejected by automatic safety review;
no retry or replacement run was performed. Its earlier successful Git checks
remain recorded as historical observations, not new verification.

## Running the acquisition sidecar

From the repository root, inspect the role inventory first. A probe reports
retrieval outcomes without writing any source corpus files:

```sh
bun skills-v5/research/evals/snapshot-corpus.ts probe --scenario research-full-task-1-individual
bun skills-v5/research/evals/snapshot-corpus.ts probe --scenario research-full-task-2-individual
```

For a durable evaluator-owned audit, including direct checks of the two
required exact-day Wayback CDX indices, run:

```sh
bun skills-v5/research/evals/snapshot-corpus.ts audit --scenario research-full-task-1-individual
bun skills-v5/research/evals/snapshot-corpus.ts audit --scenario research-full-task-2-individual
```

The audit writes a new, never-overwritten `source-audits/*.json` record. It
distinguishes HTTP errors/timeouts from verified empty inventories and labels
indexed candidates **unverified** until the replay bytes match the CDX digest.
For responses up to 32 KiB it also preserves the received response bytes in
base64 and validates that their length, SHA-256, originating URL and inferred
index outcome agree. Tampered raw responses, false empty-inventory labels,
wrong dates, copied role IDs and falsely complete audits fail the local tests.
An incomplete probe or audit deliberately exits with code 2. The audit records
independent observations; it cannot establish that an unavailable archive
contains or lacks a source.

After every role has a **genuine** qualifying source and pinned consequential
quotation in the plan, an operator can request a snapshot into the runtime's
dedicated fixture directory:

```sh
bun skills-v5/research/evals/snapshot-corpus.ts snapshot \
  --scenario research-full-task-2-individual \
  --out "$PWD/backend/src/kory/__fixtures__/research-history"
```

These commands are documentation, **not recorded qualification runs**. Do not
execute the snapshot command while any source remains unresolved. The sidecar
also refuses to write an incomplete corpus; the example will currently exit
without a manifest.

The sidecar checks that the remote source and response URL match, demands exact
archive dates where required, checks the Internet Archive's indexed SHA-1
digest against replay bytes, and checks pinned Git commit and blob metadata
against the downloaded original bytes. It enforces the protocol's historic
version window, verifies verbatim quotations, bounds response sizes, requires
UTF-8 round trips, and retains source SHA-256 hashes. Successful acquisitions
are staged, linked into the destination without overwriting files, and publish
the scenario manifest last; incomplete runs do not write snapshots.

A source must establish the actual claim required by its role. The operator
must inspect semantic relevance, authority, publication scope, and whether a
compatibility statement addresses the finalized runtime. Quotation and digest
checks establish byte identity; they cannot by themselves make a claim true.

Even after a complete corpus is obtained, the existing synchronous readiness
gate stays blocked until its independent asynchronous preflight is integrated.
The paired skill/no-skill evaluation and independent blind review are separate
qualification responsibilities. No ledger entry or readiness status should be
changed by this acquisition sidecar.

## Local validation

```sh
bun test skills-v5/research/evals/snapshot-corpus.test.ts \
  backend/src/kory/__tests__/skill-eval-research-history-runtime.test.ts
```

Tests use controlled bytes solely to exercise rejection and validation
invariants. Controlled transports never certify historical provenance.
