---
name: operational-data-analysis
description: Turn production or process data into decisions while accounting for instrumentation and system change. Use when the request specifically requires operational analysis, production metrics, incident data, process monitoring; prefer a narrower child only when its boundary is established.
---

# Operational Data Analysis

## Responsibility

Start from the operational decision. Validate metric definitions, event generation, clocks, sampling, aggregation, retries, identity, late data, schema changes, and observability gaps. Compare meaningful baselines and segments and tie findings to thresholds and verification.

## Hierarchy and routing

- Broader skills: data-analysis.
- Narrower children: finops-cloud-cost.

## Goal

Turn production or process evidence into a bounded operational decision. Begin with the decision owner, action, urgency, acceptable risk, baseline, and measure of success. Trace each metric from the event or measurement source through identity, clock, sampling, retry, aggregation, retention, schema evolution, dashboard, and alert. A familiar name such as "availability" or "active user" does not establish comparable meaning.

## Method

Validate event coverage and timing against independent signals where possible. Separate demand changes, configuration changes, deployments, incidents, and instrumentation changes from behavior changes. Compare like exposure, meaningful segments, and stable baselines; inspect both tail behavior and aggregates. Make late, duplicate, missing, and backfilled records visible. Turn a finding into an action only when its threshold, owner, expected effect, and verification plan are clear. If the metric is too weak for the decision, recommend instrumentation or a smaller claim instead of a confident chart.

Preserve aggregation semantics. An average of instance-level percentiles is not a fleet percentile. Compute the required quantile from raw observations or a compatible merged distribution, keeping windows, bucket resolution, and population aligned. When only precomputed percentiles survive, report that limitation rather than fabricating a global tail estimate.

## Evidence and failure modes

Return metric lineage, data-quality caveats, baseline rationale, segment results, operational recommendation, and follow-up verification. Do not assume a particular telemetry stack, database, or dashboard. Frequent failures are alerting on ratios with changing denominators, comparing releases with unequal traffic, averaging away severe tails, treating retries as demand, using deploy time as exposure time, and reporting an incident correlation as root cause without a supporting trace.

## Completion evidence

- Metric lineage, query or extraction method, population, windows, and aggregation definition
- Comparable baseline and segment results with missing-data and instrumentation caveats
- Decision-linked findings, uncertainty, and an observable check for the proposed action

`observability-sre` owns production instrumentation and alert-system design; this skill analyzes the resulting evidence. `finops-cloud-cost` owns cloud billing and allocation semantics when that narrower boundary is material.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
