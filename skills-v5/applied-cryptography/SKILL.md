---
name: applied-cryptography
description: Compose standard cryptography with correct nonces, key derivation, signatures, and authenticated data. Use when designing encryption or signature protocols; use secrets-key-management for key lifecycle and networking-systems for standard secure channel configuration.
---

# Applied Cryptography

Prefer a well-reviewed protocol or library construction over assembling primitives. Start from the required security property and attacker model, then choose a standard construction whose nonce, key, domain, encoding, and failure rules the application can actually satisfy.

## Design workflow

1. **State the property and threat model.** Distinguish confidentiality, integrity/authenticity, origin authentication, non-repudiation claims, password-based key derivation, key agreement, at-rest envelope encryption, and transport/session security. Record which endpoints/keys are trusted and what compromise must or cannot protect against.
2. **Use approved/current constructions.** Prefer AEAD for new symmetric authenticated encryption. Use standard signature and KDF APIs rather than raw primitives. Do not invent encryption modes, signature encodings, padding schemes, or bespoke handshake protocols.
3. **Design key separation.** Distinct purposes should have distinct keys or KDF-derived subkeys with explicit context/domain labels. Do not reuse one raw key across encryption, MAC, signing, unrelated tenants, or protocol roles without a standard construction that defines it.
4. **Make nonce/IV rules impossible to violate casually.** For AES-GCM, nonce uniqueness under a key is critical; define generation/allocation, persistence across restart, concurrency, cloning/restore, and rotation before deployment. If the application cannot guarantee the primitive's nonce requirement, select a construction/API whose misuse profile matches reality rather than hoping random generation is sufficient.
5. **Authenticate context.** Bind version, tenant/object identity, algorithm/key identifier, sequence/purpose, and other immutable metadata as associated data or signed context when changing that metadata would change meaning. Prevent ciphertext/signature substitution across domains.
6. **Canonicalize signed/verified bytes.** Specify exact serialization and encoding before signing or hashing. Verify algorithm/key identity and signature before trusting parsed semantic content when the protocol requires exact-byte authenticity.
7. **Handle secrets and failures safely.** Use cryptographically secure randomness from the platform/library; compare authenticators using safe library APIs; reject verification/authentication failures without processing unauthenticated plaintext; and avoid distinguishable error channels where they expose protected information.
8. **Plan migration.** Version the cryptographic envelope/protocol, record algorithm and key identifiers without permitting attacker-chosen downgrade, and define how old data is read/re-encrypted/re-signed when algorithms or keys change.

## Boundaries

- `secrets-key-management` owns key generation/custody in KMS/HSM, key hierarchy, access policy, wrapping, rotation, revocation, backup, audit, and destruction. This skill specifies the cryptographic use of those keys.
- `oauth-oidc` owns JWT/token/federation protocol rules; applied cryptography should not replace protocol-defined verification requirements.
- `secure-authentication` owns password/passkey/MFA lifecycle. Password hashing/KDF selection may compose this skill, but login/recovery assurance remains there.
- `networking-systems` owns TLS/QUIC connectivity and secure-channel configuration; use `application-security` when assessing the channel's trust boundary rather than designing a cryptographic construction.
- `security-verification` owns final runtime proof of the cryptographic behavior.

Use [the maintained source map](references/sources.md) for AES, GCM, signature, KDF, and key-management boundaries.
