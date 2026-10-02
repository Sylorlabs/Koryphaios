---
name: literature-research
description: Synthesize scholarly or technical literature with explicit search, study-quality, publication-status, disagreement, and applicability checks. Use when the user asks for a literature, systematic, scoping, or state-of-the-art review grounded in research papers; not for single fact-checks, market research, repository tracing, or user research.
---

# Literature Research

Answer the research question from the scholarly record, not from paper titles or a vote count. Preserve enough search, selection, study, and synthesis evidence that another reviewer can understand why the conclusion follows and where it may fail.

## Workflow

1. Frame the question before searching. Record the population/system, intervention or exposure when relevant, comparator, outcomes, study designs, date window, disciplines, languages, and other inclusion/exclusion criteria that materially change the evidence set. Match the requested rigor: do not call an ad-hoc search a systematic review.
2. Search with more than one useful vocabulary. Combine natural-language terms with field terminology, controlled vocabulary where available, citation chaining, and known-author/venue searches when appropriate. Record the databases or indexes, query/date, and material filters. Search snippets and AI summaries are discovery aids, not study evidence.
3. Resolve the scholarly object before extracting claims. Distinguish preprint from peer-reviewed publication, conference from journal version, protocol from results paper, primary study from review, and multiple reports from the same underlying study. Check for corrections, expressions of concern, retractions, or materially newer versions when identifiers permit it.
4. Extract study-level evidence, not only conclusions. Capture design, sample or corpus, intervention/exposure, comparator, outcomes and effect measures, uncertainty, model/dataset/version where technical work depends on them, and limitations that affect internal validity or transferability.
5. Assess evidence quality using criteria appropriate to the domain and study design. Consider selection and measurement bias, confounding, attrition/missingness, multiplicity, preregistration or protocol deviations, benchmark leakage or non-independent test sets where relevant, statistical precision, conflicts of interest, and external validity. Use domain frameworks such as risk-of-bias tools or GRADE only when they fit the question; do not mechanically apply clinical frameworks to unrelated technical research.
6. Synthesize by evidence weight and comparability. Separate direct from indirect evidence, replicated from single-study findings, and peer-reviewed from provisional evidence. Do not treat paper count as confidence. Do not pool numerically incompatible studies merely to produce a meta-analytic number; statistical pooling may compose with `statistical-inference` when requested and justified.
7. Explain disagreement. Test whether apparently conflicting results differ because of population, task, outcome definition, intervention, baseline, model or dataset version, study design, analysis choice, time period, or publication status. Preserve unresolved contradictions rather than forcing consensus.
8. Report the search boundary, included evidence, material exclusions, quality/limitations, synthesis, confidence, applicability, and open questions. Cite study-level claims close to the evidence that supports them.

For a systematic review or reproducible search, follow PRISMA/PRISMA-S reporting concepts for transparent search and selection. PRISMA is a reporting framework, not proof that a review is methodologically sound. For health evidence where certainty ratings are requested, use outcome-specific GRADE concepts rather than assigning one blanket score to an entire topic.

## Boundaries

- Use `factual-research` for a discrete external claim such as a date, version, status, quotation, statistic, or policy fact. A literature task may compose with it when a paper's publication status or a specific external claim needs verification.
- Use `research` for broad exploratory synthesis that is not centered on scholarly studies or evidence quality.
- Use `market-competitive-research` for vendors, buyers, pricing, adoption, market structure, and competitive positioning; academic papers do not turn a market task into a literature review.
- Use `repository-research` when the truth must be established from the actual codebase, configuration, history, or runtime rather than publications.
- Use `user-research` for interviews, observation, fieldwork, surveys, and qualitative evidence gathered from users.
- Use `statistical-inference` for substantive re-analysis, effect-size computation, meta-analysis, or statistical modeling when that is the requested center of gravity; `literature-research` still owns study discovery, eligibility, and evidence-quality synthesis.

## Failure and recovery

- If full text is unavailable, distinguish abstract-only evidence from full-text assessment and lower confidence accordingly.
- If only one database/index can be searched, state the coverage limitation instead of implying comprehensive retrieval.
- If the literature is too heterogeneous for a single effect conclusion, provide structured subgroup or mechanism-level synthesis.
- If publication status or a correction/retraction cannot be resolved, flag the affected study rather than silently treating it as current.
- If the evidence set is sparse, conflicting, or dominated by weak designs, say that the literature is inconclusive and identify what evidence would change the conclusion.

Read [the maintained source map](references/sources.md) when auditing or refreshing the methodology, standards, or source provenance for this skill.
