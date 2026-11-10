# Source map

`terraform-iac` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Terraform CLI/language/provider behavior is versioned; resolve the repository's required Terraform and provider versions before relying on newer syntax or plan behavior.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader architecture-planning.
- Routing: five positive, five near neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill pairing with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Terraform backend configuration**: https://developer.hashicorp.com/terraform/language/backend
  - Scope: Terraform latest backend documentation rechecked 2026-11-07.
  - Use: backend/state-location baseline and current CLI/language version context.
  - Verified: 2026-11-07; refresh after 21 days.
- **Terraform state storage and locking**: https://developer.hashicorp.com/terraform/language/state/backends
  - Scope: Terraform v1.16.x state/backend guidance checked 2026-10-20.
  - Use: remote state behavior, backend locking, and state recovery risk boundaries.
  - Verified: 2026-10-20; refresh after 45 days.
- **Terraform module refactoring**: https://developer.hashicorp.com/terraform/language/modules/develop/refactoring
  - Scope: current Terraform language guidance.
  - Use: `moved` blocks preserve resource identity and historical module upgrade paths; removing moves can be breaking.
  - Verified: 2026-09-05; refresh after 90 days.
- **Terraform import**: https://developer.hashicorp.com/terraform/language/import
  - Scope: current declarative import workflow checked 2026-10-20.
  - Use: import blocks plus matching resource configuration and plan verification before adoption.
  - Verified: 2026-10-20; refresh after 45 days.
- **Terraform plan**: https://developer.hashicorp.com/terraform/cli/commands/plan
  - Scope: Terraform v1.16.x plan guidance.
  - Use: speculative versus saved plans and the need to re-check changed state/input/provider context before apply.
  - Verified: 2026-11-03; refresh after 30 days.

## Interpretation rules

- Resolve Terraform CLI, provider/module versions, backend and workspace before state-affecting work.
- Never edit state JSON directly; prefer declarative import/moved configuration and supported state tooling with recovery evidence.
- A speculative plan is not the applied artifact. When automation relies on review, preserve and protect the exact saved plan or re-plan before apply.
- `ignore_changes` is shared-ownership configuration, not a generic drift suppressor; unexplained drift remains evidence to investigate.
