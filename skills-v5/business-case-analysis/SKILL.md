---
name: business-case-analysis
description: Evaluate funding choices using alternatives, incremental economics, risk, and decision criteria. Use when preparing a business case, build versus buy decision, return appraisal, or approval recommendation; not for financial modeling, vendor scoring, or delivery scheduling alone.
---

# Business Case Analysis

Own the investment decision and its evidence boundary. A business case should make the alternatives, incremental consequences, uncertainty, and decision rule legible enough that a reviewer can disagree with an assumption without having to reconstruct the whole case.

## Frame the decision

State the decision, decision owner when known, objectives, constraints, evaluation horizon, and minimum acceptable outcome. Include a credible status-quo/do-nothing or do-minimum alternative so the recommendation is incremental rather than an isolated proposal.

Define the feasible alternatives before optimizing one of them. For build-vs-buy, include the realistic build, buy, hybrid, defer, and status-quo options that survive initial feasibility screening. Keep vendor fit or technical feasibility as inputs to the case rather than silently turning them into the investment decision.

## Build the evidence ledger

For each material cost or benefit, preserve source, timing, unit, affected population/volume, confidence, and whether it is cash, accounting, capacity, strategic, or non-financial value. Separate observed evidence from assumptions and avoid converting soft benefits into cash unless the valuation method is defensible.

Use incremental future consequences. Exclude sunk costs from the choice except where they affect future exit or transition costs. Include implementation, integration, migration, change-management, training, support, operating, security/compliance, switching, decommissioning, and monitoring/evaluation costs when material.

Do not double-count the same benefit through overlapping labels such as labor hours saved, headcount avoided, throughput gained, and revenue enabled unless the mechanisms are independently realizable.

## Compare alternatives

Use a consistent time horizon, units, price basis, discounting convention, and scenario assumptions across options. Apply NPV, discounted cash flow, payback, ROI, break-even, cost-effectiveness, or value-for-money measures only when they fit the decision; no single metric is mandatory.

Build the reconciled quantitative comparison before writing the recommendation. For every material option and decision-relevant scenario, show the time-phased incremental cash costs/benefits, separately identified capacity or opportunity costs, and the calculation basis needed to reproduce the result. When break-even or sensitivity is decision-relevant, calculate it from that same reconciled model rather than leaving the economic matrix implicit in prose.

When the task requires a machine-readable appendix, preserve the requested field types and cardinality exactly and retain enough numeric precision for independent reconciliation. Round display prose separately from machine evidence.

Include strategic fit, dependencies, capacity consumption, reversibility, vendor/technology lock-in, delivery/adoption risk, option value, and opportunity cost alongside quantified economics. Distinguish committed benefits from contingent benefits that require adoption, behavior change, future scale, or another investment.

## Uncertainty and recommendation

Build a base case plus bounded downside/upside or other decision-relevant scenarios. Sensitivity-test the assumptions most able to flip the recommendation, and show break-even values where they are decision-useful. Correlated risks should not be varied independently if that creates impossible combinations.

Recommend an option only after showing why alternatives are inferior under the stated evidence. State confidence, assumptions that can reverse the recommendation, decision gates, prerequisites, and what new evidence would trigger reconsideration. For staged or reversible investments, prefer explicit pilot/option gates when they materially reduce downside or buy information.

Use a staged decision only when the alternative set contains an explicit reversible stage or pilot that is itself being authorized. Do not use `stage` as a synonym for conditional approval of a different option.

Treat the decision action as a typed commitment state, not narrative shorthand. If the selected option is not the explicit stage/pilot alternative, never emit a `stage` action for it merely because only part of that option would be funded. Use the contract's conditional, defer, reject, or approve semantics instead. Keep present funding aligned to that action: conditional/defer/reject release no funds; a stage action can release only the bounded upfront amount of the explicitly modeled stage/pilot and cannot smuggle rollout funding for another option under a reversible-stage label.

Define post-decision measures that can validate the case: adoption/volume assumptions, realized costs, realized benefits, guardrails, and a review point. Approval is not proof that the forecast was correct.

## Boundaries

- `financial-modeling` owns spreadsheet/model architecture, linked statements, cash-flow schedules, formulas, scenarios, sensitivities, and audit checks. This skill owns what decision the model informs and how alternatives are judged.
- `procurement-vendor-evaluation` owns vendor criteria, due diligence, scoring, and supplier evidence; this skill incorporates those findings into an investment decision when requested.
- `market-strategy` owns market selection, positioning, and competitive strategy.
- `product-management` owns product priorities and product outcomes.
- `project-program-management` owns delivery plans, schedules, milestones, staffing, and dependency tracking after or alongside the decision.

Compose when the request needs both outputs, but keep the investment recommendation distinct from model mechanics, vendor ranking, or delivery scheduling.

## Failure boundaries

Do not count sunk costs as future benefits, double-count productivity, hide implementation/adoption or exit costs, compare alternatives over inconsistent horizons, treat scenario outputs as predictions, use a single ROI percentage to hide timing and risk, or manufacture precise values for benefits that have no defensible valuation basis.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts. Keep this skill inside its declared responsibility; adjacent skills may compose with it but do not erase its evidence boundary.
