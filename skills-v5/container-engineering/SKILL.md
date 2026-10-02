---
name: container-engineering
description: Engineer OCI images and container process, filesystem, identity, and signal contracts. Use when editing Dockerfiles, image builds, entrypoints, or container portability; use kubernetes-operations for controller and cluster object behavior.
---

# Container Engineering

Treat the image and runtime configuration as a deployable process contract, not merely a packaging format. Resolve target platforms, runtime, base image identity, build inputs, application process semantics, writable paths, user/group expectations, network/port contract, and shutdown behavior before optimizing size.

## Engineering workflow

1. **Resolve immutable inputs.** Pin base images to an intentional version and, when reproducibility matters, digest. Record builder/frontend/runtime versions that affect semantics. Keep package-manager lockfiles and architecture-specific dependencies aligned with the target platform.
2. **Separate build from runtime.** Use multi-stage builds or equivalent to keep compilers, package managers, credentials, test artifacts, and caches out of the final root filesystem. Verify the final image rather than assuming an intermediate stage is absent.
3. **Define process semantics.** Prefer exec-form entrypoints for the real application process, avoid accidental shell/PID 1 behavior, and ensure SIGTERM reaches the application and exits within the platform's shutdown budget. If an init/reaper is required, make that dependency explicit.
4. **Define user and filesystem contracts.** Run with the least privilege the application supports, set ownership deliberately, identify every writable path, support read-only root filesystems when compatible, and keep runtime state in explicit volumes/tmpfs/mounts rather than relying on a mutable image layer.
5. **Bound runtime authority.** Avoid privileged mode, host namespaces/devices, broad capabilities, and unnecessary setuid/setgid content. Align host hardening with the actual runtime; image metadata alone does not prove isolation.
6. **Preserve portability.** Build/test the declared OS/architecture matrix. Distinguish amd64/arm64, libc/ABI, CPU features and native extensions, and inspect OCI index/manifest/config metadata.
7. **Keep secrets out of image history.** Use build-secret/SSH mounts or external credential mechanisms rather than ARG/ENV/COPY patterns that persist sensitive data into layers or history. `docker history`/image inspection is part of verification when secret handling is in scope.
8. **Verify from a clean context.** Build without undeclared files, inspect layers/config/user/entrypoint/platform, run as the intended user, test writable paths, send SIGTERM, and exercise relevant health behavior.

## Evidence and boundaries

For production or qualification images, record target platforms, immutable final base identity, build context, OCI config/history/layers, effective user, mounts, clean start, writable paths and SIGTERM behavior. A mutable tag alone is not pinned. When a machine readable contract is requested, encode every required positive and negative property explicitly, including absence of secrets and build tooling, read only root behavior, writable mounts, process identity, signal propagation and orphan behavior. Omission or null is not denial. Preserve independent inspectors and supplied corpora. Keep simulated checks labeled simulated; real build, start, signal and cleanup claims need their own observations.

- `supply-chain-security` owns provenance, signatures/attestations, SBOM integrity, dependency policy, and release-artifact trust. This skill owns the image/runtime contents and behavior being signed.
- `kubernetes-operations` owns pod/controller/probe/rollout/storage/network policy semantics after an image is deployed to Kubernetes.
- `infrastructure-security` owns host/runtime-daemon hardening and broader containment policy.
- `cicd-engineering` owns build/publish automation; this skill owns whether the produced image is correct and portable.
- Do not call an image secure solely because it is small, non-root, distroless, or signed; verify the property relevant to the actual threat/runtime contract.

Use [the maintained source map](references/sources.md) for OCI image/runtime contracts and current Docker build guidance.
