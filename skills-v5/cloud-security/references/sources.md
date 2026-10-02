# Source map

`cloud-security` owns public-cloud organization/account/project IAM, managed-resource policies, exposure, guardrails, and control-plane evidence. Host/container internals, application authorization, and key lifecycle remain separate.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader infrastructure-security.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **AWS Well-Architected Framework: Security Pillar**: https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html
  - Scope: current AWS documentation available 2026-09-05.
  - Use: AWS security foundations, identity/access management, detection, infrastructure/data protection, and incident preparation.
  - Verified: 2026-09-05; refresh after 90 days.
- **AWS IAM security best practices**: https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
  - Scope: current IAM guidance available 2026-09-05.
  - Use: federation/temporary credentials, MFA, least privilege, Access Analyzer, conditions, and organization guardrails.
  - Verified: 2026-09-05; refresh after 90 days.
- **Google Cloud: Use IAM securely**: https://cloud.google.com/iam/docs/using-iam-securely
  - Scope: current guidance available 2026-09-05.
  - Use: Workforce/Workload Identity Federation, service-account key avoidance, least privilege, roles/conditions, and resource hierarchy practices.
  - Verified: 2026-09-05; refresh after 90 days.
- **Microsoft Cloud Security Benchmark v2**: https://learn.microsoft.com/en-us/security/benchmark/azure/overview
  - Scope: current Microsoft cloud security benchmark overview available 2026-09-05.
  - Use: Azure/multicloud network, identity, privileged access, data, asset, logging, posture, endpoint, backup, DevOps, and governance control domains.
  - Verified: 2026-09-05; refresh after 90 days.

## Interpretation rules

- Evaluate effective permission from identity, resource, organization, boundary/session, and trust policies together.
- Prefer federated short-lived human/workload credentials over downloadable long-lived access keys where the provider supports it.
- Validate public exposure and routing from actual resource configuration/effective paths, not only architecture diagrams.
- Protect the audit destination from the principals it observes when feasible.
- Keep runtime pod/host hardening, application user authorization, artifact provenance, and key lifecycle in their dedicated skills.
