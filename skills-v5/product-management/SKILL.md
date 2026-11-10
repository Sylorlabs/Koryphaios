---
name: product-management
description: Make product decisions from customer problems, evidence, strategy, and measurable outcomes. Use when prioritizing products, defining a roadmap, writing a product brief, or setting learning criteria; not for delivery scheduling, research execution, analytics, or implementation alone.
---

# Product Management

Own the product decision, not every adjacent discipline. Translate evidence about users, the product, the market, the business, and technical or policy constraints into a bounded choice about what outcome to pursue, what to prioritize, what to ship or withhold, and what evidence should change the decision.

## Decision workflow

1. Frame the decision before proposing scope: target users or segment, problem/opportunity, current behavior or baseline, strategic context, material constraints, time horizon, and the decision that must be made.
2. Build an evidence ledger from the strongest available inputs: user research, product analytics, support/sales/customer-success signals, market evidence, technical feasibility, legal/safety constraints, and business economics. Distinguish observed facts from assumptions, confidence, contradictions, and missing evidence.
3. Define the desired user and business outcome before feature requirements. State the baseline when known, target or decision threshold, leading and lagging measures, and guardrails that would make apparent success unacceptable.
4. Compare viable options, including smaller experiments, process changes, deferral, or choices that require no build when they are credible alternatives. Evaluate value, evidence strength, effort, risk, dependencies, reversibility, strategic fit, and learning value without turning uncertain inputs into fake precision.
5. Prioritize under real capacity and commitments. Make opportunity cost explicit: choosing one item means declining, delaying, or narrowing another. A product roadmap priority is not a delivery schedule; do not invent dates from prioritization alone.
6. Define the next learning loop. For a release or limited rollout, state the conditions for expand, iterate, hold, stop, or rollback and the evidence window needed to reassess.
7. Preserve decision rationale: assumptions, confidence, rejected alternatives, unresolved decisions, owners where known, and the next evidence check.

## Product briefs and PRDs

When the requested artifact is a product brief or PRD, cover the problem and context, users/jobs, goals and non-goals, outcome and guardrail metrics, required behavior and scope, important states or edge cases, assumptions, dependencies, risks, rollout/learning plan, and unresolved product decisions. Requirements should trace to the framed problem or an explicit constraint rather than to stakeholder volume.

Do not smuggle implementation architecture, project schedules, or detailed research protocols into the PRD unless the task explicitly asks for those adjacent outputs.

## Launch and roadmap decisions

For launch, expansion, iteration, or stop decisions, compare actual outcomes to the original hypothesis and thresholds. Preserve segment differences, representativeness limits, reliability/cost/safety guardrails, and observational or experimental limitations. A positive topline metric does not erase a violated guardrail.

For roadmaps, express sequencing in the least speculative form supported by evidence and capacity, such as now/next/later or ranked opportunities. Separate committed delivery dates from product priority unless delivery evidence actually establishes both.

## Boundaries

- `product-analytics` owns instrumentation, querying, funnel/cohort analysis, and analytical evidence production.
- `user-research` owns planning and conducting primary qualitative research.
- `market-strategy` owns market selection, competitive positioning, and market entry strategy.
- `project-program-management` owns milestones, schedules, dependency tracking, resource coordination, and delivery governance.
- Engineering or `implementation` owns code changes and technical execution.
- `pricing-monetization` owns pricing and packaging mechanics.
- `business-case-analysis` owns detailed financial modeling and investment cases.

Compose with those skills when the user asks for both outputs, but keep the product decision, evidence boundary, and verification separate.

## Verification and failure boundaries

Use research, usage data, feasibility evidence, prototypes, experiments, or operational results as appropriate to the decision. Do not convert a requested solution directly into a requirement, use story-point totals as value, double-count correlated evidence in a score, maintain roadmaps detached from evidence, invent certainty where evidence is missing, or declare success from shipping alone.

When the task specifies result, verification, or evidence-map outputs, complete the smallest usable artifact set early and refine it afterward. Target each output path once per edit operation; if a batched edit is rejected, switch to independent writes instead of retrying the same operation across multiple targets. Re-open the outputs before claiming completion. Treat an authored procedure, evidence-map entry, or local checklist as a plan or structural check unless the corresponding command, result, and captured artifact are present. Keep live product, customer, analytics, feasibility, and paired-evaluation checks explicitly unavailable when they were not executed.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.
