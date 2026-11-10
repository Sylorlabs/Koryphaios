---
name: terraform-iac
description: Engineer Terraform configuration, state, plans, imports, drift, and recovery. Use when Terraform or HCL mechanics determine correctness; compose a cloud provider skill for resource semantics, but do not select this skill for provider configuration or delivery planning alone.
---

# Terraform IaC

Terraform correctness is the relationship among configuration, provider schemas, remote objects, and state. Never reason about HCL in isolation from the backend/workspace and plan that will actually be applied.

## Workflow

1. **Identify the execution context.** Capture Terraform CLI version, provider/module versions and lockfile, root module, backend, workspace/state key, target account/project/subscription, credential identity and CI identity without exposing secrets. Verify the repository's required version before adopting new syntax. When the task or repository fixture explicitly supplies those facts, record them as observed task evidence even if no external Terraform runtime is available; label the source as fixture/task supplied instead of erasing valid contract facts as "unavailable".
2. **Protect state before changing ownership.** Prefer a secured remote backend with appropriate locking. Never hand-edit state JSON. Treat `state push`, `force-unlock`, backend migration and state-address changes as high-risk operations requiring exact lineage/workspace/lock evidence and a recovery copy where appropriate.
3. **Adopt existing resources declaratively.** Use `import` blocks plus matching resource configuration when supported. Plan the import and reconcile configuration until the post-import plan does not unintentionally change or destroy the object. Provider-specific import identities belong to the provider documentation.
4. **Refactor addresses with `moved` blocks.** Preserve resource identity during module/resource renames and splits. Removing historical `moved` blocks can be a breaking module change for users that have not traversed that move; preserve the upgrade path deliberately.
5. **Treat lifecycle meta arguments as contracts.** Use `prevent_destroy` sparingly for costly stateful resources, and `ignore_changes` only for attributes intentionally managed by another authority. Do not use lifecycle settings to hide unexplained drift or make a destructive plan look clean.
6. **Plan against the intended state.** Run formatting/validation and a real plan with the intended backend/workspace/providers. Inspect creates, updates, replacements, destroys, unknown values, sensitive outputs and imports/moves. A speculative plan is review evidence, not a guarantee that later apply sees identical remote state.
7. **Apply the reviewed artifact deliberately.** In automation, a saved plan can bind apply to the reviewed operations. Protect the plan artifact because it can contain sensitive values and is executable without another approval prompt. Plan again when state, inputs, code or provider context changed.
8. **Verify convergence and recovery.** After apply/import/refactor, prove expected outputs/resources, run a fresh plan for unexpected residual drift, test module contracts where possible, and preserve state/backend recovery evidence. Never equate `apply` exit success with service correctness; provider skills and reliability verification own those claims.

When a task requests a structured evidence artifact, satisfy its exact schema before adding narrative. Preserve task-provided version, lockfile, backend, workspace, resource-address, move-history and recovery fields exactly when they are part of the exercise contract. Do not modify evaluator-owned fixtures, simulators, tests or harness code unless the task explicitly authorizes those files; confine implementation to the requested Terraform configuration and evidence outputs.

## Boundaries

Retain the evidence behind adoption and recovery claims: state lineage and serial, owning backend, existing resource identities, module contracts, import or move history, lifecycle exceptions, formatting and validation output, and the reviewed plan operations. A recovery copy needs observed existence, matching lineage and a usable restoration procedure; exercise restoration only in an authorized disposable environment. Distinguish proposed, simulated, planned and applied states, and distinguish independently observed external-runtime evidence from task-supplied synthetic evidence. If apply or recovery is unavailable, keep that limitation in the verdict instead of replacing it with a success flag.

- `aws-cloud`, `gcp-cloud`, and `azure-cloud` own whether provider resources, identity, networking and managed-service topology are semantically correct; this skill owns how Terraform represents and changes them.
- `cicd-engineering` owns workflow orchestration, approvals, runners, artifacts and credentials around Terraform; this skill owns the Terraform plan/state/apply contract inside that pipeline.
- `migration-planning` owns application/data/contract coexistence and cutover; Terraform state moves/imports alone are not general system migrations.
- `cloud-security` owns security posture assessment. Terraform can implement controls but the security verdict needs its own evidence.

Use [the maintained source map](references/sources.md) for versioned Terraform language and CLI behavior.
