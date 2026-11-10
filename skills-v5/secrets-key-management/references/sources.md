# Source map

`secrets-key-management` owns custody and lifecycle of cryptographic keys and service credentials. Cryptographic construction semantics, cloud posture, end-user authenticators, and build-provenance policy remain separate.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader infrastructure-security.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST SP 800-57 Part 1 Rev. 5: Recommendation for Key Management**: https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
  - Scope: May 2020 current final general key-management guidance as verified 2026-11-07.
  - Use: key lifecycle, cryptoperiod, protection, compromise, backup/recovery, archival, and destruction principles.
  - Verified: 2026-11-07; refresh after 365 days.
- **AWS KMS best practices**: https://docs.aws.amazon.com/kms/latest/developerguide/best-practices.html
  - Scope: AWS documentation available 2026-09-05.
  - Use: key policy/grant least privilege, operational access, deletion/rotation, and managed-key administration practices.
  - Verified: 2026-09-05; refresh after 90 days.
- **Google Cloud Key Management Service**: https://cloud.google.com/kms/docs/key-management-service
  - Scope: Google Cloud KMS documentation available 2026-09-05.
  - Use: key rings/keys/versions, primary-version rotation, IAM, HSM-backed keys, import/destruction, and key-version lifecycle.
  - Verified: 2026-09-05; refresh after 90 days.
- **OWASP Secrets Management Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
  - Scope: current OWASP guidance available 2026-11-07.
  - Use: secret inventory, centralized storage, least privilege, dynamic credentials, rotation, revocation, audit, and delivery/logging pitfalls.
  - Verified: 2026-11-07; refresh after 120 days.

## Interpretation rules

- An alias/current-primary reference is convenient for new writes, but historical encrypted data needs an unambiguous key/version reference.
- Rotation, rewrap, re-encryption, credential replacement, revocation, and destruction are distinct lifecycle events with different proof obligations.
- Prefer workload identity and short-lived/dynamic credentials over copied long-lived secrets where the platform supports it.
- Separate key administration from routine key use when the risk warrants it, and preserve audit evidence for both.
- Never destroy the only key required for retained data before dependency/migration checks demonstrate that destruction is safe.
