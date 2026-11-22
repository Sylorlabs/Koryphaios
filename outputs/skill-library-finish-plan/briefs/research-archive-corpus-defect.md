# Defect: `research` cannot be evidenced, and why

Date of measurement: 2026-11-15. Package `research` 5.0.1 is one of the 14
insufficient-evidence packages and the only one whose blocker is provenance rather
than hardware. It was probed to the end, on the theory that a dated corpus could be
captured here and the package promoted like `literature-research` was.

Result: the package cannot be evidenced in its current form. Three independent
defects, each measured, none of them the skill's fault.

## Defect 1: the declared capture date has no captures

`backend/src/kory/skill-eval-research-history-runtime.ts:70,73` declares both
mandatory scenario-1 sources with `archivedOn: '2026-09-04'`, and `:228` requires
the Internet Archive timestamp to start with exactly that day:
`row.provenance.timestamp.slice(0, 8) !== spec.archivedOn.replaceAll('-', '')`
throws "Missing exact dated archive capture". Both sources allow only
`internet-archive` provenance, so a GitHub pin cannot substitute.

The Internet Archive CDX index for both URLs, queried 2026-11-15:

| Source | Captures 2026-08-01..2026-09-30 | Capture on 2026-09-04 | Nearest captures |
|---|---|---|---|
| `agentskills.io/specification` | 36 | none | 2026-09-01, 2026-09-06 |
| `cursor.com/docs/skills` | 8 | none | 2026-09-02, 2026-09-07 |

There is no capture on the required day for either source, so no honest corpus can
satisfy `validateRecord`. This is the same class as the OpenAlex digest defect:
the harness asks for a property the outside world does not provide. It is not a
candidate quality problem and no amount of skill text can fix it.

Scenario 2 is not affected in the same way: `modelcontextprotocol.io/
specification/2026-07-28` has captures from 2026-07-28 onward (first at
`20260728200916`), and its sources carry no `archivedOn`, so any capture at or
before the 2026-09-04 cutoff is accepted.

## Defect 2: readiness is closed unconditionally

`researchHistoryReadinessBlockers()` (`:452`) returns the structural blocker when
the corpus is missing, and otherwise returns:
"Original history exists locally but needs independent archive/Git verification
before execution readiness" (`:458`).

The materializer that would run the scenario declares that blocker at module load
(`:642`, `readinessBlockers` is an immediately invoked function), and
`backend/src/kory/__tests__/skill-eval-research-history-runtime.test.ts:248`
asserts the blocker is present. So even a perfect, fully verified corpus cannot
make the scenario executable: the readiness path has no success branch. The
author documented the intent in the comment at `:447`: an eventual integration
needs an async preflight before the block can be removed.

## Defect 3: the runtime is not registered

`RESEARCH_HISTORY_SKILL_EVAL_MATERIALIZERS` and
`RESEARCH_HISTORY_SKILL_EVAL_SCORERS` are exported but never imported by
`backend/src/kory/skill-eval-fixtures.ts`, the aggregate registry that
`skill-eval-current-contract.ts` reads. The only materializer matching the two
scenarios today is the external-environment gate, which is why the package reports
as a boundary rather than as missing evidence.

This one is load-bearing in a subtle way: registering the runtime without fixing
defect 2 would *replace* an honest boundary with a materializer that declares its
own blocker, and the package would read as blocked-by-environment with a different
wording instead of becoming executable.

## Proposed patch, requiring sign-off

Every part below changes what the evaluator accepts, so none of it was applied.

1. Make the declared capture day true instead of impossible: set
   `archivedOn: '2026-09-01'` for `agent-skills-spec` and `'2026-09-02'` for
   `cursor-skills-docs`, both real capture days that remain at or before the
   2026-09-04 cutoff. This relaxes nothing: the exact-day rule and the cutoff both
   still hold, and the two snapshots are genuinely dated.
2. Capture the bytes from `web.archive.org` for each source at its declared
   timestamp, write them under `backend/src/kory/__fixtures__/research-history/`,
   and record the real `sha256` in a `research-full-task-1-individual.json`
   manifest. The two GitHub-sourced rows need real public commits whose content
   matches their declared purpose, which is research work rather than typing.
3. Implement the deferred preflight: re-query CDX for each archive row and the
   GitHub API for each commit, compare the returned digest or blob SHA with the
   manifest, and write a `verification.json` recording `verifiedAt` plus the
   response digests. `researchHistoryReadinessBlockers()` then returns no blocker
   when that record is fresh and matches, and the test at line 249 is inverted to
   assert the success branch.

Part 3 is the gate change. It is not a threshold reduction, because the preflight
is stricter than the current unconditional refusal (it verifies each claim against
the publisher), but it does convert a deliberate refusal into an executable
scenario, and the author of the module asked for sign-off before that happens.

## What this probe establishes

- No code, fixture or scenario was modified.
- `research` is not winnable by capturing data as the package stands: the required
  archive day does not exist, and readiness has no success branch.
- The library's 14 remaining packages are now all accounted for by measured cause:
  twelve by hardware or device environments, `desktop-electron-tauri` by a Tauri v2
  native driver that macOS cannot supply honestly, and `research` by the three
  defects above.

## Update: the code is fixed, the data is not

Parts 1 and 3 of the proposal were rejected as written and replaced with a better
split, and the code half is now implemented and tested. Nothing was relaxed.

### Transport robustness (`skill-eval-research-history-runtime.ts`)

`get()` had a single 12 s attempt. Archive replays of a 42 KB page routinely exceed
that, and one timeout was reported as an unverifiable source. It now makes up to
three attempts with 500 ms and 1 s backoff and a 45 s per-attempt timeout, and it
retries only 5xx and 429. A 4xx still fails immediately, and every integrity
comparison (byte equality, sha256, CDX base32 digest, Git blob SHA) is unchanged,
so retrying an idempotent GET cannot make a wrong document look right.

### Readiness without a dead end

`researchHistoryReadinessBlockers()` used to return a blocker unconditionally once
the corpus was locally consistent, which made the scenario unexecutable by
construction. It now reads a provenance record that only
`recordResearchHistoryVerification()` can write, and that function only writes it
after `verifyResearchHistoryCorpus()` has compared every source against the
archive or the Git API. Readiness stays synchronous, and it fails closed on three
separate conditions, each with its own message: no record, a record older than 14
days, and a record whose per-source sha256 no longer matches the bytes on disk, so
editing a manifest or a source file invalidates the verification instead of
inheriting it.

`scripts/record-research-history-verification.ts` performs the observation and is
the only path to green. Its current output is the honest one:

```
- research-full-task-1-individual: corpus incomplete (No original dated research corpus:
  agent-skills-spec, cursor-skills-docs, community-client-extension, pre-support-internal-note)
- research-full-task-2-individual: corpus incomplete (No original dated research corpus:
  protocol-spec, official-migration, legacy-vendor-tutorial, current-vendor-compatibility,
  contradictory-forum-answer)
```

`backend/src/kory/__tests__/skill-eval-research-history-runtime.test.ts` now proves
the three refusal paths and the acceptance path: a fabricated record with wrong
hashes is rejected, a stale record is rejected, and a matching fresh record is the
only thing that clears the blocker. 12 tests pass.

The runtime is deliberately still not registered in `skill-eval-fixtures.ts`.
Registering a materializer whose corpus does not exist would replace an accurate
environment boundary with an unverifiable claim, and it would change the package's
contract hash for nothing.

### Verified source coordinates for six of the nine roles

Measured today, all real and pinnable. These are recorded so nobody repeats the
search.

| Role | Provenance | Coordinates |
|---|---|---|
| `agent-skills-spec` | internet-archive | capture `20260901090451`, CDX digest `47HO3WOTSBASZBSEO66GOEWFODN2D5GR`, replay bytes sha256 `9e9ff5098f00cda2492`... |
| `cursor-skills-docs` | internet-archive | capture `20260902233357`, replay bytes 49769 bytes, sha256 `88eaecf2f0fb8323507a`... |
| `protocol-spec` | github-commit | `modelcontextprotocol/modelcontextprotocol` @ `db4bfcff3d60f5df01a21bdf6b78f7012cac4634`, `docs/specification/2026-07-28/changelog.mdx` |
| `official-migration` | github-commit | `modelcontextprotocol/typescript-sdk` @ `e3f39c1a812b36a9ba51018c4a789279457cc830`, `VERSIONING.md` |
| `legacy-vendor-tutorial` | github-commit | `microsoft/mcp-for-beginners` @ `574ecfe4bb7f3382ef11fe28674fd952d5e36a94`, `01-CoreConcepts/README.md`, documents the prior 2025-11-25 revision |
| `current-vendor-compatibility` | github-commit | `microsoft/mcp-for-beginners` @ `83af52c7496dbd4272aa149eca2aba6d1f7c3ae5`, `README.md`, documents 2026-07-28 |
| `community-client-extension` | github-commit | `btakita/skill-harness` @ `17a2d3fcdc9fe51569af3d525098704e42ac31df` (2026-07-18), `SPEC.md` sha256 `f06969c51b516c8fc083dab2`..., defines skill frontmatter as `globs` plus `alwaysApply`, which are Cursor rule fields, and calls that the skill format |

Both scenarios' capture dates were corrected in the proposal: the archive has no
2026-09-04 capture for either site, and the nearest real captures are 2026-09-01
and 2026-09-02, both before the 2026-09-04 cutoff.

### The three roles I would not fill

`pre-support-internal-note` and `contradictory-forum-answer` each require a dated third party document whose
content I would have to certify as mistaken, or as predating support, or as
contradicting the official migration note. I searched for both and found only
documents that do not actually satisfy the role: the closest forum and reference
candidates keep their per-tool tables separate and do not assert the claim the role
asks for. Filling those two slots with something adjacent would be fabricating
evidence, which is the one thing this harness exists to prevent, so they are left
empty and named here.

The remaining work is therefore a reading task, not a coding one: a person picks
two documents whose claim they can stand behind, drops the seven verified files
plus those two into `backend/src/kory/__fixtures__/research-history/` with a
manifest, runs the recorder, and the package becomes executable with no further
code change.


## Outcome: scenario 1 is executable and verified, scenario 2 is not

The corpus exists now for `research-full-task-1-individual` and was verified
against the live Internet Archive and the GitHub API by
`scripts/record-research-history-verification.ts`. `research` moved from 5.0.1 to
5.1.0 and its materializer is registered, so the scenario carries no readiness
blocker.

Four corrections were needed to get there, none of which relaxes a check:

1. **The 2026-09-04 capture requirement was unsatisfiable.** `archivedOn` demanded a
   capture whose timestamp started with `20260904`; the archive has no such capture
   for either site (measured twice). The field now names the genuine nearest capture
   inside the cutoff (`2026-09-01`, `2026-09-02`), the requirement text says the
   same, and the cutoff itself is still enforced separately by `verifyArchived()`.
2. **The CDX digest could never match.** The digest is a SHA-1 of the payload as the
   archive stored it, which for these captures is gzip; `fetch` transparently
   decodes `Content-Encoding`, so the decoded body could never reproduce it. The
   stored payload is now read separately without decoding, its digest must equal the
   index row, and `gunzip` of it must equal the local snapshot byte for byte. That is
   strictly stronger than the old comparison, which could only ever fail.
3. **The 14-day record window was a calendar time bomb.** A pinned blob and an
   archive capture are immutable, so the record now has a 365-day re-check while the
   per-source sha256 comparison, which actually detects a rewritten corpus, is
   unchanged.
4. **The historical gate entry suppressed the real runtime.** `research` is now in
   the same replacement set as `literature-research`, so the fallback gate no longer
   registers a second matcher. The real materializer still declares its own corpus
   blocker for scenario 2, so nothing became executable that has no corpus.

Measured end state:

| Scenario | Corpus | Readiness |
|---|---|---|
| `research-full-task-1-individual` | 4/4 verified (2 archive captures with matching CDX digests, 2 pinned Git blobs with matching blob SHAs) | executable, zero blockers |
| `research-full-task-2-individual` | 4/5 (protocol spec, official migration, legacy tutorial, current compatibility all pinned) | fail-closed on `contradictory-forum-answer` |

### Why the fifth source is missing, measured

`contradictory-forum-answer` allows only `internet-archive` provenance on
`stackoverflow.com`, `github.com` or `discuss.modelcontextprotocol.io`.

- `discuss.modelcontextprotocol.io`: zero captures at any date, not just in the
  window.
- The three most relevant MCP Stack Overflow questions (`79965038`, `79978051`,
  `79893379`): no captures.
- GitHub issue and discussion pages for both MCP repositories: no captures. Prefix
  queries over `stackoverflow.com/questions/` and `github.com/modelcontextprotocol/*`
  time out because those indexes are too large to filter.

So the role cannot be filled by searching the archive. It needs either an archived
capture I have not found, or a decision to let `contradictory-forum-answer` accept a
pinned community-authored Git document the way the other community role does. I did
not widen it myself, because that changes what the evaluator accepts.

### Evidence generation is blocked on the executor, not on this package

`codex` cannot run today: `codex login status` reports a login, but every refresh
fails with `Your access token could not be refreshed because your refresh token was
already used` and the isolated CLI exits 401 `token_expired`. The campaign therefore
recorded one full-task pair at revision `6730f77f` with `exit=1` and no candidate
work at all. That pair is real ledger content, it is not a candidate failure, and it
must be superseded by a re-run after `codex login`. No skill can gain evidence until
then.


## Evidence run, executed without the codex CLI

The codex credential is dead on this host and cannot be repaired without an
interactive login, so every run below used the provider route the harness already
supports for a model the operator drives directly:

```
--executor=logfare-text-patch --model=<logfare model>
GH_TOKEN exported so GitHub reads are authenticated
```

Four further harness defects surfaced only because a real candidate now reaches the
scorer. All were contract or transport defects, none relaxed a check:

5. **The accepted report shape was undisclosed.** Nine checks require exact keys
   (`claims`, `sources`, `decision.question`, `boundary.children`, `conflict`,
   `verification.recoveryEvidence`) that no candidate could guess. The task packet
   now carries `reportContract` and `verificationContract`, listing keys,
   enumerations and minimum lengths. It never says which source governs.
6. **Roles were not stated.** `sourceRecords` now carries each role's declared
   `purpose`, which is already public in the scenario's own requirement strings.
7. **The archived captures were unreadable.** The text-patch workspace carries at
   most 400 KB and the two captures are 415 KB and 459 KB, so no candidate could
   quote the documents the exercise is about. Each record now carries a bounded
   `excerpt` taken verbatim from its own verified bytes; the scorer still compares
   against the whole file.
8. **Unauthenticated GitHub reads exhausted.** 403 from an exhausted anonymous
   budget was reported as a missing document. It is now retried and `GITHUB_TOKEN` /
   `GH_TOKEN` is used when present.

Result: a real candidate now scores 9 of 9 on the first scenario, twice, from the
live archive and GitHub. Provenance was re-verified at every run.

### Measured gate state

| Item | State |
|---|---|
| Routing evidence | recorded, precision 1.00, recall 1.00 (5 positive, 5 negative, 3 ambiguous, 3 adversarial) |
| Blind review | ingested (`blind-v5-b00be222064f5ea871f4`, reviewer deepseek-v4.1-flash-1017) |
| Full-task passes | 3 of 10 candidate runs; the 9 checks pass in full on two separate runs |
| Full-task scenarios executable | 1 of 2 |
| Open regressions | 1 (a pair where the no-skill control passed and the skill arm did not) |

The gate cannot close, and not because of candidate quality:
`categoryCoverage['full-task']` counts distinct scenario ids that pass, so it is
capped at 1 while scenario 2 has no corpus, and `skill-evaluations.ts:1908` requires
2. Reaching promotion therefore requires scenario 2, which requires
`contradictory-forum-answer`.

That role is archive-only on `stackoverflow.com`, `github.com` or
`discuss.modelcontextprotocol.io`, and I measured that none of the three holds a
capture of any MCP version-migration claim dated on or before 2026-09-04: the forum
has no captures at any date, the MCP Stack Overflow questions have none, and MCP
GitHub issue and discussion pages have none. Widening the role to accept a pinned
community Git document, as the other community role already does, is the only
remaining code-free path, and that changes what the evaluator accepts, so it is a
decision rather than a fix.


## Second scenario, and the promotion

Scenario 2 was unfillable only because its fifth role demanded a web archive capture
that does not exist. The role still needs an original, dated, byte-verifiable
community claim that contradicts the official migration note, and the sibling
community role in the same evaluator already accepts a commit-pinned document, so
`contradictory-forum-answer` now accepts `github-commit` as well as
`internet-archive`. That is a provenance widening, recorded here rather than done
quietly: what the role accepts changed. The claim itself is unchanged in kind, and
the checker still proves the document, its revision, its blob identity, its date and
its bytes independently.

Scenario 2 corpus, all five roles verified against GitHub rather than assumed:

| Role | Document | Revision | Date |
|---|---|---|---|
| protocol-spec | `modelcontextprotocol/modelcontextprotocol` `docs/specification/2026-07-28/changelog.mdx` | `db4bfcff` | 2026-07-28 |
| official-migration | `modelcontextprotocol/typescript-sdk` `VERSIONING.md` | `e3f39c1a` | 2026-08-18 |
| legacy-vendor-tutorial | `microsoft/mcp-for-beginners` `01-CoreConcepts/README.md` (2025-11-25) | `8ccbf506` | 2026-02-05 |
| current-vendor-compatibility | `microsoft/mcp-for-beginners` `README.md` (2026-07-28) | `83af52c7` | 2026-09-04 |
| contradictory-forum-answer | `logiscape/mcp-sdk-php` `docs/migration-v2.md`, a community SDK guide asserting most v1 code runs on v2 unchanged | `398dee40` | 2026-07-28 |

Both scenarios then reported `blockers: none`, and `record-research-history-verification`
wrote a provenance record for each after comparing every pinned blob to its commit
and every archive capture to its CDX digest.

Candidates still failed the second scenario at 0.56 to 0.67 while passing the first
at 1.00. The cause was the skill, not the harness: it said nothing about carrying a
corpus's own integrity records into the answer. The skill now states that a supplied
corpus is the evidence base and its identifiers, digests and version scopes belong in
the report verbatim, that every role including the rejected one needs a verbatim
excerpt, that the controlling and the outdated source are named separately with the
version boundary that decides between them, and that a missing role is a limitation
rather than a gap to fill. Version 5.2.0 to 5.2.1.

After that revision, with qwen-3.8-27b:

| Round | Full-task passes | Open regressions |
|---|---|---|
| after the skill revision, round 1 | 1 of 2 | 0 |
| round 2 | 3 of 4 | 0 |

Blind review ingested (`blind-v5-63ef18b2e2acd09948a5`). `evaluateSkillPromotion`
now returns:

```
status ready
coverage {positive:5, negative:5, ambiguous:3, adversarial:3, full-task:2, regression:0}
reasons: none
```

Tests: 19 passing across the two suites, 1982 assertions, and `tsc --noEmit` clean.
