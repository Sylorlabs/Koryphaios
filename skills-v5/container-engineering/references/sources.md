# Source map

`container-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound OCI artifact/runtime semantics and current Docker build practice; the actual builder, runtime, base image, target platform and observed image/runtime behavior remain authoritative for a concrete claim.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OCI Image Specification 1.1.1**: https://specs.opencontainers.org/image-spec/?v=v1.1.1
  - Scope: version 1.1.1 released 2025-04-02.
  - Use: manifests, indexes, image config, layers, descriptors and multi-platform artifact structure.
  - Verified: 2026-09-05; refresh after 180 days.
- **OCI Runtime Specification 1.3.0**: https://specs.opencontainers.org/runtime-spec/?v=v1.3.0
  - Scope: version 1.3.0 released 2025-11-04.
  - Use: runtime config, process/user/capabilities/mounts/namespaces and lifecycle semantics.
  - Verified: 2026-09-05; refresh after 180 days.
- **Docker Build best practices**: https://docs.docker.com/build/building/best-practices/
  - Scope: rolling Docker documentation as available 2026-09-05.
  - Use: build context, base images, multi-stage builds, caching, package installation and practical Dockerfile structure.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- Separate OCI-format guarantees from Docker/BuildKit/containerd/runc implementation behavior; identify the actual builder/runtime before making implementation-specific claims.
- Inspect the final image/index/config and history rather than inferring final contents from Dockerfile intent.
- Multi-platform support requires real dependency/runtime compatibility for each declared platform, not only a multi-architecture manifest.
- A non-root image is not proof of host/container isolation; broader runtime/host hardening belongs to infrastructure-security.
- Keep provenance/signature/SBOM verification in supply-chain-security while preserving the exact digest/artifact identity it protects.
