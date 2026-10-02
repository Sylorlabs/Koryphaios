---
name: executive-communication
description: Turn evidence into leadership decisions, status, risks, and explicit asks without hiding uncertainty. Use when producing an executive brief, board summary, leadership update, or decision memo; not for technical design, procedural instruction, or analysis without that artifact.
---

# Executive Communication

Compress evidence into the smallest artifact that still lets the intended decision-maker understand what changed, why it matters, what is uncertain, and what action is needed.

## Workflow

1. Identify the audience, decision or status question, decision deadline, expected action, and evidence cutoff/as-of date. Preserve the organization's established format when one exists.
2. Lead with the outcome: recommended decision, current status, material change, or required ask. A reader should not need to search the document to learn why it exists.
3. Tie evidence to business/mission impact. Use the few metrics, customer/user effects, delivery facts, cost/capacity implications, and dependencies that materially change the decision. Do not dump implementation detail merely because it is available.
4. Separate evidence classes explicitly:
   - `actual`: measured or completed;
   - `forecast`: expected future result with time horizon/assumptions;
   - `scenario`: conditional outcome;
   - `recommendation`: judgment based on evidence;
   - `unknown`: unresolved evidence gap.
     Never present forecast or scenario values as realized facts.
5. Frame options and tradeoffs. For a decision memo, state viable options, decision criteria, cost/benefit, risk, reversibility, timing, dependencies, and recommendation. Avoid fake balance: omit dominated options when evidence establishes that they are not viable, but say why.
6. Make risk operational. State probability/likelihood only when supported, impact, trigger or leading indicator, mitigation, owner, and residual risk when these are known. Avoid vague labels such as “high risk” without the consequence that matters.
7. Make asks executable: exact decision/resource/escalation needed, owner/decision-maker, due date, and consequence of delay when supported.
8. Review compression against the source packet. Every material number, status color, date, forecast, and causal claim must be traceable. Keep dissent, confidence limits, and unresolved dependencies that could alter the decision.

## Boundaries

- `documents-communication` supplies the inherited factual, audience, and format discipline.
- `technical-communication` owns technical mechanism, architecture, engineering evidence, and implementation detail. Pull only the subset that changes executive impact, risk, cost, timing, or the decision.
- `business-case-analysis` owns alternatives, strategic fit, and the approval recommendation; `financial-modeling` owns linked quantitative models and their integrity. This skill communicates the decision from their verified evidence.
- `project-program-management` owns the operating plan, dependency/owner tracking, and delivery controls; this skill compresses material program state for leadership.
- `market-strategy`, `product-management`, and related skills own the underlying strategic recommendation. This skill does not create evidence merely to fill an executive template.
- `instructional-communication` and `reference-communication` own procedures and lookup material respectively.

## Failure and recovery

- If no explicit decision is required, lead with status/outcome and next expected decision rather than inventing an ask.
- If forecasts disagree, show the range/scenarios and the assumptions that explain it rather than averaging incompatible models.
- If a red/yellow/green status is requested but thresholds are undefined, use evidence-backed plain-language status or clearly label the rubric assumption.
- If the evidence packet cannot support a claimed business impact, preserve the unknown instead of converting technical activity into value.
- If detail is important but too deep for the main brief, put it in an appendix/source link and keep the decision trace in the primary artifact.

Use [the maintained source map](references/sources.md) when refreshing executive-writing or skill-authoring guidance.
