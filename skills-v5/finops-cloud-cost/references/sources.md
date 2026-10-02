# Source map

`finops-cloud-cost` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Technology-cost data and recommendation semantics change with provider exports, contracts and FinOps/FOCUS revisions. Pin the actual billing schema, cost lens, commercial terms and recommendation mode before claiming savings.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader operational-data-analysis.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **FinOps Framework**: [https://www.finops.org/framework/](https://www.finops.org/framework/)
  - Scope: current framework as available 2026-09-05, including the 2026 expansion across technology categories and strategy/value scopes.
  - Use: operating model, scopes, principles and separation of allocation, unit economics, usage optimization, rate optimization, governance and related capabilities.
  - Verified: 2026-09-05; refresh after 30 days.
- **FinOps Allocation capability**: [https://www.finops.org/framework/capabilities/allocation/](https://www.finops.org/framework/capabilities/allocation/)
  - Scope: current capability as available 2026-09-05.
  - Use: complete direct/shared allocation, tagging/hierarchy strategy, shared-cost methods and allocation-compliance evidence.
  - Verified: 2026-09-05; refresh after 30 days.
- **FinOps Unit Economics capability**: [https://www.finops.org/framework/capabilities/unit-economics/](https://www.finops.org/framework/capabilities/unit-economics/)
  - Scope: current capability as available 2026-09-05.
  - Use: business/resource unit metrics, data sources and value linkage; rising total spend can coexist with improved unit economics when delivered value grows faster.
  - Verified: 2026-09-05; refresh after 30 days.
- **FinOps Usage Optimization**: [https://www.finops.org/framework/capabilities/usage-optimization/](https://www.finops.org/framework/capabilities/usage-optimization/)
  - Scope: current capability as available 2026-09-05.
  - Use: rightsizing/idle/architecture optimization with performance, availability and business-value requirements preserved.
  - Verified: 2026-09-05; refresh after 30 days.
- **FinOps Rate Optimization**: [https://www.finops.org/framework/capabilities/rate-optimization/](https://www.finops.org/framework/capabilities/rate-optimization/)
  - Scope: current capability as available 2026-09-05.
  - Use: negotiated and commitment discounts, coverage/utilization/vacancy and commitment-risk governance.
  - Verified: 2026-09-05; refresh after 30 days.
- **FOCUS Specification 1.4**: [https://focus.finops.org/docs/specification/v1-4/](https://focus.finops.org/docs/specification/v1-4/)
  - Scope: published FOCUS 1.4, 2026.
  - Use: common cost/usage schema and the distinct meanings of Billed Cost, Effective Cost, List Cost, Contracted Cost, commitment and allocation dimensions. Billed Cost supports invoice/cash reconciliation; Effective Cost supports amortized/accrual-oriented analysis.
  - Verified: 2026-09-05; refresh after 60 days.
- **AWS Cost Optimization Hub**: [https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html](https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html)
  - Scope: current AWS documentation as available 2026-09-19.
  - Use: consolidated rightsizing, idle, Savings Plan and RI opportunities with discount-aware estimates and deduplication across interacting recommendations.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS estimated monthly savings**: [https://docs.aws.amazon.com/cost-management/latest/userguide/coh-estimated-monthly-savings.html](https://docs.aws.amazon.com/cost-management/latest/userguide/coh-estimated-monthly-savings.html)
  - Scope: current AWS Cost Optimization Hub savings methodology as available 2026-09-19.
  - Use: estimated monthly savings are normalized approximations based on historical patterns and amortized costs; realized future savings depend on actual usage.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Cost Optimization Hub preferences**: [https://docs.aws.amazon.com/cost-management/latest/userguide/coh-preferences.html](https://docs.aws.amazon.com/cost-management/latest/userguide/coh-preferences.html)
  - Scope: current documentation as available 2026-09-19.
  - Use: before-discount versus after-discount savings estimation and commitment term/payment preferences. Always record which mode generated an estimate.
  - Verified: 2026-09-19; refresh after 14 days.
- **AWS Savings Plans recommendations**: [https://docs.aws.amazon.com/savingsplans/latest/userguide/sp-recommendations.html](https://docs.aws.amazon.com/savingsplans/latest/userguide/sp-recommendations.html)
  - Scope: current recommendations as available 2026-09-19.
  - Use: recommendation inputs, coverage/utilization projections and historical lookback. AWS explicitly notes recommendations do not forecast future usage, so planned demand changes must be modeled separately.
  - Verified: 2026-09-19; refresh after 14 days.

## Interpretation rules

- Name the cost basis. Billed, effective/amortized, list and contracted costs answer different questions and must not be mixed silently.
- Reconcile billed scope to invoice/provider totals before optimizing; preserve timing, credits/refunds/taxes/marketplace and currency differences explicitly.
- Allocation must be complete and reproducible: direct + shared + unallocated should reconcile to the analyzed cost basis, with shared-cost apportionment documented and versioned.
- Normalize spend by useful resource/business units and comparable periods. Total spend alone cannot distinguish growth from worsening efficiency.
- Separate usage optimization from rate optimization. Remove/resize avoidable usage before committing to discounts that would lock in the waste.
- Provider recommendations are estimates. Record lookback and before/after-discount mode, deduplicate overlapping actions and validate against actual commercial terms and reliability/performance requirements.
- Commitment decisions need eligible effective demand, existing coverage/utilization/vacancy, hourly variability and future migration/growth/downside scenarios. Nominal discount percentage is not the objective.
- Realized savings require a post-change measurement on the same cost/unit basis with demand/rate/usage effects separated. Keep an owner, date, assumption set and measured outcome for every action.
