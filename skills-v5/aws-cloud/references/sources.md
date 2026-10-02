# Source map

`aws-cloud` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. AWS mixes revisioned frameworks/whitepapers with continuously updated `latest` service guides, so source freshness is part of the skill contract rather than a one-time citation exercise.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **AWS Well-Architected Framework**: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
  - Scope: current `latest` identifies publication date 2024-11-06; applicable snapshot v13.
  - Use: provider architecture and operational baseline across the six pillars.
  - Verified: 2026-09-05; refresh after 60 days.
- **Organizing Your AWS Environment Using Multiple Accounts**: https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html
  - Scope: AWS whitepaper, publication date 2025-04-30.
  - Use: account/OU isolation, workload separation, foundational multi-account structure.
  - Verified: 2026-09-05; refresh after 90 days.
- **IAM security best practices**: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
  - Scope: rolling IAM documentation as available 2026-09-05.
  - Use: workforce federation/temporary credentials, workload roles and least privilege.
  - Verified: 2026-09-05; refresh after 30 days.
- **CloudTrail concepts**: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-concepts.html
  - Scope: rolling documentation as available 2026-09-19.
  - Use: distinguish Event History, trails and retained audit evidence. Event History alone is not durable organization-wide audit storage.
  - Verified: 2026-09-19; refresh after 14 days.
- **CloudFormation change sets**: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html
  - Scope: rolling guidance as available 2026-09-05.
  - Use: review replacements/changes before execution; do not treat the change set as a guarantee of successful apply.
  - Verified: 2026-09-05; refresh after 21 days.
- **AWS Security Reference Architecture document history**: https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/doc-history.html
  - Scope: living Prescriptive Guidance; major update 2026-06-30.
  - Use: freshness guard for security-adjacent AWS recommendations. The June 2026 update removed stale CloudTrail Lake recommendations.
  - Verified: 2026-09-05; refresh after 21 days.

## Interpretation rules

- Re-fetch rolling guides whenever Region/service availability, quotas, defaults, runtime support, Organizations features, EKS identity, audit or backup features determine the answer.
- Never infer effective IAM from one policy document: trace identity policy, role trust, resource policy, organization guardrails, boundaries/session conditions, and KMS/key policy where relevant.
- Distinguish AZ HA, read scaling, backup, cross-Region replication and disaster recovery; require restore/failover evidence for the recovery claim being made.
- CloudTrail Event History is not a substitute for a durable multi-account audit architecture; also avoid recommending CloudTrail Lake to new customers based on pre-May-2026 guidance.
- Preserve account/Region/key/quota/change-set identity in verification evidence; local CLI profile names are not proof of the target production identity.
