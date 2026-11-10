# Source map

## House style, 2026-09-06

The user requested authored prose without dashes. This preference is separate from grammar claims and does not alter exact source material, code, names, links, mathematical signs, or format syntax. Shared communication skills inherit the prose preference; the focused `dash-free-writing` child provides a rewrite workflow and a read only checker. Its source map records punctuation and Markdown distinctions. The preference does not override a later explicit style request or exact transcription.

`documents-communication` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound writing centered on the audience, release note mechanics, version semantics, and skill/eval design. The factual content of a document still comes from the task's supplied or separately verified evidence.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: root responsibility; narrower children dash-free-writing, executive-communication, instructional-communication, reference-communication, technical-communication.
- Routing: five positive, five negatives from near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Whole task evaluation: two individual scenarios with six falsifiable checks, pairing of the same model with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Digital.gov plain-language principles**: https://digital.gov/guides/plain-language/principles/
  - Type: `official-docs`
  - Scope: U.S. federal plain language principles as available 2026-10-17.
  - Use: define the audience, state purpose and bottom line early, organize for retrieval, and use active wording, lists, or tables when they help the reader.
  - Verified: 2026-10-17; refresh after 180 days.

- **Digital.gov test for understanding**: https://digital.gov/guides/plain-language/test/
  - Type: `official-docs`
  - Scope: U.S. federal plain language testing guidance as available 2026-10-17.
  - Use: test early, revise, and test again; distinguish paraphrase, usability, and comparative testing from unsupported claims about reader understanding.
  - Verified: 2026-10-17; refresh after 180 days.

- **Microsoft Writing Style Guide**: https://learn.microsoft.com/en-us/style-guide/welcome/
  - Type: `official-docs`
  - Scope: Microsoft public writing style and terminology guidance updated 2026-10-15 and inspected 2026-10-17.
  - Use: concise, consistent, technology communication centered on the reader; treated as a style reference rather than a factual source for the artifact subject.
  - Verified: 2026-10-17; refresh after 180 days.

- **GitHub release management**: https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
  - Type: `official-docs`
  - Scope: GitHub release and release note behavior as available 2026-10-17.
  - Use: release tag, previous tag, draft or prerelease, generated release note, and published release boundaries for repository release artifacts. Check the actual comparison range and source changes; the existence of generated notes does not prove they describe the shipped release.
  - Verified: 2026-10-17; refresh after 90 days.

- **Semantic Versioning 2.0.0**: https://semver.org/spec/v2.0.0.html
  - Type: `spec`
  - Scope: SemVer 2.0.0.
  - Use: public API and major/minor/patch semantics when a project explicitly follows SemVer; do not assume every repository does.
  - Verified: 2026-10-17; refresh after 365 days.

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills format as available 2026-10-17.
  - Use: concise discovery metadata and progressive disclosure.
  - Verified: 2026-11-03; refresh after 90 days.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill authoring guidance on `main` as inspected 2026-11-03.
  - Use: bounded triggers, narrow specialist separation, and behavioral validation.
  - Verified: 2026-11-03; refresh after 60 days.

- **Google developer documentation style guide**: https://developers.google.com/style
  - Type: `official-docs`
  - Scope: Google developer documentation style guidance last updated 2026-10-09 and inspected 2026-10-17.
  - Use: apply project specific guidance first, then authoritative style guidance; keep technical terminology, reader purpose, and document type distinct.
  - Verified: 2026-10-17; refresh after 90 days.

## Interpretation rules

- Preserve source facts and uncertainty before optimizing style.
- Match the target audience, medium, repository template, and reader action rather than applying one universal document structure.
- Treat house/vendor style guides as style guidance, not authority for domain facts.
- Verify release scope/tag/change claims against repository evidence when writing release notes.
- Do not infer SemVer or other versioning semantics unless the project declares that convention.
- Use [document workflows](document-workflows.md) for concrete release inventory reconciliation, exclusion and uncertainty boundaries, handoff conflict preservation, and observed recovery checks.

## Evaluation evidence that informed the workflows (read only, 2026-10-11)

These are observations of historical evaluation artifacts, not claims of current qualification or new review results:

- `backend/src/kory/skill-eval-repository-communication-fixtures.ts`: The local release fixture checks confirmed source terminology and PR references in the draft, excludes internal changes from the entire release document, and expects string IDs in `included`, `excluded`, and `uncertain` arrays. Machine format checks and editorial publication readiness are separate requirements.
- `backend/src/kory/skill-eval-sealed-evidence-fixtures.ts`: The synthetic handoff fixture exposes requirement descriptions as evidence records, not the named owners, notes, or runtime observations they describe. Its structural checks do not certify the content of a handoff or any product compatibility result.
- `.koryphaios/skills/blind-reviews/blind-v5-572f589b9154d9fae996.json`: Both release-note candidates failed the earlier blind review. It identified version/release boundaries, the risk of putting internal-only work in a customer-facing scope section, uncertainty presented as a known limitation, and missing observed recovery and final QA.
- `.koryphaios/skills/eval-artifacts/documents-communication-full-task-1-individual_d72be8bd-3c90-42b6-9b75-5e1d3b0c8162/with-skill/run-manifest.json`: The deterministic score failed confirmed-feature inclusion and structured provenance while other content checks passed. This motivated an item-by-item reconciliation step rather than relying on general completeness language.
- `.koryphaios/skills/blind-reviews/blind-v5-c74510bfa433424949df.json`: The handoff reviewer penalized the candidate for asserting an unsupported audience and inconsistent task-boundary terminology, despite otherwise credible handling of unknowns and recovery.
- `.koryphaios/skills/eval-artifacts/documents-communication-full-task-1-individual_78309df4-7c94-4053-ba77-24738d0158af/`: This later pair also failed in both variants. Its saved candidates show three transferable risks: describing the behavior while losing the canonical change name, converting ID arrays to object arrays, and presenting an intended improvement as an observed outcome despite unmeasured impact. These observations inform the source name, claim strength, and schema checks above; they do not establish a new qualification result.

The shared audit ledger recorded `documents-communication` as blocked on 2026-10-02 with a failed blind semantic review. The next qualification decision needs fresh, independent evidence; these authoring changes alone do not change that status.
