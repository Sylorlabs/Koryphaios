# Source map

`aws-cloud` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. AWS mixes revisioned frameworks/whitepapers with continuously updated `latest` service guides, so source freshness is part of the skill contract rather than a citation exercise performed only once.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing contract: five positive, five negative cases from neighboring specialties, three compound/ambiguous, and four adversarial held out cases. Public and held out prompts are distinct; corpus presence is not a passing resolver result.
- Full task contract: two individual scenarios with six falsifiable checks specific to each scenario. Pairing the same model with and without the skill and blind semantic judging remain requirements owned by the evaluator, not evidence that either has run. See [evaluation boundaries](../evals/README.md) for actual artifact paths and limitations of deterministic scoring.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **AWS Well-Architected Framework**: https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
  - Scope: fetched `latest` welcome page identifies publication date 2024-11-06; the page listing document revisions confirms that date. Neither fetched page identifies a numeric v13 revision, so the maintained revision uses the publication date.
  - Use: provider architecture and operational baseline across the six pillars.
  - Verified: 2026-10-17; refresh after 60 days.
- **Organizing Your AWS Environment Using Multiple Accounts**: https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/organizing-your-aws-environment.html
  - Scope: AWS whitepaper, publication date 2025-04-30.
  - Use: account/OU isolation, workload separation, foundational structure across multiple accounts.
  - Verified: 2026-10-17; refresh after 90 days.
- **IAM security best practices**: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
  - Scope: rolling IAM documentation rechecked 2026-10-17.
  - Use: workforce federation/temporary credentials, workload roles and least privilege.
  - Verified: 2026-10-17; refresh after 30 days.
- **CloudTrail concepts**: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-concepts.html
  - Scope: rolling documentation rechecked 2026-10-17.
  - Use: distinguish Event History, trails and retained audit evidence. Event History alone is not durable audit storage across the organization. Trails do not log data events by default; explicitly select required object/resource operations.
  - Verified: 2026-10-17; refresh after 14 days.
- **CloudFormation change sets**: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html
  - Scope: rolling guidance rechecked 2026-11-07.
  - Use: review replacements/changes before execution; do not treat the change set as a guarantee of successful apply.
  - Verified: 2026-11-07; refresh after 21 days.
- **AWS Security Reference Architecture document history**: https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/doc-history.html
  - Scope: living Prescriptive Guidance rechecked 2026-11-07; major update 2026-06-30.
  - Use: freshness guard for AWS recommendations adjacent to security work. The June 2026 update removed stale CloudTrail Lake recommendations.
  - Verified: 2026-11-07; refresh after 21 days.

## Claim coverage for specific services

These official pages were fetched and inspected on 2026-11-07. Their rolling scope and refresh intervals also appear in the sidecar. Verification covers the listed claims, not every linked guide, current account entitlements, live behavior or every Region's availability.

| Source                                                                                                                                | Claim supported and scope limitation                                                                                                                                          | Refresh after |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Organizations SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)                       | Principal ceiling in member accounts, no grants, exceptions for the management account and service linked roles, staged OU rollout.                                           | 30 days       |
| [Organizations RCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html)                       | Resource ceiling in member accounts, applicability to external callers, service support and exceptions; recheck the service list rather than freezing it here.                | 21 days       |
| [IAM evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)                     | Identity/resource grants, boundaries, organization controls and explicit denies. Principal/session and access across accounts require the linked evaluation rules.            | 30 days       |
| [VPC route tables](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html)                                            | Subnet/gateway route ownership and destination/target semantics. Configuration alone cannot prove DNS or observed reachability.                                               | 45 days       |
| [RDS Multi-AZ deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html)                              | DB instance standby versus DB cluster readers; this distinction is not engine/Region compatibility or Regional DR proof.                                                      | 30 days       |
| [KMS key policies](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)                                           | Regional key authority, IAM delegation and grants; an IAM allow alone is insufficient.                                                                                        | 30 days       |
| [KMS multi-Region keys](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)                        | Shared material versus independently managed policies, grants, aliases and enabled states; data replication still depends on the service.                                     | 30 days       |
| [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)                                              | Association between a role and service account, SDK chain, agent/platform restrictions and IMDS/node role exposure. Do not assume universal EKS runtime support or isolation. | 21 days       |
| [Config aggregation](https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html)                                    | View of recorded source configuration/compliance data without write authority; an aggregator does not enable recorders.                                                       | 30 days       |
| [CloudWatch metric concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html)                 | Namespace/name/dimensions, Region, timestamps, resolution and alarm observations; dashboard existence is not telemetry evidence.                                              | 30 days       |
| [AWS Backup restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html)                             | Restore job versus validation, key/role failures, resource support and cleanup; job completion is not application usability or RTO/RPO measured through the entire recovery.  | 21 days       |
| [CloudFormation drift-aware change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/drift-aware-change-sets.html) | Actual/previous/desired comparison, fallback for unsupported types, properties permitting writes only, attachments across stacks and rollback boundaries.                     | 21 days       |
| [Service Quotas](https://docs.aws.amazon.com/servicequotas/latest/userguide/intro.html)                                               | Applied/default values, account/Region/resource scope, usage and increase requests; pending requests are not approved headroom.                                               | 30 days       |

## Interpretation rules

- Fetch rolling guides again whenever Region/service availability, quotas, defaults, runtime support, Organizations features, EKS identity, audit or backup features determine the answer.
- Never infer effective IAM from one policy document: trace identity policy, role trust, resource policy, organization guardrails, boundaries/session conditions, and KMS/key policy where relevant.
- Distinguish AZ HA, read scaling, backup, replication across Regions and disaster recovery; require restore/failover evidence for the recovery claim being made.
- CloudTrail Event History is not a substitute for a durable audit architecture across multiple accounts; also avoid recommending CloudTrail Lake to new customers based on guidance from before May 2026.
- Preserve account/Region/key/quota/change set identity in verification evidence; local CLI profile names are not proof of the target production identity.
- Fetch specialized service guides again for concrete engine, SDK, endpoint policy, Secrets Manager rotation or backup/copy compatibility questions. A framework citation or this claim map does not establish an uninspected fact about a specific service.
