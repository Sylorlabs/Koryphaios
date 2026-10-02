---
name: aws-cloud
description: Design and operate AWS resources, identity, connectivity, and recovery. Use when AWS service or control plane semantics determine the solution; use cloud-security for posture assessment, terraform-iac for Terraform mechanics, and serverless-platforms for function runtime behavior.
---

# AWS Cloud

Treat AWS as a hierarchy of failure and authority boundaries, not a bag of services. Resolve organization/account ownership, Region/AZ placement, identity path, network path, data ownership, encryption/key custody, service quotas, deployment authority, and recovery objectives before changing resources.

## Provider workflow

1. **Resolve organization and account boundaries.** Keep business workloads out of the Organizations management account. Use accounts/OUs as isolation and policy boundaries, understand where SCP/RCP guardrails apply, and remember that an SCP limits permissions rather than granting them. Stage organization-wide controls before broad attachment.
2. **Resolve human and workload identity separately.** Prefer workforce federation/IAM Identity Center and temporary sessions for humans; use service/workload roles and temporary credentials for machines. Trace role trust, session conditions, permission policy, resource policy, organization guardrails, and KMS/key policy where all participate in the effective authorization decision.
3. **Trace effective networking.** Identify VPC/subnet/AZ ownership, route tables, gateways/transit/peering/PrivateLink/endpoints, DNS, security groups and any NACLs. “Private subnet” is a topology claim that must be supported by effective routes and ingress/egress paths, not by a subnet name.
4. **Choose managed-service topology by real semantics.** Distinguish HA, read scaling, backup, replication and disaster recovery. For example, a traditional RDS Multi-AZ standby provides availability/failover, not a read target. Resolve service-specific durability, failover, client reconnect, quota, maintenance and data-recovery behavior before relying on a managed label.
5. **Make KMS/secrets ownership explicit.** Separate key administration from key use, keep grants/policies narrow, record account/Region ownership, and test consequences of disabled/deleted keys. Multi-Region key material does not imply synchronized policies. Keep sensitive data out of KMS encryption context and rotate application secrets through a supported lifecycle.
6. **Build durable audit/operations evidence.** Use CloudTrail trails/configuration appropriate to the retention and event types required, AWS Config aggregation where state history matters, and CloudWatch telemetry/centralization for operational signals. Do not treat the free 90-day per-account/Region management Event History as a durable audit archive.
7. **Design recovery from stated RTO/RPO.** Separate AZ high availability from Regional disaster recovery. Check secondary-Region quotas/capacity, networking, key/secret availability, backup isolation, cross-account/Region copies where justified, DNS/client reconnection, and restore/failover/failback. Replication or backup existence is not restore proof.
8. **Change through reviewable AWS-native evidence.** For CloudFormation, inspect change sets and drift where supported, understand replacements and unsupported drift-aware resource types, stage organization controls, preserve stack events/rollback paths, and reconcile emergency console changes instead of overwriting them blindly.

## Evidence

Record the exact account/OU/Region/role identity, effective route/permission/key paths, service topology and quota state, CloudTrail/Config/CloudWatch configuration, backup/restore or failover evidence, and change/rollback artifact. Re-fetch rolling AWS documentation whenever a task depends on current defaults, Region availability, quotas, runtime support, or newly introduced/retired features.

## Boundaries

- `cloud-security` owns security-posture questions such as privilege escalation, unintended public/cross-account access, threat reduction, and control effectiveness; `aws-cloud` owns making the AWS resource/control-plane configuration operationally correct.
- `infrastructure-security` owns guest OS, node/container runtime, kernel and workload hardening; this skill owns AWS VPC/EC2/EKS/IAM/KMS/service control-plane behavior.
- `terraform-iac` owns HCL/provider/backends/state/import/moved/lifecycle/drift mechanics; this skill owns whether the resulting AWS architecture/service configuration is correct. Many real changes compose both.
- `serverless-platforms` owns Lambda/function handler retries, duplicate delivery, concurrency, cold starts and runtime behavior; this skill owns surrounding AWS account/VPC/IAM/KMS/event-source/logging/quota semantics.
- `finops-cloud-cost` owns allocation, CUR analysis, commitments, rightsizing programs and realized-savings measurement. Cost remains a design constraint here but not the primary optimization discipline.

Use [the maintained source map](references/sources.md) for current AWS framework/service guidance and 2026 freshness exceptions.
