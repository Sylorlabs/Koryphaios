---
name: documents-communication
description: Create or revise source-faithful documents such as release notes, reports, handoffs, proposals, memos, and Markdown. Use when a document deliverable needs audience, structure, format, source boundaries, or publication readiness; compose technical, executive, instructional, or reference specialists for narrower work.
---

# Documents Communication

Make a reusable document useful to its reader and faithful to its evidence. Better prose never justifies changing facts, inventing certainty, or erasing source/version boundaries.

## Operating contract

1. Identify audience, purpose, reader action, target medium, required sections, length/tone, publication surface, and existing template/convention.
2. Establish the evidence boundary. Separate supplied facts, assertions, derived conclusions, assumptions, unknowns, and proposed language. A rewrite limited to the supplied corpus must not silently research or “correct” facts.
3. Structure around reader needs: lead with the most useful context, group related material, use meaningful headings, and use lists/tables only when they improve scanning or comparison.
4. Draft directly with stable terminology and explicit actors/actions. Preserve consequential dates, versions, qualifiers indicating when information was current, references, owners, decisions, and uncertainty from the source.
5. Match the requested/repository format instead of inventing a new template. Review for factual drift, omissions, contradictions, duplication, ambiguous references, undefined terms, broken links, and incomplete reader actions.
6. If claims depend on repository state or current external facts, use the appropriate evidence/research skill first. Writing is not verification.

## Routing boundaries

Select this parent when the requested outcome is a reusable document or a substantive rewrite and no narrower document purpose owns the whole deliverable. Compose the narrowest child for the dominant reader job: `technical-communication` for design, architecture, incident, or engineering explanation; `executive-communication` for leadership status, options, risk, or an explicit decision; `instructional-communication` for ordered procedures with prerequisites, branches, recovery, and completion checks; `reference-communication` for exhaustive lookup fields, defaults, constraints, errors, or version scope; and `dash-free-writing` for a punctuation specific rewrite. The parent still supplies shared evidence, audience, structure, and format discipline when a child is composed.

Keep adjacent responsibilities separate. Use repository or factual research to establish current implementation or external facts, then return here to turn verified findings into the document. Use implementation or debugging skills for code outcomes when no document is requested. Use accessibility practice or accessibility verification only when accessibility design, testing, or audit is itself requested. Use release planning for sequencing and delivery decisions; use this skill for the release note artifact. A request to extract, calculate, answer, or inspect without producing a document does not activate this skill merely because the source is a document.

## Evidence and reader contract

Before drafting, record the actual audience, medium, version or date scope, required sections, reader action, and source boundary. Label an unsupported audience or purpose as unresolved or inferred; do not substitute the document's maintainers or reviewers for its intended readers. For every consequential claim, keep its source identifier and the evidence state: confirmed, inferred, disputed, superseded, or unavailable. A source identifier or timestamp is evidence of where a claim came from, not proof that the claim is true or current.

For changes across multiple sources, reconcile a source inventory against the final document. Every confirmed fact within scope needs a destination; every exclusion or unresolved fact needs a reason. Preserve the declared keys and value types in any structured evidence map, and keep its source IDs and status groups consistent with the document. Read the starter artifact or explicit schema before editing: an array of source ID strings must stay an array of strings, even when richer objects would make explanations easier. Check element types, source coverage, and mutually exclusive classifications after writing; valid JSON alone is insufficient. Do not modify fixed source packets. Use [the release note and handoff playbook](references/document-workflows.md) for the detailed sequence and checks.

## Release notes

Establish the target release identity and the exact tag or commit boundary between the previous release and the target before classifying changes. Check the actual range and diff against merged PRs and issues; merge metadata and generated summaries alone cannot establish shipment. Inventory all changes, then explicitly decide which are confirmed reader visible features, fixes, breaking changes, internal changes, or changes whose user impact remains unverified. Include each confirmed reader visible feature and fix once in the correct release, retaining its recognizable source name as a contiguous phrase alongside the explanation for readers. Paraphrasing the behavior alone can erase the feature's traceable identity. Keep internal changes out of every customer section, including scope notes. An internal-only change leaves no trace in the note artifact at all: do not name it, its source ID, or its title in a customer section, scope note, appendix, changelog stub, or editorial hold. Record it only in the evidence map's excluded list, and treat every excluded ID as absent from the note's text. The editorial hold names uncertain IDs only, never an excluded or internal item. Separate implementation evidence from measured impact: a PR title describing an intended outcome cannot establish that the outcome occurred. Do not present uncertain benefit or impact as a confirmed feature or known limitation without supporting evidence. An uncertain item must not be placed under **Known limitations**, and its presence must not be converted into a blanket statement that there are no known limitations. When an inventory includes uncertain items and the output is a working draft of the release note, add a clearly marked **Editorial hold (draft only, not for publication)** outside the publishable sections. Name every uncertain source ID there, say what impact is unconfirmed and what evidence would be needed, and explicitly hold publication of that claim. An evidence map listing the ID does not replace this note in the draft. Remove or resolve the hold before publication.

Use the repository's release note template and source links. Reconcile the complete inventory, the release prose, and any evidence map item by item before calling the draft complete. If the release boundary or required proof is absent, mark the affected claims pending and hold publication rather than backfill a plausible version or impact.

## Project handoffs

Use dated, attributed notes to identify the current state, decisions, decision owners, open questions, next actions, and relevant links. Retain superseded duplicates as history rather than current facts; display unresolved contradictions side by side with their source IDs and resolution owner. Preserve unknown fields explicitly. A packet describing the kinds of notes it should contain is not evidence of those notes or their values; record the missing inputs and block unsupported publication. Neither a more recent note nor a polished handoff alone proves that a conflict was resolved.

## Verification and recovery

Record what was actually checked: reader and format contract; source to claim reconciliation; structure and reader action; factual, version, and format QA. For release notes, check that every confirmed item retains its source ID and exact recognizable name, and that each claimed outcome has evidence beyond an intention or title. Separately parse evidence maps and validate field and element types against the supplied contract. Exercise an available negative or partial state (for example an incomplete starter document, missing tag, ambiguous impact, conflicting owner, or missing source), show the observed safe result, and specify the evidence needed to recover. When fixing an incomplete artifact, rerun the same checks to show which failures were repaired. Recheck the affected artifact after recovery; if inputs are still missing, report recovery as pending or unobserved. Structural checks, compilation, an authored validator, and evidence map schema validation do not prove semantic accuracy. Never report an independently verified pass from an authored checklist or unexecuted procedure.

From this skill directory, run the local contract check before handing off changes: `bun scripts/check-contract.ts`. It checks the package's local metadata, routing counts and polarity, held-out leakage, task check IDs, scorer weights, source references, and required resource links. A pass proves package shape only; it does not prove a document's factual accuracy or promotion qualification.

## Specialist boundaries

- `technical-communication`: technical reasoning/design/reporting, including technical release content when needed. `executive-communication`: decision/status/risk/ask framing. `instructional-communication`: executable procedures and runbooks. `reference-communication`: lookup oriented exact fields/defaults/errors/version scope. This parent owns shared factual, audience, structure, and format discipline. `accessibility-practice` and `accessibility-verification` remain separate concerns unless the user requests their work.

## House style

For newly authored prose, use sentences, commas, colons, parentheses, or conjunctions instead of dash punctuation. Write ranges with words and rephrase compounds when needed. This is the requested house style, not a rule that dashes are invalid in other writing. Preserve exact quotations, names, technical tokens, code, links, mathematical signs, and required document syntax. A task that explicitly requests another style or exact reproduction takes precedence. Use `dash-free-writing` for a focused punctuation rewrite or inspection of mixed prose and technical content; never strip characters globally.

## Failure and recovery

Preserve source conflicts unless evidence resolves them. Use surrounding conventions when audience/format is implicit. Mark missing facts or placeholders instead of fabricating them. For rewrites that preserve meaning, semantic fidelity outranks stylistic novelty.

Use [the maintained source map](references/sources.md) when refreshing writing, release note, or skill authoring guidance.
