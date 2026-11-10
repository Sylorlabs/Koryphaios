---
name: literature-research
description: Synthesize scholarly or technical literature with explicit search, study-quality, publication-status, disagreement, and applicability checks. Use when the user asks for a literature, systematic, scoping, or state-of-the-art review grounded in research papers; not for single fact-checks, market research, repository tracing, or user research.
---

# Literature Research

Answer the research question from the scholarly record, not from paper titles or a vote count. Preserve enough search, selection, study, and synthesis evidence that another reviewer can understand why the conclusion follows and where it may fail.

When the report's source records are schema-checked, treat every row as the same seven key record and verify it against the bytes you actually saved, because these checks are per source and one sloppy row fails the whole report:

1. `id`, exactly the identifier the task's source list uses, one row per identifier, no duplicates, no omissions, no extra rows for a source you decided not to cite.
2. `url`, exactly the URL you requested, not a canonicalised or shortened form of it.
3. `status`, the numeric HTTP status the server returned for that request.
4. `retrievedAt`, a UTC timestamp inside the freshness window the task states.
5. `sha256`, the digest of the response body bytes as fetched, never of a re-rendered, normalised, summarised or translated copy of them.
6. `lastModified`, the response's own `Last-Modified` header value copied verbatim, or null when the response carried none. Do not infer, reformat to a different precision, or synthesise a date you did not receive.
7. `excerpts`, between one and eight distinct quotations, each at least a full sentence long and each a contiguous substring of the saved body, proven by containment against the stored text before you report them.

An endpoint that fails is still a row: record its real status and the metadata you did receive rather than dropping it, and never substitute a different endpoint for the one the task named. Keep the raw response bodies you hashed until the report is accepted, so every digest and quotation can be re-derived from them.

## Workflow

1. Frame the question before searching. Record the population/system, intervention or exposure when relevant, comparator, outcomes, study designs, date window, disciplines, languages, and other inclusion/exclusion criteria that materially change the evidence set. Match the requested rigor: do not call an ad hoc search a systematic review.
2. Search with more than one useful vocabulary. Combine natural-language terms with field terminology, controlled vocabulary where available, citation chaining, and known-author/venue searches when appropriate. Record the databases or indexes, query/date, and material filters. Search snippets and AI summaries are discovery aids, not study evidence.
   When a task requires live retrieval, keep an audit trail for each authoritative source: exact requested URL and query, actual HTTP status, retrieval time, response hash, available last-modified metadata, and a small verbatim excerpt anchored to the retrieved bytes. An excerpt is a contiguous, character-exact substring of the bytes you saved, long enough to be meaningful as a sentence fragment, and each one is independently checkable: never stitch two passages together with an ellipsis or a bracketed insertion, never reflow or re-punctuate the source, and never quote from memory or from a search-result snippet instead of the fetched body. Keep a handful of short excerpts per source rather than one long block, deduplicate them, and prove the anchor by testing that each excerpt is contained in the stored response text before you report it. Record search result totals, eligible study identifiers, and concrete exclusions before drawing conclusions. A URL or citation without proof of the response received is insufficient for reproducible live-source verification.
3. Resolve the scholarly object before extracting claims. Distinguish preprint from peer-reviewed publication, conference from journal version, protocol from results paper, primary study from review, and multiple reports from the same underlying study. Check for corrections, expressions of concern, retractions, or materially newer versions when identifiers permit it.
4. Extract study-level evidence, not only conclusions. Capture design, sample or corpus, intervention/exposure, comparator, outcomes and effect measures, uncertainty, model/dataset/version where technical work depends on them, and limitations that affect internal validity or transferability.
   For each included primary study, preserve the exact title, publication date and version/status, access level (abstract versus full text), stable identifier, all independent source identifiers consulted, and an abstract excerpt verified against the source. Map each included study back to the recorded search and distinguish the primary study from secondary commentary.
5. Assess evidence quality using criteria appropriate to the domain and study design. Consider selection and measurement bias, confounding, attrition/missingness, multiplicity, preregistration or protocol deviations, benchmark leakage or non-independent test sets where relevant, statistical precision, conflicts of interest, and external validity. Use domain frameworks such as risk-of-bias tools or GRADE only when they fit the question; do not mechanically apply clinical frameworks to unrelated technical research.
6. Synthesize by evidence weight and comparability. Separate direct from indirect evidence, replicated from single-study findings, and peer-reviewed from provisional evidence. Do not treat paper count as confidence. Do not pool numerically incompatible studies merely to produce a meta-analytic number; statistical pooling may compose with `statistical-inference` when requested and justified.
7. Explain disagreement. Test whether apparently conflicting results differ because of population, task, outcome definition, intervention, baseline, model or dataset version, study design, analysis choice, time period, or publication status. Preserve unresolved contradictions rather than forcing consensus.
8. Report the search boundary, included evidence, material exclusions, quality/limitations, synthesis, confidence, applicability, and open questions. Cite study-level claims close to the evidence that supports them.
   When the task requests a reproducible artifact, save its structured source/search/study records and a human-readable cited report plus a verification log. Verify the requested files exist and contain real results, provenance, exclusions, and caveats before finishing. Document both a failed retrieval test and its successful authoritative recovery when recovery is part of the task; do not treat an unobserved retry as evidence.

For a systematic review or reproducible search, follow PRISMA/PRISMA-S reporting concepts for transparent search and selection. PRISMA is a reporting framework, not proof that a review is methodologically sound. For health evidence where certainty ratings are requested, use outcome-specific GRADE concepts rather than assigning one blanket score to an entire topic.

## Boundaries

- Use `factual-research` for a discrete external claim such as a date, version, status, quotation, statistic, or policy fact. A literature task may compose with it when a paper's publication status or a specific external claim needs verification.
- Use `research` for broad exploratory synthesis that is not centered on scholarly studies or evidence quality.
- Use `market-competitive-research` for vendors, buyers, pricing, adoption, market structure, and competitive positioning; academic papers do not turn a market task into a literature review.
- Use `repository-research` when the truth must be established from the actual codebase, configuration, history, or runtime rather than publications.
- Use `user-research` for interviews, observation, fieldwork, surveys, and qualitative evidence gathered from users.
- Use `statistical-inference` for substantive reanalysis, effect size computation, meta analysis, or statistical modeling when that is the requested center of gravity; `literature-research` still owns study discovery, eligibility, and the synthesis of evidence quality.

## Failure and recovery

- If full text is unavailable, distinguish abstract-only evidence from full-text assessment and lower confidence accordingly.
- If only one database/index can be searched, state the coverage limitation instead of implying comprehensive retrieval.
- If the literature is too heterogeneous for a single effect conclusion, provide structured subgroup synthesis or synthesis at the mechanism level.
- If publication status or a correction/retraction cannot be resolved, flag the affected study rather than silently treating it as current.
- If the evidence set is sparse, conflicting, or dominated by weak designs, say that the literature is inconclusive and identify what evidence would change the conclusion.
- For a time-limited live search, allocate time to retrieval, verification, and deliverable creation up front. Stop repeated low-value lookups in time to produce the required auditable source/study records and final synthesis. For source outages, record actual failure and retry evidence, preserve already verified sources, and finish with precisely identified gaps rather than claiming a completed retrieval.
- When borrowing findings from another field, state explicitly why the evidence is indirect for the target setting, which mechanisms might transfer, and which population, intervention, outcomes, and execution details prevent direct generalization.

Read [the maintained source map](references/sources.md) when auditing or refreshing the methodology, standards, or source provenance for this skill.
