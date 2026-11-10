# Source map

`infrastructure-security` owns host/container/orchestrator/network/deployment hardening and effective runtime state. Cloud-provider policy and build provenance remain separate.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review; narrower children cloud-security, secrets-key-management.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with seven falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST SP 800-53 Rev. 5, Release 5.2.0**: https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
  - Scope: Rev. 5 control catalog with 5.2.0 updates published August 2025.
  - Use: least privilege, configuration management, audit/accountability, communications/system protection, and system integrity concepts.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST SP 800-190: Application Container Security Guide**: https://csrc.nist.gov/pubs/sp/800/190/final
  - Scope: current final NIST container-security publication as verified 2026-09-05.
  - Use: container image/runtime/orchestrator/host risk model and defense-in-depth recommendations.
  - Verified: 2026-09-05; refresh after 365 days.
- **Kubernetes Pod Security Standards**: https://kubernetes.io/docs/concepts/security/pod-security-standards/
  - Scope: Kubernetes documentation modified 2026-08-02.
  - Use: Privileged/Baseline/Restricted workload security controls. Pin the enforcement version for reproducible production policy evidence.
  - Verified: 2026-11-07; refresh after 60 days.
- **Kubernetes Network Policies**: https://kubernetes.io/docs/concepts/services-networking/network-policies/
  - Scope: Kubernetes official networking documentation for pod ingress/egress isolation and additive policy behavior.
  - Use: Define explicit workload paths, default-deny posture, DNS/dependency allowances, and the requirement to verify that a network plugin actually enforces the policy.
  - Verified: 2026-10-17; refresh after 60 days.
- **Kubernetes Security Checklist**: https://kubernetes.io/docs/concepts/security/security-checklist/
  - Scope: Kubernetes official cluster and workload security checklist.
  - Use: Cross-check API exposure, service accounts, pod security, network policy, audit, node, and runtime assumptions without treating checklist completion as runtime proof.
  - Verified: 2026-10-17; refresh after 60 days.
- **NIST SP 800-41 Rev. 1: Guidelines on Firewalls and Firewall Policy**: https://csrc.nist.gov/pubs/sp/800/41/r1/final
  - Scope: NIST firewall policy guidance for host and network traffic controls; published 2009 and still the current final revision at verification.
  - Use: Separate management and service paths, document policy ownership, define default/exception behavior, and test deployed firewall behavior.
  - Verified: 2026-10-17; refresh after 365 days.
- **Docker Engine security**: https://docs.docker.com/engine/security/
  - Scope: Docker's official security guidance for daemon exposure, namespaces/cgroups, capabilities, MAC profiles, user namespaces, and container configuration.
  - Use: Runtime hardening concepts; adapt to the actual container engine and record unsupported or unobserved controls.
  - Verified: 2026-10-17; refresh after 180 days.
- **systemd.exec**: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
  - Scope: Official systemd execution-environment reference for service identity, filesystem/device/namespace restrictions, capabilities, and `NoNewPrivileges`.
  - Use: Linux service-fleet hardening where systemd is the enforcement point; confirm the host's installed systemd version supports each directive.
  - Verified: 2026-11-03; refresh after 180 days.
- **CISA Secure by Design / Secure by Default**: https://www.cisa.gov/sites/default/files/2023-06/principles_approaches_for_security-by-design-default_508c.pdf
  - Scope: CISA principles available 2026-11-07.
  - Use: secure defaults as the product/runtime baseline rather than optional operator hardening.
  - Verified: 2026-11-07; refresh after 365 days.

## Interpretation rules

- Verify runtime effective state, not only IaC/manifests.
- Treat network placement as a constraint, never as implicit application authorization.
- Version-pin security policies where `latest` could drift behavior between cluster upgrades and evidence collection.
- Minimize service and admin privilege separately; emergency access must be auditable and converge back to managed state.
- Treat policy-provider support as a prerequisite: a Kubernetes `NetworkPolicy`, seccomp profile, MAC profile, host firewall rule, or service-manager directive has no enforcement evidence until the actual provider/runtime reports the decision or a controlled probe demonstrates it.
- Preserve an evidence tuple for each control: desired/version, enforcement decision, observed state, allowed control, denied control, recovery result, and unavailable boundary. Synthetic fixtures and policy compilation are useful negative controls but are not deployment receipts.
- Keep provider IAM/resource policy and artifact provenance in their specialist packages.
