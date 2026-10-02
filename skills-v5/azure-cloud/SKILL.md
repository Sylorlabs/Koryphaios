---
name: azure-cloud
description: Design and operate Azure resources, Entra identities, networking, and recovery. Use when Azure service or control plane semantics determine the solution; use cloud-security for posture assessment, terraform-iac for Terraform mechanics, and serverless-platforms for function runtime behavior.
---

# Azure Cloud

Resolve the exact Microsoft Entra tenant and Azure management scope before touching resources. Azure control-plane correctness depends on inherited policy/RBAC, subscription and resource-group ownership, regional/SKU capabilities, effective network/DNS paths, managed identity lifecycle, and provider-specific recovery behavior.

## Provider workflow

1. **Resolve hierarchy and inheritance.** Identify tenant, management groups, subscriptions, resource groups, Azure Policy/initiative assignments, RBAC inheritance, billing ownership, allowed regions and deployment scopes. Broad assignments at management-group or subscription scope require deliberate justification because they inherit widely.
2. **Separate workforce and workload identity.** Prefer Microsoft Entra federation/short-lived workforce access and managed identities for Azure workloads over stored secrets. Choose system- vs user-assigned identity based on lifecycle/ownership, grant least privilege, and check who may assign an identity to code-executing resources because assignment can confer its downstream permissions.
3. **Trace effective networking and DNS.** Model VNets/subnets, peerings/hubs, UDRs, NSGs, firewalls, load balancers/application gateways, private endpoints, Private DNS zones/links, NAT/egress and public-network settings. Prove both intended connectivity and denied paths.
4. **Choose topology from service/SKU reality.** Check whether the exact Azure service, region, tier and SKU support zonal or zone-redundant operation, autoscaling, maintenance, private connectivity and backup features. A resource in an availability-zone region is not resilient unless the deployed resource design actually uses the relevant zone-resilience capability.
5. **Keep secrets, keys and data ownership explicit.** Record Key Vault/key ownership, soft-delete/recovery implications, managed-identity access, database/storage replication scope, and dependency on subscription/tenant-level services.
6. **Make audit/monitoring durable.** Preserve Azure Activity Log plus required resource logs/metrics through Azure Monitor diagnostic settings to deliberate Log Analytics, Event Hubs and/or Storage destinations. Resource logs are not collected for analysis merely because the resource exists; verify diagnostic settings and ingestion.
7. **Design Regional recovery separately from zonal HA.** State RTO/RPO, target-region service/SKU availability, quotas, network/DNS, identities, keys/secrets, data copies/backups and failover/failback. Measure restore/failover behavior instead of treating geo-replication or backup configuration as recovery proof.
8. **Change with review and rollback evidence.** Preserve target tenant/subscription/region/resource IDs, policy/RBAC consequences, deployment diff, destructive/replacement operations, quota checks, deployment/activity-log result, and rollback or recovery path.

## Evidence

Record hierarchy/RBAC/policy inheritance, identity assignment and token principal, effective network/DNS path, service/SKU/zone topology, Azure Monitor diagnostic settings and received telemetry, quota/capacity state, restore/failover evidence, and reviewed deployment/rollback records. Recheck Microsoft Learn when behavior is region/SKU/version sensitive.

## Boundaries

- `cloud-security` owns privilege-escalation, unintended-public/cross-tenant access and control-effectiveness assessment; `azure-cloud` owns making Azure resource/control-plane configuration correct.
- `infrastructure-security` owns guest OS, node/container runtime and workload hardening; this skill owns Azure RBAC/Policy/VNet/PaaS control-plane semantics.
- `terraform-iac` owns HCL/providers/backends/state/import/moved/lifecycle mechanics; this skill owns whether the resulting Azure design is correct.
- `serverless-platforms` owns Azure Functions handler/runtime retries, duplicates, concurrency, cold starts and timeouts; this skill owns surrounding subscription, identity, network, key, monitor and quota behavior.
- `finops-cloud-cost` owns allocation, commitments/reservations, rightsizing programs and realized-savings measurement.

Use [the maintained source map](references/sources.md) for current Azure hierarchy, identity, zone-resilience and monitoring guidance.
