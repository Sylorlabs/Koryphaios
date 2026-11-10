# Source map

`applied-cryptography` owns cryptographic composition and protocol/format semantics. KMS/HSM custody and key lifecycle remain with `secrets-key-management`.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **FIPS 197-upd1: Advanced Encryption Standard**: https://csrc.nist.gov/pubs/fips/197/final
  - Scope: updated May 2023; no technical algorithm changes to AES.
  - Use: AES primitive definition; use an approved authenticated mode rather than raw AES for application confidentiality/integrity.
  - Verified: 2026-11-07; refresh after 365 days.
- **NIST SP 800-38D: GCM/GMAC**: https://csrc.nist.gov/pubs/sp/800/38/d/final
  - Scope: 2007 final remains current as of 2026-09-05; NIST has announced revision work/decisions that are not yet a replacement final publication.
  - Use: GCM authenticated-encryption and IV/nonce requirements, especially uniqueness under a key.
  - Verified: 2026-09-05; refresh after 120 days.
- **FIPS 186-5: Digital Signature Standard**: https://csrc.nist.gov/pubs/fips/186-5/final
  - Scope: February 2023 current standard.
  - Use: approved digital-signature algorithm framework and verification requirements.
  - Verified: 2026-11-07; refresh after 365 days.
- **NIST SP 800-56C Rev. 2: Key-Derivation Methods**: https://csrc.nist.gov/pubs/sp/800/56/c/r2/final
  - Scope: August 2020 current final.
  - Use: extraction/expansion KDF constructions and context/use binding for derived keying material.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Select the construction from the security property; do not invent modes or protocol glue from primitive names alone.
- Nonce/IV rules are construction-specific and must survive concurrency, restart, cloning/snapshot, and rotation in the actual system.
- Bind semantic context with associated data, signed context, or a standard transcript so authenticated bytes cannot be transplanted to another role/domain.
- Canonicalize exact signed bytes and fail closed on unknown/downgrade algorithms.
- Keep key custody/rotation and standard TLS/OAuth protocol semantics in their specialist packages.
