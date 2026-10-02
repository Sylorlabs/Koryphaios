---
name: finops-cloud-cost
description: Analyze and improve cloud cost through reconciled billing, allocation, unit economics, and verified savings. Use when assessing spend, commitments, rightsizing, or FinOps governance; use provider cloud skills for infrastructure implementation and data-analysis for unrelated datasets.
---

# FinOps Cloud Cost

Optimize value, not just spend. Reconcile the bill first, allocate it transparently, normalize cost by useful workload/business units, separate usage from rate effects, and verify savings after implementation against reliability and product guardrails.

## Workflow

1. **Pin the cost-data contract.** Record provider/data-generator, billing and charge periods, currency, account/subaccount scope, schema/export version, invoice issuer, discounts/credits/taxes, and whether the analysis uses billed, effective/amortized, list, contracted, or another cost lens. Do not mix cost concepts in one comparison without an explicit bridge.
2. **Reconcile before optimizing.** Prove the selected billed-cost view ties to invoices/provider totals for the same billing scope, and explain known exclusions or timing differences. Track late adjustments, refunds/credits, marketplace charges, taxes, FX and shared charges so “savings” are not artifacts of an incomplete export.
3. **Make allocation complete and auditable.** Allocate direct spend via account/project/subscription, tags/labels, resource IDs or derived metadata; define shared-cost pools and apportionment rules separately. Report allocated, shared and unallocated percentages and preserve the rule/version that produced each allocation.
4. **Define the decision unit.** Choose resource-efficiency units such as cost/GB, vCPU-hour or token and business units such as cost/tenant, transaction, order or case. Pin denominator source, time window and exclusions. Use unit cost to distinguish healthy growth from deteriorating efficiency.
5. **Decompose cost change.** Separate workload volume, usage efficiency, list/rate change, discount/commitment coverage, service/resource mix, architecture, data transfer, storage lifecycle, allocation change and anomalies. Do not attribute a monthly increase to “waste” when useful demand grew faster.
6. **Normalize comparisons.** Use comparable periods and maturity/seasonality where relevant; account for business growth, migration phases, one-time purchases/credits and commitment amortization. Compare same currency/cost basis or document the conversion.
7. **Separate usage optimization from rate optimization.** Usage work removes idle resources, rightsizes, schedules, changes storage/data-transfer patterns or rearchitects. Rate work improves negotiated/commitment pricing. Avoid buying a commitment to cover avoidable waste.
8. **Validate rightsizing against performance evidence.** Use representative CPU/memory/IO/network/latency and burst/headroom data plus availability/redundancy requirements. Provider recommendations are candidates, not authorization to resize or delete.
9. **Model commitments with coverage, utilization and vacancy risk.** Start from stable eligible usage after existing commitments/discounts, then test term/payment/flexibility scenarios. Include expected workload changes, migrations, growth/decline and expiration/renewal. A high nominal discount with low utilization can increase effective cost.
10. **Treat recommendation savings as estimates.** Record provider savings-estimation mode and lookback. Deduplicate mutually exclusive or interacting recommendations, and distinguish before-discount/list savings from after-discount/effective savings. Do not sum overlapping opportunities naively.
11. **Rank opportunities by net value and reversibility.** Compare projected effective savings or avoidance with implementation effort, migration/egress/license cost, operational risk, developer time, performance/reliability guardrails and rollback cost. Preserve resilience unless the business explicitly changes the reliability objective.
12. **Model storage and network economics end to end.** Include retention/access/retrieval/deletion minimums where applicable, replication/backups, NAT/egress/inter-region/cross-AZ transfer, logs/telemetry and cache/CDN effects. Moving compute can shift rather than eliminate spend.
13. **Measure realized savings after change.** Recompute cost on the same effective/billed basis, unit metrics and guardrails after implementation. Separate usage reduction, rate change, demand change and timing. A list-price delta or vendor recommendation is not realized savings.
14. **Keep commitments and optimizations governed.** Name the accountable owner, approval threshold, scope, expiration/renewal dates, policy exceptions and monitoring cadence. Alert on underutilized commitments, unallocated spend, anomalous unit cost and reliability regressions.
15. **Preserve an action ledger.** For each opportunity, record baseline, assumption set, expected net savings, owner, status, implementation date, rollback, measured outcome and confidence. Retire opportunities that are no longer valid instead of carrying stale “savings potential.”

## Boundaries

- `data-analysis` and `operational-data-analysis` own generic data preparation, diagnostics and trend analysis. This skill owns cost lenses, allocation, unit economics, commitments, savings methodology and FinOps decisions.
- `aws-cloud`, `gcp-cloud`, `azure-cloud` and provider skills own implementation of provider resources/IAM/networking. This skill determines the cost/value evidence and guardrails for a cloud-cost change.
- `business-case-analysis` owns broader investment/business-case decisions across benefits and alternatives. This skill supplies auditable technology cost, unit economics and savings scenarios.
- `procurement-vendor-evaluation` owns sourcing/vendor commercial evaluation. This skill owns consumption/commitment economics and how negotiated/committed rates affect actual technology cost.
- `observability-sre` owns service reliability/SLO operations. This skill preserves performance/reliability signals as optimization guardrails rather than silently trading them away for lower spend.
- Generic budgeting, bookkeeping, corporate accounting or a one-off provider bill explanation does not activate this skill unless technology-cost allocation/optimization/value decisions are being made.

Use [the maintained source map](references/sources.md) before relying on billing-schema, recommendation, commitment, amortization or provider-savings semantics.
