# Source map

`container-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound OCI artifact/runtime semantics and current Docker build practice; the actual builder, runtime, base image, target platform and observed image/runtime behavior remain authoritative for a concrete claim.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing contract: five positive, five negative cases that are near neighbors, three compound/ambiguous, and three adversarial held out cases, distinct from the public examples. Resolver observations must be recorded separately from these authored expectations.
- Evaluation contract: two individual scenarios with six falsifiable checks each, pairing of skill and no skill runs of the same model, regression retention, and blind semantic judging. The current synthetic fixtures and scorer limitations are documented in [the evaluation boundary](../evals/README.md); their registration does not establish runtime qualification.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OCI Image Specification 1.1.1**: https://specs.opencontainers.org/image-spec/?v=v1.1.1
  - Scope: version 1.1.1 released 2025-04-02.
  - Use: manifests, indexes, image config, layers, descriptors and artifact structure for multiple platforms.
  - Verified: 2026-09-05; refresh after 180 days.
- **OCI Runtime Specification 1.3.0**: https://specs.opencontainers.org/runtime-spec/?v=v1.3.0
  - Scope: version 1.3.0 released 2025-11-04.
  - Use: runtime config, process/user/capabilities/mounts/namespaces and lifecycle semantics.
  - Verified: 2026-09-05; refresh after 180 days.
- **Docker Build best practices**: https://docs.docker.com/build/building/best-practices/
  - Scope: rolling Docker documentation as available 2026-11-07.
  - Use: build context, base images, builds with multiple stages, caching, package installation and practical Dockerfile structure.
  - Verified: 2026-11-07; refresh after 60 days.
- **Docker Build secrets**: https://docs.docker.com/build/building/secrets/
  - Scope: rolling documentation retrieved 2026-10-17.
  - Use: temporary secret/SSH delivery to a build step instead of persistent ARG/ENV values. Adopt the delivery mechanism; still inspect how the consumer handles its contents.
  - Verified: 2026-10-17; refresh after 60 days.
- **Docker builds for multiple platforms**: https://docs.docker.com/build/building/multi-platform/
  - Scope: rolling documentation retrieved 2026-10-17.
  - Use: index and child manifests, native nodes, emulation, cross compilation, and builder image store/export support. Adopt explicit build versus target platform selection; do not treat an emulated smoke test as native production proof.
  - Verified: 2026-10-17; refresh after 60 days.
- **Dockerfile reference**: https://docs.docker.com/reference/dockerfile/
  - Scope: rolling documentation retrieved 2026-10-17; feature support depends on frontend, builder, engine, and target OS.
  - Use: `ENTRYPOINT`/`CMD`, argument preservation, `USER`, `STOPSIGNAL`, `HEALTHCHECK`, `EXPOSE`, and build mounts. Adopt the defined semantics; confirm behavior in the actual produced image and runtime.
  - Verified: 2026-10-17; refresh after 60 days.

## Interpretation rules

- Separate guarantees of the OCI format from Docker/BuildKit/containerd/runc implementation behavior; identify the actual builder/runtime before making claims specific to the implementation.
- Inspect the final image/index/config and history rather than inferring final contents from Dockerfile intent.
- Support for multiple platforms requires real dependency/runtime compatibility for each declared platform, not only a manifest that lists multiple architectures.
- An image that runs without a root user is not proof of host/container isolation; broader runtime/host hardening belongs to infrastructure-security.
- Keep provenance/signature/SBOM verification in supply-chain-security while preserving the exact digest/artifact identity it protects.
- Official examples may use mutable tags or host setup commands for illustration. They do not replace the project's pinning requirements or authorize changing the host, Docker context, or privileged emulation registration.
- The additional Docker sources support [the runtime verification protocol](runtime-verification.md). Documentation retrieval establishes source support, not a fresh image build, runtime test, scanner pass, or measured skill improvement.
