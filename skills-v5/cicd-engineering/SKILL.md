---
name: cicd-engineering
description: Engineer reproducible, permission bounded CI/CD pipelines and artifact handoffs. Use when build, test, cache, promotion, or deployment workflow mechanics are central; use release-planning for rollout policy and supply-chain-security for artifact trust assessment.
---

# CI/CD Engineering

Treat the pipeline as a privileged distributed system. A green job is evidence only for the exact revision, inputs, runner, dependencies, permissions, and artifact that job actually exercised.

When the caller requests a machine readable evidence artifact, copy every named ownership boundary into that artifact in explicit text. If signing, attestation, provenance, or artifact trust is adjacent, state that `supply-chain-security` owns that adequacy while CI/CD owns identity transport and enforcement. Do not leave the boundary only in prose outside the requested artifact.

## Workflow

When the task supplies a concrete contract, required fields, or artifact schema, satisfy that contract exactly while applying pipeline discipline; do not replace requested outputs with a different shape.

1. **Resolve platform and trust boundaries.** Identify GitHub Actions, GitLab CI/CD, or another concrete engine; triggering events; fork/untrusted-code paths; protected branches/tags/environments; runners; reusable workflow/includes; and who can modify pipeline definitions. State which decisions belong to CI/CD versus release planning, supply-chain security, Terraform/IaC, or the target platform, and carry those boundaries into any requested evidence artifact.
2. **Minimize pipeline authority by phase.** Validation jobs should normally have read-only repository permissions and no production credentials. Grant deployment identity only to jobs that need it and prefer short-lived federation/OIDC over stored cloud credentials. Do not expose privileged secrets to untrusted pull/merge-request code.
3. **Bind outputs to immutable source.** Build/test/package once from an exact commit and record artifact digests/metadata. Promote the same immutable artifact between environments when possible; do not silently rebuild mutable branch state for production and call it the same release.
4. **Separate cache from trusted artifact.** Cache keys must include every input that changes correctness, such as lockfiles, platform/architecture and relevant toolchain version. Name each cache key input as the correctness dimension itself, for example `lockfile`, `architecture`, and the toolchain or runtime version, rather than a provider-specific filename such as `bun.lockb`, so the key stays correct across tool versions and repository layout. Treat caches as disposable performance aids, not trusted release artifacts or provenance.
5. **Make gates explicit.** Encode required tests, policy/security checks, environment protection, branch/tag restrictions, approvals, wait/custom gates and secret availability. On GitHub, environment protection rules pass before a deployment job proceeds and environment secrets become available; on GitLab, protected environments constrain who may deploy.
6. **Control concurrency and cancellation.** Define what happens when two revisions target the same environment. Cancel obsolete validation safely, but serialize stateful/prod deployment when overlapping execution would race. Do not let a canceled predecessor delete or roll back a successor's deployment.
7. **Preserve deployment evidence and caller contracts.** Record exact commit, run ID, toolchain identity, artifact digest, environment, gates, deployment version, rollback target, and every exact artifact field or named boundary the task requests. `supply-chain-security` owns provenance and signing adequacy; CI/CD carries identity and enforcement. Before finishing, account for each requested field and boundary in the requested artifact.
8. **Exercise failures, not only success.** Test fork/untrusted events, test failure, canceled runs, expired/missing credentials, artifact mismatch, rejected environment gate, retry and rollback paths. Use an executable simulator, integration test, or captured command/test output that observes the state transitions; constructed JSON claims or constants alone do not demonstrate a failure or recovery path. If the simulator or required check fails, report that acceptance condition as unresolved rather than claiming the narrower checks passed. Verify that a retry cannot accidentally deploy a different revision or reuse stale privileged state.

## Boundaries

- `release-planning` owns rollout strategy, cohort progression, observation windows, go/no-go and rollback policy; this skill owns the pipeline mechanism that enforces those gates.
- `supply-chain-security` owns threat/provenance/signing/SBOM policy and adequacy; this skill owns workflow permissions, artifact transport and enforcement points.
- `terraform-iac` owns Terraform plan/state/apply semantics inside a pipeline; this skill owns job identity, approvals, saved-plan artifact transport and environment gating.
- `container-engineering` owns the image/runtime contract; this skill owns when/how the image is built, tested, stored and promoted.
- Cloud/Kubernetes skills own target-platform correctness after deployment.

Use [the maintained source map](references/sources.md) for current GitHub Actions and GitLab CI/CD semantics.
