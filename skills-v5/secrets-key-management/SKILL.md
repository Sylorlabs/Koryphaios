---
name: secrets-key-management
description: Govern secrets and keys through custody, delivery, rotation, revocation, recovery, and destruction. Use when designing secret management, KMS policy, or credential lifecycle; use applied-cryptography for primitive composition and cloud-security for broader IAM posture.
---

# Secrets and Key Management

Treat keys and credentials as stateful security assets with an explicit owner, purpose, custody boundary, consumers, version, lifecycle, compromise blast radius, and recovery path. “Stored in a secret manager” is only one part of the design.

## Lifecycle workflow

1. **Inventory and classify.** Record each secret/key purpose, owner, environment/tenant scope, consumers, generation source, storage/custody system, exportability, rotation trigger/period, revocation semantics, backup/replication needs, and destruction requirements. Separate authentication credentials, API keys, database credentials, signing keys, wrapping keys, and data-encryption keys.
2. **Generate and keep roots in trusted custody.** Generate cryptographic keys with an approved secure random source in KMS/HSM or an equivalent protected boundary when the risk requires it. Prefer non-exportable root/wrapping/signing keys. Do not copy long-lived private material into source control, CI variables, disk images, logs, or developer machines merely for convenience.
3. **Build a hierarchy with explicit purpose.** Use envelope encryption when appropriate: KMS/HSM key-encryption keys protect per-object/tenant/data keys. Persist the exact key/version/wrapped-key metadata required to decrypt historical data; aliases can select a current write key but must not make old ciphertext ambiguous.
4. **Separate administration from use.** Distinguish principals that may administer/rotate/delete keys from workloads that may encrypt/decrypt/sign/verify. Give workloads purpose-specific identities and narrow key grants/conditions. Avoid shared standing credentials and wildcard secret access.
5. **Deliver secrets safely.** Prefer workload identity and dynamic/short-lived credentials when available. For delivered secrets, minimize lifetime and process exposure; avoid command-line arguments, logs, crash dumps, broad environment inheritance, world-readable files, and unnecessary replicas. Define bootstrap/root-secret handling separately.
6. **Rotate with compatibility in mind.** Distinguish rotating the key reference used for new writes from re-encrypting/rewrapping old data or replacing a credential at all consumers. Use dual-read/dual-valid or staged cutover only when the protocol supports it, then retire the old credential/key intentionally. Rotation that leaves stale consumers is an outage or bypass, not completion.
7. **Revoke and respond to compromise.** Identify what a compromised key/credential can access, which dependent secrets/data/tokens must be invalidated or rewrapped, how quickly revocation propagates, and how service is recovered. Preserve audit evidence and avoid deleting the only key needed for legally/operationally retained ciphertext before migration is complete.
8. **Back up, recover, and destroy deliberately.** Document HSM/KMS regional/tenant failure behavior, key backup/escrow where policy permits, disaster recovery tests, deletion waiting periods, retention/legal holds, and cryptographic erasure assumptions. Destruction must include replicas/exported copies and downstream cached credentials where applicable.
9. **Audit both administration and use.** Record secret/key creation, policy/grant change, rotation, disable/delete scheduling, unusual decrypt/sign volume, and break-glass use. Protect audit destinations from the same principals being observed where practical.

## Boundaries

- `applied-cryptography` owns AEAD/signature/KDF/nonce/domain/serialization design. This skill owns custody and lifecycle of the key material those constructions consume.
- `cloud-security` owns organization/account/project IAM and broader managed-resource posture; this skill owns the key/secret resource lifecycle even when the implementation is cloud KMS.
- `secure-authentication` owns end-user authenticator lifecycle; service/database/API credentials remain here.
- `supply-chain-security` owns build/provenance/signing-policy trust in the pipeline; this skill owns custody/rotation of signing keys used by that pipeline.
- `security-verification` owns final runtime proof of key/secret controls.

Use [the maintained source map](references/sources.md) for NIST key lifecycle guidance, cloud KMS operational guidance, and OWASP secret-management patterns.
