---
name: infrastructure-security
description: Harden hosts, containers, orchestration, deployment configuration, and privileged access. Use when the task concerns host isolation, network policy, patching, or infrastructure security; use cloud-security for provider resource policy and supply-chain-security for build and provenance integrity.
---

# Infrastructure Security

Secure the substrate that runs application workloads. Start from the deployment topology and privilege boundaries, then reduce attack surface, privilege, reachability, mutable state, and unaudited administrative paths while preserving recovery and operability.

## Hardening workflow

1. **Inventory execution and control planes.** Record hosts/nodes, container runtime, orchestrator, namespaces, service accounts, privileged/admin interfaces, images/packages, storage mounts, host devices, ingress/egress paths, secrets mounts, logging/audit path, and patch/update ownership.
2. **Start from secure defaults.** Disable or remove unused services, packages, listeners, shells, capabilities, host mounts, privileged containers, and unauthenticated management endpoints. Treat exceptions as explicit, reviewable configuration rather than undocumented conventions.
3. **Minimize runtime privilege.** Use dedicated non-root identities, smallest required OS capabilities, read-only filesystems where feasible, `no-new-privileges`/equivalent controls, restricted device/host namespace access, and narrowly scoped service accounts. Separate administrative identities from workload identities.
4. **Constrain network reachability.** Define ingress and egress by workload/service need rather than broad subnet trust. Protect management/control-plane ports separately. Verify DNS/proxy/service-mesh behavior does not silently bypass the intended policy.
5. **Harden container/orchestrator policy.** Pin an explicit Pod Security Standards version appropriate to the cluster release, prefer Restricted where workloads support it, and document/exempt only named system components that require broader privilege. Add admission/config checks for image, hostPath, host namespaces, privilege escalation, capability, seccomp, and service-account assumptions as applicable.
6. **Patch and image deliberately.** Maintain supported base images/OS packages, define remediation SLAs by risk/exposure, rebuild rather than live-mutate immutable images where possible, and keep rollback/recovery available. Supply-chain provenance/signing remains with `supply-chain-security`.
7. **Protect and observe administration.** Require authenticated, least-privileged, auditable admin access; avoid shared root/admin credentials; log privilege elevation and configuration changes; and preserve an emergency path whose use is monitored and reviewed.
8. **Verify effective state.** Compare desired IaC/policy with runtime reality: listeners, identities, capabilities, mounts, network reachability, admission decisions, patch/image versions, and audit coverage. A secure-looking manifest is not proof of the running configuration.

## Boundaries

For each changed control, pair the effective configuration with an allowed operation, a denied operation, and a recovery check that preserves service operation. Retain command output or runtime observations for identity, reachability, admission and audit claims. Where only a manifest or simulator is available, report those limits explicitly and leave deployment claims unverified. A boolean assertion that a control is enabled cannot establish its enforcement or recovery behavior.

Model the administrative ingress source separately from ordinary workload traffic. An application need for dependencies does not authorize access to management endpoints. Enumerate necessary dependency destinations and ports and test a denied neighbor; a flag claiming explicit egress is insufficient without those concrete paths.

- `cloud-security` owns AWS/GCP/Azure account/project/org IAM, resource policies, managed-service exposure, cloud KMS integration, and cloud control-plane posture.
- `supply-chain-security` owns dependency/build/provenance/signing/attestation integrity before artifacts reach runtime.
- `secrets-key-management` owns key/secret lifecycle; this skill ensures infrastructure does not overexpose those secrets at runtime.
- `embedded-device-security` owns device secure boot/update/debug/physical lifecycle rather than server/cluster hardening.
- `security-verification` owns final evidence that the deployed controls behave as intended.

Use [the maintained source map](references/sources.md) for NIST infrastructure/container guidance, Kubernetes Pod Security Standards, and secure-default principles.
