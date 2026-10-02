---
name: cloud-security
description: Assess and secure cloud identity, resource policies, exposure, and control planes. Use when reviewing cloud posture, IAM, workload identity, or cross account trust; use infrastructure-security for host hardening and secrets-key-management for key lifecycle.
---

# Cloud Security

Reason from the provider control plane and resource policy model. Cloud security is not “put it in a private subnet”; identify organization/account/project boundaries, human and workload identities, trust policies, effective permissions, resource exposure, management-plane logging, encryption/KMS relationships, and recovery paths.

## Cloud review workflow

1. **Map governance boundaries.** Inventory organization/tenant, accounts/subscriptions/projects, environments, ownership, root/break-glass paths, organization policies/SCPs/policy constraints, central security/logging accounts, and cross-account/project trusts.
2. **Separate human and workload identity.** Prefer federation and short-lived credentials over long-lived access keys. Give workloads dedicated identities attached to the specific service; avoid shared instance/node identities where they grant unrelated workloads excess access.
3. **Evaluate effective permission, not policy prose.** Combine identity policies, resource policies, permission boundaries, org policies, session policies, conditions, service-control mechanisms, and trust/assume-role configuration. Reduce wildcard actions/resources and constrain sensitive cross-account principals/conditions.
4. **Review public and lateral exposure.** Inspect managed-service public access, security groups/firewalls, load balancers, storage/database endpoints, private-service connectivity, egress/NAT/proxy paths, and control-plane/admin access. Verify effective routes and resource settings, not just diagram intent.
5. **Protect data and keys deliberately.** Map resource encryption to KMS/key policies/grants, separation of key administrators from data users where required, rotation/revocation implications, backups/snapshots/replicas, and cross-account sharing. Key lifecycle belongs to `secrets-key-management`.
6. **Centralize evidence.** Enable and protect organization/account audit logs, identity and resource-policy changes, network/access logs where useful, security findings, and alerts. Keep the log/archive destination harder to tamper with than the workloads it observes.
7. **Design guardrails and drift detection.** Encode organization policies, baseline roles, public-access blocks, mandatory logging/encryption, and environment boundaries as policy/IaC where practical. Test deployment-time prevention plus periodic effective-state drift.
8. **Verify from both sides.** Prove intended allowed access and representative denied cross-account/public/escalation paths using the cloud provider's actual policy simulator/query tools and real non-production calls where safe.

## Boundaries

- `infrastructure-security` owns OS/host/container/Kubernetes privilege, mounts, runtime service accounts, and in-cluster/network hardening below the cloud resource plane.
- `authorization-security` owns application user/resource policy rather than cloud IAM for workloads/operators.
- `secrets-key-management` owns KMS/HSM key hierarchy, generation, rotation, wrapping, revocation, backup, and destruction.
- `supply-chain-security` owns CI/build identity and artifact provenance; cloud deployment roles consume those artifacts.
- `security-verification` owns the final proof that the implemented cloud controls match the intended policy.

Use [the maintained source map](references/sources.md) for current AWS, Google Cloud, Azure, and NIST cloud-control guidance.
