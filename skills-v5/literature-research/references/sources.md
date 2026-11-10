# Source map

`literature-research` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound its literature-search transparency, study-quality assessment, publication-status checks, evidence synthesis, and skill/eval design. Refresh standards and database behavior when version-sensitive details matter.

## Evidence-synthesis method sources

- **PRISMA 2020**: https://www.prisma-statement.org/prisma-2020
  - Type: `official-docs`
  - Scope: PRISMA 2020 systematic-review reporting guidance and current official materials as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.
  - Provenance: PRISMA Executive official site; paraphrased, not copied.
  - Relevance: transparent reporting of review rationale, methods, selection, results, and flow. It is treated as reporting guidance, not a substitute for methodological-quality assessment.

- **PRISMA-S**: https://www.prisma-statement.org/prisma-search
  - Type: `official-docs`
  - Scope: PRISMA-S literature-search reporting extension, published 2021 and current on the official site as inspected 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.
  - Provenance: PRISMA Executive official site; paraphrased.
  - Relevance: supports recording search sources, strategies, dates, and retrieval/selection details rather than presenting an opaque search result.

- **Cochrane Handbook for Systematic Reviews of Interventions, version 6.5**: https://training.cochrane.org/handbook/current
  - Type: `official-docs`
  - Scope: Cochrane Handbook v6.5 (2024), including question framing, inclusion criteria, searching, risk of bias, synthesis, meta-analysis, GRADE, interpretation, and updating.
  - Verified: 2026-09-05; refresh after 180 days.
  - Provenance: Cochrane official handbook; methodology adapted at a principle level rather than copied.
  - Relevance: supports pre-specified eligibility, study-level extraction, bias assessment, careful synthesis, and avoiding premature or inappropriate pooling.

- **GRADE Working Group**: https://www.gradeworkinggroup.org/
  - Type: `official-docs`
  - Scope: GRADE certainty-of-evidence concepts as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.
  - Provenance: GRADE Working Group official site; paraphrased.
  - Relevance: supports outcome-specific certainty judgments and explicit consideration of risk of bias, imprecision, inconsistency, indirectness, and publication bias when GRADE is appropriate to the domain.

- **NLM PubMed Help**: https://pubmed.ncbi.nlm.nih.gov/help/
  - Type: `official-docs`
  - Scope: current PubMed search behavior, Search Details, MeSH, filters, and publication-type metadata as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.
  - Provenance: U.S. National Library of Medicine; paraphrased.
  - Relevance: supports inspectable search translation, controlled-vocabulary expansion, and distinguishing publication types instead of treating every indexed record as the same kind of evidence.

- **Crossref Crossmark**: https://www.crossref.org/services/crossmark/
  - Type: `official-docs`
  - Scope: Crossref publication-update metadata service as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.
  - Provenance: Crossref official documentation; paraphrased.
  - Relevance: supports checking whether a scholarly object has been corrected, retracted, or otherwise updated rather than assuming the first PDF found is the current record.

## Skill-authoring and competitive-pattern sources

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills metadata and progressive-disclosure format as available 2026-09-05.
  - Verified: 2026-11-03; refresh after 90 days.
  - Relevance: keeps discovery metadata discriminating and detailed execution guidance inside the skill body.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill-authoring guidance on `main` as inspected 2026-11-03.
  - Verified: 2026-11-03; refresh after 60 days.
  - Relevance: supports focused triggers, progressive disclosure, narrow corrections from observed failures, and behavioral validation rather than prose-only checks.

- **Anthropic: Agent Skills architecture**: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
  - Type: `official-docs`
  - Scope: Anthropic Agent Skills architecture guidance as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.
  - Relevance: corroborates metadata-first discovery and loading detailed references only when the task needs them.

- **Cursor: Rules**: https://docs.cursor.com/context/rules
  - Type: `official-docs`
  - Scope: Cursor scoped instruction guidance as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.
  - Relevance: competitive pattern for concise, scoped, composable instructions rather than large generic context dumps.

## Stewardship conclusions

- A literature review is defined by an evidence question plus scholarly retrieval, selection, and synthesis, not by the presence of the words “paper” or “research”.
- Search transparency and publication-status checks are first-class evidence, especially for time-sensitive technical fields where preprints and later versions coexist.
- Study quality and applicability must be assessed at the study or outcome level before drawing a body-of-evidence conclusion.
- Systematic-review labels require reproducible search and selection discipline; a fast narrative scan must be labeled as such.
- Conflicting studies should be reconciled through design, population, outcome, version, and analysis differences rather than majority vote.
- Community or vendor-authored patterns may improve ergonomics but never outrank primary scholarly records or domain standards for evidence claims.
