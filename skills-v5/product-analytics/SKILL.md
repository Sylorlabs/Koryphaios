---
name: product-analytics
description: Analyze product behavior with trustworthy event semantics, funnels, retention, cohorts, segmentation, causality boundaries, and decision focus. Use when the request specifically requires product analytics, funnel analysis, retention analysis, user cohort analysis.
---

# Product Analytics

## Responsibility

Define actor, event semantics, identity stitching, exposure, unit of analysis, time window, denominator, and product decision first. Audit instrumentation before interpreting funnels or retention, segment by meaningful behavior/context, and distinguish descriptive patterns from causal effects.

Verification focus: Reconcile events to source behavior, inspect missing/duplicate/late events and identity changes, reproduce metrics from raw data, and sensitivity-test window/denominator choices.

Failure boundaries: Do not treat DAU growth as product value automatically, mix users/accounts/sessions in denominators, interpret survivorship as retention success, or infer causation from pre/post changes alone.

## Hierarchy and routing

- Broader skills: data-analysis.
- Narrower children: growth-engineering.
- Required skills: data-analysis.

## Analysis decisions

Write the event and metric contract before querying: qualifying actor, start event, subsequent steps, ordering rule, time window, exclusions, and denominator. Decide whether the unit is a person, account, session, or event and retain that unit throughout the comparison. Identity merges, repeated attempts, late delivery, and backfills can change a result without a change in customer behavior.

Reconcile a small sample of raw events with the actual product workflow. Test missing steps, duplicate events, changed identities, and activity at a time boundary. For retention, define the qualifying start and return behavior and compare cohorts with the same opportunity to mature. Do not call an incomplete recent cohort a retention decline.

Keep accounts or users with missing churn, activity, or event data visible in the quality ledger and report their exclusion or unknown status. Never filter to survivors before calculating the retention denominator. Demonstrate survivorship resistance in the substantive analysis by naming the affected records or fixture condition, the alternative treatment tested, and the observed or unavailable result; an evidence-map label alone is not coverage.

Compare segment composition and instrumentation versions before interpreting a trend. State whether a finding describes association or estimates an effect. When treatment exposure or assignment is inconsistent, investigate the data path rather than repairing the ratio to recover a preferred conclusion.

Deliver reproducible definitions, numerator and denominator counts, exclusions, uncertainty, and the product decision the result can support. The data analysis parent supplies evidence discipline; `growth-engineering` uses those measurements to change a growth mechanism. A dashboard is not proof that its event semantics match the product.

When required result, verification, or evidence-map artifacts are named, write a minimal contract-complete set early, then refine it. Create or update one output path at a time; after a rejected batched edit, use independent writes rather than repeating the same patch. Re-open the outputs and distinguish executed metric reproduction from a proposed query or procedure. A timeout or authored plan does not establish a completed analysis, and absent rows, source fields, or cohort values remain unavailable.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
