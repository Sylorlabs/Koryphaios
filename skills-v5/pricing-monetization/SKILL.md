---
name: pricing-monetization
description: Design pricing and monetization around customer value, segmentation, packaging, usage, willingness to pay, economics, and operational constraints. Use when the request specifically requires pricing strategy, monetization, pricing tiers, usage based pricing.
---

# Pricing Monetization

## Responsibility

Identify value metric, customer segments, alternatives, willingness/ability to pay, cost-to-serve, packaging, discounting, billing complexity, expansion paths, and fairness/trust implications. Model how pricing changes behavior and sales motion rather than optimizing a spreadsheet in isolation.

Verification focus: Use customer research, historical conversion/retention, conjoint or pricing studies when justified, controlled packaging tests where feasible, and scenario economics across adoption/usage distributions.

Failure boundaries: Do not price solely from competitor averages or cost-plus, hide unavoidable fees, create tiers no segment understands, or extrapolate willingness-to-pay from tiny convenience samples.

## Hierarchy and routing

- Broader skills: market-competitive-research.
- No narrower bundled child is declared.

## Design the commercial contract

Choose a charging unit that customers understand and that tracks delivered value without making ordinary use unpredictable. Compare a fixed fee, seats, quantity tiers, and metered use only when they fit the buying motion. Distinguish volume pricing from graduated tiers; a boundary can change the bill differently under each model.

Calculate representative bills for small, typical, and heavy use, including minimums, discounts, overages, renewal terms, and support costs. Show contribution and cash timing separately. Include customers whose behavior becomes uneconomic under the proposal rather than evaluating only the average account.

Treat an interview answer as evidence of stated preference, not a completed purchase. Compare it with observed conversion, retention, and the available alternatives. State the sample and uncertainty of any willingness to pay study. Changes to live prices require appropriate authority and a plan for existing contracts, communication, migration, and dispute handling.

Deliver a value and segment rationale, transparent packaging, boundary bill examples, and a test that could reject the proposal. Payment tooling proves whether billing can implement a model; it does not prove demand. Business case analysis owns the broader funding recommendation.

## Execute and verify the decision

Build the requested deliverables early, then refine them with the available evidence. When a task names specific result, verification or evidence map artifacts, create each one once with a usable first version rather than spending the entire execution budget deliberating. Respect the caller's requested fields and artifact paths. Write one output path per edit operation; if a batched edit is rejected, switch to independent writes instead of retrying the same patch. Reopen the required outputs before claiming completion.

Account for every artifact the task names in the evidence map `artifacts` array. Outputs the candidate creates use `produced`, artifacts owned by the evaluator or by the paired comparison use `external-evaluator`, and anything the packet cannot support uses `unavailable` with a note. A produced file that is missing from that array fails required artifact accounting even when the file itself is complete. Keep the final decision, the verification performed, and the unavailable checks distinct; a local self review is not independent proof of a business outcome.

For **usage tier redesign**:

1. Establish the current contract per cohort, including grandfathered customers and discounts; segment by buyer, seats, usage distribution, revenue, expansion/churn, variable infrastructure cost, support and payment cost. Document missing customer records without filling gaps with invented averages.
2. Model each candidate against the status quo at the _individual customer_ level. Compute bill changes at every boundary and for extreme usage, aggregate revenue and contribution by segment, and quantify adverse tail outcomes. For graduated tiers, price units within each band; for volume tiers, apply the applicable rate to all units. Include refunds, credits, taxes where relevant and billing reconciliation work.
3. Make the recommendation conditional on a measured willingness-to-pay and retention/conversion test, economics guardrails, legal contract constraints and who can approve or roll back a change. A high average margin cannot justify punitive outliers or retroactive contract changes.

For **trial length or paywall changes**:

1. Separate activation time from conversion time by segment, especially enterprise users waiting on security review. Respect existing trial promises and entitlement snapshots through renewals or migrations.
2. If the proposed experiment changes both trial duration and feature gate, use separate arms or a factorial design where feasible. Define eligibility, randomization, exposure, sample-size/power assumptions, observation windows, missingness/contamination handling and owner for billing/entitlements. Never ascribe an observed conversion lift to one component of a bundled experiment.
3. Track paid conversion alongside activation, qualified enterprise opportunities, retention, complaints, refunds, usage, contribution and support load. Specify a stop rule, a negative-path probe (billing/entitlement mismatch, cancellation or segment regression), and a concrete rollback that honors existing users' terms. Label outcomes **not measured** until the actual test runs.

In every artifact, attach each assertion to a source, dated measurement, contract or a clearly marked assumption. Show the calculation or test needed to overturn the decision. If only a synthetic packet exists, report a reproducible **design and verification plan**, with unperformed customer tests and live billing checks explicitly unavailable; never call a planned test a completed experiment.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
