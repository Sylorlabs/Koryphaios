# Document workflows: release notes and handoffs

Use these checks when a document aggregates repository changes or a dated evidence packet. They make omission and evidence drift observable. They are authoring instructions, not independent verification results.

## Contract card before drafting

Write a short contract card before changing the artifact:

| Field                | Record                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Reader and action    | Who will read this, and what should they do or understand next?                                          |
| Medium and lifecycle | File or publication surface, template, target version or date, and draft or published state              |
| Evidence boundary    | Supplied packet, repository range, verified external sources, or closed corpus                           |
| Ownership            | Author, approver, unresolved owner gaps, and decision owner where applicable                             |
| Output contract      | Required files, headings, structured fields, citations, and fixed inputs                                 |
| Stop condition       | Missing boundary, missing source, unresolved contradiction, or unsupported claim that blocks publication |

Do not fill an unknown field with the evaluator, maintainer, most recent author, or likely audience. If the task does not supply a reader or purpose, mark it unresolved and make the document's blocked state part of the output.

## Release notes from repository evidence

1. **Identify the publication contract.** Read the existing changelog or release template and release configuration. Determine intended readership, medium, target version, release status, required sections, previous published version, and exact comparison endpoints. If a tag is missing or a version is a draft, state that; do not silently choose a substitute. Only apply SemVer change meanings when the project declares SemVer.
2. **Construct the release inventory.** Enumerate commits and changed files in the confirmed comparison range. Match those commits to merged PRs, issues, and release metadata. A PR merged after the target tag, a change included in an earlier release, and a change present only on the default branch are not automatically part of the target release. Investigate discrepancies instead of relying on generated release notes or PR titles.
3. **Decide per item using actual implementation evidence.** For each candidate, record the source's canonical change name, commit or diff, PR or issue ID, version scope, what demonstrably changed, whether users can observe it, and its status. Keep separate columns for an observed implementation and a measured customer outcome: a PR title or a diff showing a change does not verify a claimed performance, reliability, adoption, or user benefit. Distinguish feature, fix, breaking change, internal change, and unverified impact. Check that each confirmed feature and fix has a customer entry, including less prominent fixes; do not drop an item simply because the summary highlights another change.
4. **Maintain two boundaries.** The customer document includes confirmed relevant changes and supported known limitations. The internal evidence inventory can also list internal work and uncertain impact as excluded or pending with reasons. Excluding an internal change means excluding it from **every** part of the customer document, even a section titled Scope, Other changes, or Notes. A change with uncertain user impact should not appear as a released feature or known limitation based solely on a speculative description. Do not turn a proposed benefit in its title into a reported outcome. For a reviewable working release-note draft with uncertain inventory rows, append a clearly labeled **Editorial hold (draft only, not for publication)** outside the publishable template sections. Identify _each_ uncertain source ID, the unconfirmed impact, evidence needed, and its publication hold. Explicitly mention those IDs in the draft even if an accompanying evidence map already classifies them as uncertain; an evidence map alone cannot communicate open editorial actions to the reviewer of the draft. Resolve or remove the hold before publishing. For example: `Editorial hold: CHG-D has unconfirmed reader impact; obtain supporting evidence before publication.` Do not claim that there are no known limitations merely because the supplied evidence documents none.
5. **Draft to the existing template.** Use the actual target version in the heading and any required release date or status. Distinguish breaking behavior from fixes and improvements. Cite the PR, issue, commit, or diff in the convention the project uses. Keep each confirmed feature's or fix's source name intact as a recognizable, contiguous phrase alongside a plain language explanation: if the verified change is named `shared drafts`, do not replace that name solely with `collaborators can work on the same text`. Describe observable changes without unsupported adoption, compatibility, performance, or customer benefit claims. Run a source name and ID coverage check independently of any prose quality review.
6. **Reconcile before publication.** Compare every inventory row to the draft and every included claim back to evidence. If a separate evidence map exists, inspect its starter file or explicit schema and preserve its keys, value types, and classifications. For an ID array contract such as `{"included":["CHG-A","CHG-B"],"excluded":["CHG-C"],"uncertain":["CHG-D"]}`, put primitive strings in those arrays, not objects containing an `id` key. Validate that every expected bucket is an array of its required element type, each source ID occurs in exactly one appropriate bucket, and no source ID is missing or invented. Put explanations in a separately permitted field or verification prose. Keep fixed source packets intact. Independently check the previous to target release boundary, exact source terms and IDs for each confirmed feature and fix, exclusion of internal changes anywhere in customer text, and separation of observed results from unmeasured impact. Verify handling of uncertain sources, citations, and template integrity. A custom validator can miss requirements it never tests; passing it, or successfully parsing JSON, does not establish semantic correctness. Record the actual format check and factual, structure, and reader action reviews separately.

For a partial starter, capture the initial state before repairing it. For example, record that the note contains `TODO` and that the evidence arrays are empty, then rerun the same checks after drafting. A repaired structure is recovery evidence; it is not evidence that the product outcome or reader impact is true.

### Example evidence inventory (illustrative, not an evaluation result)

| Source                 | Release evidence                        | Classification    | Reader document       | Evidence state              |
| ---------------------- | --------------------------------------- | ----------------- | --------------------- | --------------------------- |
| CHG-A, commit `abc123` | Implemented and present in target range | Confirmed feature | Highlights, once      | Confirmed after diff review |
| CHG-B, commit `def456` | Fix present in target range             | Confirmed fix     | Fixes, once           | Confirmed after diff review |
| CHG-C, commit `789abc` | Refactor with no shown user impact      | Internal only     | Exclude entirely      | Excluded with reason        |
| CHG-D, commit `123def` | User impact not measured                | Uncertain impact  | Hold pending evidence | Unverified                  |

Do not treat example source IDs as real repository evidence. The artifact must derive its own IDs, classifications, and version boundary from the task's files.

Where the starter artifact is an incomplete placeholder, inspect and record that failure before repairing it. After writing the notes and evidence map, repeat the same completeness, source trace, and format checks and record their actual results. A repaired document can demonstrate recovery from missing content while uncertain product impact remains unverified. Never describe that remaining uncertainty as recovered.

## Handoff from a closed packet

1. Record the intended recipient and action if actually supplied; otherwise label audience unresolved and purpose inferred where appropriate. Identify the existing Markdown template and section conventions.
2. Inventory each dated note by source ID, subject, owner, date, and evidence state. Distinguish observations and decisions from proposals. Track where a newer item explicitly supersedes a duplicate; keep the old item available as historical evidence without presenting it as current.
3. For contradictions, quote or paraphrase both claims accurately, include their dates and source IDs, name the resolution owner if known, and state the unresolved question. Do not choose the newer assertion merely because it is later. Preserve empty dates, owners, versions, or other unknown fields as unknown rather than assigning likely values.
4. Fill the requested template with current state, decisions and rationale, named owners, blockers, open questions, source links, and next steps with an action owner or an explicit owner gap. Distinguish the packet's history from what is active.
5. Trace each material statement back to a source. Recheck the superseded duplicate, at least one contradiction, and every unknown field in the final handoff; confirm the source map agrees with the prose. Do not invent an audience, deadline, outcome, or compatibility claim to complete the template.

If two records conflict, keep both claims visible in the internal trace, state which one is used as current only when a source explicitly supersedes the other, and assign the resolution question to a named owner or record an owner gap. A newer timestamp is a sorting fact, not a resolution decision.

If the packet only says that a dated note, named owner, decision, contradiction, or template exists, but supplies no values, that description cannot establish the missing facts. An evidence record ID attached to such a description identifies the description, not the absent project note. Create an evidence bounded handoff describing the blocked authoring state and the exact inputs needed for completion. Name the handoff's actual reader only if supported; the person evaluating or maintaining the document is not automatically the intended reader of the requested release notes. A task title or generic mention of compatibility cannot establish versions, supported runtimes, or observed product behavior.

## Success, failure, and recovery evidence

- **Success path:** name the actual source inputs and reader contract, then show coverage of the documented, supported claims and required sections. Formatting and evidence-map checks are useful but cannot independently establish factual correctness.
- **Negative path:** attempt to reconcile one material gap, such as a missing previous tag, an implementation claim without a diff, conflicting source records, or an unknown owner. Record the observed evidence, the claim withheld, and the document's safe pending or blocked state. Do not manufacture a failure just to fill a report.
- **Recovery path:** obtain the missing source, resolve the contradiction with an accountable decision, repair an incomplete document using provided evidence, or correct the boundary. Repeat the affected claim and document checks, noting the evidence and actual result. A proposed recovery procedure is not an executed recovery; if the dependency remains unavailable, give the recovery steps and report that success was **not observed**.
- **Final verification:** distinguish checks personally executed on the artifact, source or repository evidence independently inspected, and review still pending. Map candidate documents and candidate verification separately from paired evaluation artifacts owned by an external evaluator; record those external artifacts as external, without fabricating their results. Do not promote a checklist, JSON schema pass, generated document, paired evaluation file, or hypothetical test to an observed semantic or publication pass.

## Local contract check

This package includes `scripts/check-contract.ts`. Run it from this skill directory with `bun scripts/check-contract.ts`. It is deliberately local and deterministic: it does not call the network, mutate source packets, write evaluation ledgers, run model evaluation, or substitute schema validity for semantic review. Keep its checks narrow when the package contract changes, and make any new output requirement observable in the task fixture before adding a check.
