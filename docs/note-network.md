# Associative Note Network

Koryphaios combines linked documents, reviewed knowledge relationships, and bounded
retrieval. This is an explainable knowledge graph, **not a trained neural network**.
A query activates relevant seed notes and follows local connections; it does not
silently train weights or turn repeated retrieval into truth.

## Using the Network workspace

Open **Notes → Network**.

1. Search for project notes and select a source and target.
2. Propose a relationship with evidence tied to the current revisions of both
   notes. A proposal does not edit the documents or become an accepted claim.
3. Review proposed relationships. **Accept** and **Reject** compare the displayed
   relationship revision against current storage. Acceptance refuses evidence
   whose endpoint notes have changed. Refresh and re-propose after reviewing new
   source material rather than retrying a stale acceptance. Use the explicit,
   confirmed removal action to remove an obsolete relationship before proposing
   new evidence for the same pair; removal does not delete document wikilinks.
4. Use **Query activation** to retrieve excerpts and inspect why each note was
   selected, including paths, revisions, stale evidence and truncation.

Query activation shows the query you just ran, not a fabricated trace of a past
agent answer. Its accessible path cards are separate from the existing large
force-directed graph. Relationships and picker results are bounded; refresh to
see external changes.

## Relationships and trust

| Type          | Meaning of the recorded claim                |
| ------------- | -------------------------------------------- |
| `related_to`  | A general association, not factual agreement |
| `depends_on`  | The source depends on the target             |
| `supports`    | The source provides evidence for the target  |
| `contradicts` | The source challenges the target             |
| `supersedes`  | The source replaces the target               |

Relationships have `proposed`, `accepted`, or `rejected` status. Only accepted
relationships participate as associations in normal graph traversal. Acceptance
records a reviewed claim; it does not prove the claim true. Embedding similarity
alone must never be presented as evidence of support, contradiction or replacement.

Each directed note pair has one current relationship. Records retain weight,
evidence, endpoint revisions, their own revision, origin and host actor metadata.
Weights are retrieval strengths, **not calibrated confidence values**. Mutations
have durable SQL audit snapshots. Recreating a deleted pair does not reset its
revision and make an old approval valid again.

Ordinary `[[wikilinks]]` remain document-derived references. They are stored
separately from durable relationships; reparsing a document cannot erase an
explicit association. A document reference remains a reference even if a separate
typed relationship between the same notes is proposed or rejected. Forward
references are repaired when targets are created, renamed or synchronized.

## Agent workflow

The primary read operation is:

```json
{
  "query": "Authentication decisions and refresh-token incidents",
  "maxHops": 2,
  "limit": 6,
  "maxChars": 6000,
  "excerptChars": 1000,
  "semantic": true
}
```

Invoke it as `retrieve_note_context` in native agents or
`kory__retrieve_note_context` through the managed CLI MCP bridge.

- Start substantial work with a focused retrieval when relevant. Do not retrieve
  the entire vault or make an extra call for every trivial request.
- Inspect excerpts, paths, revisions, coverage and stale-evidence warnings.
- Use `render_note` excerpts or `read_note` only when additional detail is needed.
- Give workers relevant note IDs/revisions and task-scoped evidence, not copies
  of every note. Critics retain read-only access.
- Record durable outcomes with `record_work_note`; distinguish reported test
  evidence from verified execution. Host identity is supplied by Koryphaios,
  while the tool's commands/tests/evidence descriptions are still agent-supplied.
- Use `propose_note_relationship` with evidence and both endpoint revisions.
  `review_note_relationship` always requires a separate human approval, including
  under YOLO. It cannot silently approve its own inference.

Host project/role context owns scope. Callers cannot select another project through
retrieval arguments. The registry composes Notes read and retrieval permissions;
explicit Ask and Block cannot be bypassed with a reused approval receipt. A
standalone knowledge MCP connection without an approval channel fails closed on
approval-required actions. Available tool sets differ by provider and transport;
use the runtime catalog, not assumptions based on a provider's name.

**Codebuff limitation:** the required `codebuff/base@0.0.16` store agent on SDK
0.10.7 does not allow this adapter to extend its published `toolNames`. It retains
real Kory filesystem/command overrides but cannot invoke the Notes/control-plane
tools. The adapter and capability reporting explicitly disclose this; merely
passing custom definitions would not make them callable. Supporting it requires
an upstream extension API or a separately approved custom-agent product change.
Gemini CLI likewise has no Kory control-plane bridge in this implementation.

### Retrieval bounds

The service combines lexical candidates with optional persistent semantic matches,
then expands accepted relationships and document references. It returns bounded
excerpts rather than complete documents by default.

| Bound                                    | Current maximum |
| ---------------------------------------- | --------------: |
| Explicit seed IDs                        |               8 |
| Graph hops                               |               2 |
| Visited notes                            |              48 |
| Traversed edges                          |              96 |
| Semantic vectors examined per request    |             512 |
| Per-node expansion fanout                |              12 |
| Returned notes                           |              12 |
| Total excerpt characters                 |          16,000 |
| Per-note excerpt characters              |           2,000 |
| Serialized retrieval response characters |          65,536 |

Responses include actual budget use, truncation reasons, note revisions,
relationship revision/evidence, discovery explanations and concurrent/stale
revision conflicts. Examined connections between independently retrieved seeds are
retained too, so a contradiction is not hidden just because both endpoints matched
the query. Natural-language lexical queries broaden when an all-terms match is
insufficient. Expansion is damped by hop count, relationship strength, local degree
and stale evidence; a result slot is reserved for linked evidence when seeds would
otherwise consume the whole result limit. These are bounded results, never a promise that the entire
vault or every contradiction was examined. Reads do not synchronize documents,
create relationships or write embeddings. Project source synchronization remains
a separate existing operation.

Automatic Notes context separately uses one combined catalog/body budget and
excludes selected bodies when `read_note` requires approval or is blocked.
Injected and recalled notes are labeled as fallible source data, not instructions.
Bulk `recall_notes` output is capped at 32,000 characters and marks truncation.

## Optional persistent semantic index

Local lexical and graph retrieval work without an embedding provider.

To enable semantic matching, configure the authenticated embedding endpoint as
specified in [ADR-006](adr/006-embeddings-explicit-stub.md), then explicitly opt in
through **Notes → Network → Semantic index**. Rebuild/continue operates on one
bounded batch at a time; it is not a hidden background upload of the whole vault.
The UI supports cancel and restart.

- Every rebuild requires explicit `optIn: true`, enabled Notes, and automatic
  read/search/retrieval permissions before sending note text.
- A batch processes 1–128 notes, with a default of 32 and a transport deadline.
- The representation is the first **8,000 characters of title plus content** per
  note. Note-count coverage does not imply full-document chunk coverage.
- Persistent ID pagination reaches old notes instead of limiting indexing to
  recently updated notes. Continue batches until coverage is complete; restart to
  revisit changed notes when appropriate.
- Vectors are bound to project, note revision, full content hash, endpoint, model,
  dimensions and credential identity. Changes invalidate use immediately. Status
  coverage is a **revision-metadata inventory**, not a full-content integrity audit;
  actual result candidates undergo full-content hash validation. Disabled,
  permission-denied and not-opted-in status does not read the note/vector corpus
  and reports counts as not evaluated, rather than claiming an empty vault.
- Retrieval sends the query only and compares valid vectors locally. It does not
  index new documents as a side effect. No raw credential is stored in index rows.
- A changed provider/model/credential requires renewed explicit opt-in. Failed or
  unavailable semantic retrieval leaves local lexical/graph retrieval available.
- Search uses cooperative pages and a maximum of **512 vectors** per request,
  with deadline/cancellation and explicit scan coverage. A ready index can still
  produce a non-exhaustive search when it exceeds that cap. SQL metadata coverage
  aggregation remains corpus-dependent; this is not an ANN database or an
  unlimited full-document semantic service.

The older `search_notes` / `/api/notes/search` path still supports its existing
bounded snapshot embeddings under the environment opt-in described in ADR-006.
Do not confuse that path with the explicitly rebuilt persistent index used by
`retrieve_note_context`.

## HTTP operations

All operations use the existing authenticated local Notes routes and host project
selection.

| Method and path                                 | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/notes/relationships`                  | Bounded list, optionally by note/status                          |
| `POST /api/notes/relationships`                 | Propose a typed revision-bound relationship                      |
| `PATCH /api/notes/relationships/:fromId/:toId`  | Review a pending relationship with CAS                           |
| `DELETE /api/notes/relationships/:fromId/:toId` | Explicit revision-checked removal without editing document links |
| `POST /api/notes/context`                       | Read-only query activation                                       |
| `GET /api/notes/semantic-index`                 | Configuration, progress and coverage                             |
| `POST /api/notes/semantic-index/rebuild`        | Explicit cancellable indexing batch                              |

## Durability and portability

Migrations `0046`–`0048` introduce durable associations, lifecycle/audit storage,
and the optional persistent semantic index. Content-synchronized link mutations
use revision checks and transactional database updates; source-file failures are
compensated without deliberately overwriting a newer external edit.

Version-2 vault archives include an optional validated `relationships` section.
Restore remaps note IDs and preserves relationship status, evidence, actor,
weights, timestamps and endpoint revisions. Stale evidence stays stale. Older
v1/v2 archives without that section remain readable. Archives preserve the current
relationship snapshot, not its historical audit rows; embeddings are rebuildable
local derived data and are not transported in vault archives.

## Verification boundaries

Unit/integration tests cover graph durability, relationship approval and revisions,
project/trash isolation, retrieval budgets, semantic opt-in/cancellation, archive
round trips, and UI request guards. Embedding tests use mocked transports, not paid
provider calls. A working local test does not establish provider account access,
semantic quality, or compatibility with every external agent. No autonomous
reinforcement, unattended relationship promotion, or literal neural-network
training is claimed.
