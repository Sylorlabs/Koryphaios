# Source map

`kubernetes-operations` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound release/version-skew and core workload/disruption semantics; the actual distribution, server version, installed controllers/CNI/CSI, admission chain, and observed cluster state remain authoritative for a concrete claim.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Kubernetes Releases**: https://kubernetes.io/releases/
  - Scope: as of 2026-09-05, maintained branches are 1.37, 1.36, and 1.35; 1.37.0 released 2026-08-26.
  - Use: resolve current supported minor/patch status before version-sensitive operational guidance.
  - Verified: 2026-09-05; refresh after 30 days.
- **Kubernetes Version Skew Policy**: https://kubernetes.io/releases/version-skew-policy/
  - Scope: current supported-version skew policy as available 2026-09-05.
  - Use: control-plane, kubelet, kube-proxy, and kubectl compatibility during upgrades.
  - Verified: 2026-09-05; refresh after 60 days.
- **Deployments**: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
  - Scope: Kubernetes 1.37 documentation as available 2026-09-05.
  - Use: rollout strategy, availability, progress, revision history, pause/resume, and rollback semantics.
  - Verified: 2026-09-05; refresh after 60 days.
- **Disruptions / PodDisruptionBudget**: https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
  - Scope: Kubernetes 1.37 documentation as available 2026-09-05.
  - Use: voluntary/involuntary disruption and PDB behavior; prevents treating PDBs as universal availability guarantees.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- Resolve the target server/distribution and installed add-ons before using release-specific behavior; provider-managed Kubernetes can constrain upgrade timing and enabled features.
- Rendered YAML is not the final state when admission/defaulting/controllers mutate or reject it; inspect effective objects and conditions.
- A NetworkPolicy object is not evidence of enforcement unless the installed CNI implements the intended policy and the allow/deny flows are tested.
- A PDB governs voluntary eviction availability, not arbitrary failures; combine it with replicas, rollout settings, topology, and application termination/readiness behavior.
- Label local rendering, kind/minikube, fake clients, or simulators explicitly when hardware/network/storage/controller behavior differs from the representative target cluster.
