---
name: kubernetes-operations
description: Operate Kubernetes workloads and clusters with explicit controller, rollout, resource, policy, and recovery boundaries. Use when Kubernetes APIs, manifests, version skew, or cluster behavior determine the result; use container-engineering for image and runtime construction independent of Kubernetes.
---

# Kubernetes Operations

Kubernetes is a reconciliation system. Work from the desired-state owner, exact cluster/API version, active controllers, and observed object state; do not reason from YAML alone when admission, defaulting, mutation, scheduling, or controllers can change the effective configuration.

## Operational workflow

1. **Resolve version and ownership.** Record server version, supported release branch, API versions, distribution/provider, node versions, CNI/CSI/ingress or Gateway implementation, autoscaler, admission controllers, and whether source of truth is raw manifests, Kustomize, Helm, GitOps, an operator, or a higher-level platform. Respect Kubernetes version-skew rules rather than assuming every component can be upgraded independently.
2. **Model the controller contract.** Choose Deployment, StatefulSet, DaemonSet, Job/CronJob, custom controller, or another primitive from workload semantics. Identify immutable fields, rollout strategy, revision history, ownership labels/selectors, termination behavior, restartability, and what reconciliation should do after partial failure.
3. **Make scheduling and capacity explicit.** Set realistic CPU/memory requests, intentional limits, topology/affinity and taints/tolerations, priority/preemption where required, storage topology, and node/zone constraints. Distinguish scheduler fit from runtime resource pressure. HPA/VPA/cluster-autoscaler behavior must be reasoned about together when they interact.
4. **Separate startup, readiness, and liveness.** Readiness controls traffic eligibility; liveness requests restart; startup protects slow initialization. Probe the dependency that reflects the intended contract without creating restart storms or hiding an unavailable dependency behind a shallow process-alive check.
5. **Design disruption and rollout together.** Account for maxUnavailable/maxSurge, PodDisruptionBudget semantics, replicas, readiness gates, topology spread, graceful termination, connection draining, and involuntary node loss. A PDB does not protect against every outage and does not make a single replica highly available.
6. **Treat networking as implementation plus policy.** Trace Service selection, EndpointSlices, DNS, ingress/Gateway routes, load balancer health, source IP or proxy semantics, NetworkPolicy support in the installed CNI, egress dependencies, and cross-namespace traffic. Verify policy with actual allow/deny connections; manifest presence is not proof that the CNI enforces it.
7. **Treat storage as a lifecycle contract.** Resolve StorageClass, access modes, binding mode, topology, reclaim policy, expansion, snapshots/backups, StatefulSet identity, attachment constraints, and restore procedure. Test the failure that matters: pod replacement, node loss, zone loss, volume reattachment, or data restore.
8. **Use admission and policy deliberately.** Identify Pod Security Admission, validating/mutating admission, policy engines, RBAC/service accounts, image policy, secret/config injection, and namespace boundaries. Keep infrastructure-security responsible for broader hardening and threat posture while this skill verifies the Kubernetes mechanism actually in use.
9. **Upgrade by supported skew and API compatibility.** Inventory removed/deprecated APIs, admission/webhook compatibility, CRD/controller support, kubelet/control-plane skew, and add-on compatibility before changing versions. Exercise a representative canary/rollback or non-production upgrade path and preserve `kubectl`, events, rollout, and controller evidence.

## Evidence

Prefer server-side rendered/effective objects, `kubectl get/describe/events`, rollout history/status, scheduler and controller conditions, EndpointSlices, policy connection probes, storage attachment/state, metrics used by autoscaling, and recovery results. Record when evidence is from a local renderer or simulator instead of a representative cluster.

## Boundaries

- `container-engineering` owns image build/runtime packaging, OCI metadata, and container-runtime concerns before Kubernetes consumes the image.
- `infrastructure-security` owns host/cluster hardening and broader security posture; this skill owns Kubernetes resource, admission, RBAC/service-account, and network-policy behavior needed to operate the workload.
- `observability-sre` owns service-level telemetry/SLO design; this skill uses Kubernetes events, conditions, and workload telemetry to diagnose controller/platform behavior.
- `cicd-engineering` or GitOps-specific work owns delivery automation; this skill owns whether the rendered/applied Kubernetes state behaves correctly.
- Cloud-provider skills own provider control planes and managed-service specifics; this skill owns Kubernetes semantics once the target cluster and integrations are identified.

Use [the maintained source map](references/sources.md) for the current supported release branches, version-skew policy, workload/disruption semantics, and API guidance.
