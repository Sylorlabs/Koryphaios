# Source map

`architecture-planning` is individually authored. Promotion still requires clean routing, paired full task evidence using the same model for the skill and baseline arms, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader planning; narrower children aws-cloud, azure-cloud, gcp-cloud, kubernetes-operations, terraform-iac.
- Routing: five positive, five near neighbor negative, three compound or ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, paired skill and baseline runs using the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **ISO/IEC/IEEE 42010**: https://www.iso.org/standard/74393.html
  - Scope: ISO/IEC/IEEE 42010:2022 architecture description standard.
  - Use: architecture descriptions should be grounded in stakeholders, concerns, viewpoints, and explicit correspondences rather than one undifferentiated diagram.
  - Verified: 2026-09-04; refresh after 365 days.

- **Microsoft Azure Architecture Center: Application architecture fundamentals**: https://learn.microsoft.com/en-us/azure/architecture/guide/
  - Scope: first party Microsoft guidance as available 2026-09-04.
  - Use: decompose functional and nonfunctional requirements, evaluate architectural styles and technology choices against quality attributes, and make tradeoffs explicit.
  - Authority boundary: Azure examples are not universal implementation mandates; use the general decision discipline outside Azure.
  - Verified: 2026-09-04; refresh after 180 days.

- `AWS Well-Architected Framework: Definitions`: https://docs.aws.amazon.com/wellarchitected/latest/framework/definitions.html
  - Scope: first party AWS framework as available 2026-09-04.
  - Use: evidence that architecture is how workload components interact and that engineering priorities require contextual tradeoffs among quality pillars.
  - Authority boundary: AWS service recommendations apply only when AWS is actually in scope.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Start from the actual workload, stakeholders, constraints, and quality scenarios; do not import a cloud reference architecture simply because it exists.
- Compare alternatives against the same criteria and include the incumbent or minimal option when credible.
- Distinguish expensive or irreversible choices from local implementation details that can remain undecided.
- Preserve uncertainty explicitly. A diagram is not evidence that a quality requirement will be met; identify what must be prototyped, measured, or verified before commitment.
