# Source map

`cicd-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Workflow-engine behavior and hosted features change quickly, so platform-specific permissions, environment gates and credential behavior must be refreshed against the repository's actual CI/CD engine.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader release-planning.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GitHub Actions: Deployments and environments**: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
  - Scope: rolling GitHub Actions documentation as available 2026-09-05.
  - Use: required reviewers, wait/custom protection rules, branch/tag restrictions and environment-secret gating.
  - Verified: 2026-09-05; refresh after 21 days.
- **GitHub Actions: OIDC in cloud providers**: https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-cloud-providers
  - Scope: rolling GitHub Actions OIDC guidance as available 2026-09-05.
  - Use: short-lived federated deployment credentials and claim scoping instead of static cloud secrets.
  - Verified: 2026-09-05; refresh after 21 days.
- **GitLab protected environments**: https://docs.gitlab.com/ci/environments/protected_environments/
  - Scope: rolling GitLab CI/CD documentation as available 2026-09-05.
  - Use: production/deployment environment authorization and Allowed to deploy boundary.
  - Verified: 2026-09-05; refresh after 21 days.
- **Google SRE: Release Engineering**: https://sre.google/sre-book/release-engineering/
  - Scope: chapter as available 2026-09-05.
  - Use: reproducible/automated builds, tests, release consistency, canarying and rollback-oriented delivery principles.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Resolve the actual CI/CD provider, triggering event, runner model, trust boundary and environment feature availability before editing a workflow.
- Treat untrusted contribution code as untrusted even when the pipeline YAML itself is trusted; do not expose deployment authority to fork/MR validation paths.
- Bind promotion to immutable revision/artifact identity. Caches are disposable performance aids, not release artifacts.
- Separate workflow-mechanism evidence from release-policy and supply-chain-security verdicts even when one task composes them.
