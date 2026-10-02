---
name: gcp-cloud
description: Design and operate Google Cloud resources with explicit project, identity, network, quota, and recovery boundaries. Use when Google Cloud control-plane semantics affect the task; use cloud-security for posture assessment, terraform-iac for Terraform mechanics, and serverless-platforms for function runtimes.
---

# Google Cloud

Treat Google Cloud as a hierarchy of authority, billing, network, location, and failure boundaries. Resolve the organization/folder/project that owns each resource, the acting human/workload principal, effective network path, service location, quota, data ownership, audit destination, and recovery objective before changing resources.

## Provider workflow

1. **Resolve the resource hierarchy.** Identify organization, folders, projects, billing ownership, inherited organization policies, and the project that owns each service resource. Use separate projects when lifecycle, blast radius, trust, billing, or operational ownership differs; do not treat project names as proof of isolation.
2. **Separate workforce and workload identity.** Prefer short-lived credentials and service-account impersonation or Workload Identity Federation over service-account keys. Give each workload a deliberately scoped identity and trace both the principal permissions and who may impersonate or attach that service account.
3. **Trace effective networking.** Identify VPC ownership, Shared VPC host/service projects where present, subnets/regions, routes, firewall policy, load balancers, private service access/endpoints, DNS, NAT/egress, and service-specific ingress. Prove reachability and denied paths rather than inferring them from resource names.
4. **Choose managed-service topology by real semantics.** Resolve regional/zonal behavior, autoscaling, maintenance, failover, storage durability, client reconnection, quotas, and service-specific recovery. A managed service does not erase application retry, idempotency, or compatibility requirements.
5. **Keep encryption and secrets ownership explicit.** Record key/project/location ownership, IAM on keys/secrets, rotation/deletion implications, and which service identity actually needs access. Do not create long-lived credentials merely to simplify deployment.
6. **Build durable audit and operations evidence.** Use Cloud Audit Logs and Cloud Logging with deliberate organization/project routing, retention, and access boundaries. Centralize required audit data with aggregated sinks where appropriate, and preserve the identity chain for federation or impersonation-sensitive workflows.
7. **Design recovery from stated objectives.** Distinguish zonal high availability from regional disaster recovery. Check target-region quotas/capacity, networking, data copies/backups, KMS/secret availability, DNS/client behavior, restore/failover/failback, and measure observed recovery rather than treating replication configuration as proof.
8. **Change through reviewable evidence.** Preserve the exact project/region/resource target, intended diff, quota checks, deployment/operation records, and rollback or recovery path. Reconcile manual console changes instead of blindly overwriting unknown drift.

## Evidence

Record organization/folder/project identity, acting principal/service account, effective IAM/network/key paths, service topology and quota state, audit/log-routing configuration, restore/failover evidence, and the reviewed change/rollback artifact. Re-fetch rolling Google Cloud documentation whenever the task depends on current defaults, product availability, quotas, or newly introduced behavior.

## Boundaries

- `cloud-security` owns privilege-escalation, unintended-public-access, threat, and control-effectiveness assessment; `gcp-cloud` owns making Google Cloud resource/control-plane configuration operationally correct.
- `infrastructure-security` owns guest OS, node/container runtime, kernel, and workload hardening; this skill owns Google Cloud IAM/VPC/service control-plane behavior.
- `terraform-iac` owns HCL/providers/backends/state/import/moved/lifecycle mechanics; this skill owns whether the resulting Google Cloud architecture is correct.
- `serverless-platforms` owns Cloud Run functions/function-handler retries, duplicates, concurrency, cold starts, and runtime behavior; this skill owns surrounding project/IAM/VPC/KMS/logging/quota semantics.
- `finops-cloud-cost` owns allocation, commitments, rightsizing programs, and realized-savings measurement; cost is only one provider-design constraint here.

Use [the maintained source map](references/sources.md) for current Google Cloud framework and IAM guidance.
