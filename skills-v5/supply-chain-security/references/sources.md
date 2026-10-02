# Source map

These sources bound the version-sensitive claims used by `supply-chain-security`. Prefer the current approved specification or first-party verification documentation over remembered behavior, and preserve any version or policy uncertainty in the result.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SLSA specification 1.2**: https://slsa.dev/spec/v1.2/
  - Scope: approved SLSA 1.2 specification, including Build and Source tracks.
  - Use: provenance/build/source terminology and current level boundaries.
  - Verified: 2026-09-05; refresh after 180 days.
  - Important: SLSA 1.2's approved Build track does not make hermetic/reproducible builds a Build L3 requirement. Do not import requirements from the working-draft Build Environment track into an approved Build-level claim.
- **SLSA 1.2 Build artifact verification**: https://slsa.dev/spec/v1.2/verifying-artifacts
  - Scope: approved artifact/provenance verification guidance.
  - Use: trusted builder roots, provenance signature, artifact subject digest, predicate type, canonical source, `buildType`, `externalParameters`, and optional recursive dependency checks.
  - Verified: 2026-09-05; refresh after 180 days.
- **Sigstore/cosign signature verification**: https://docs.sigstore.dev/cosign/verifying/verify/
  - Scope: current Sigstore documentation as available 2026-09-05.
  - Use: artifact/blob signature verification, keyless certificate issuer + identity constraints, digest/claim checks, and attestation verification entry points.
  - Verified: 2026-09-05; refresh after 90 days.
- **Sigstore/cosign in-toto attestation verification**: https://docs.sigstore.dev/cosign/verifying/attestation/
  - Scope: current Sigstore attestation and policy-validation documentation as available 2026-09-05.
  - Use: verifying attestations and validating predicate content with policy; signatures establish integrity/authentication but policy must still decide whether the attested facts are acceptable.
  - Verified: 2026-09-05; refresh after 90 days.
- **NIST SSDF 1.1 / SP 800-218**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Scope: NIST SP 800-218, Secure Software Development Framework Version 1.1, final February 2022.
  - Use: high-level secure software development, supplier/acquisition, integrity, provenance, and vulnerability-response practice framing.
  - Verified: 2026-09-05; refresh after 365 days.
- **SPDX specification**: https://spdx.dev/use/specifications/
  - Scope: SPDX 3.0, listed as the current SPDX document version as of 2026-09-05.
  - Use: SBOM/inventory representation and version identification. Treat the document as inventory evidence, not proof of artifact provenance or completeness.
  - Verified: 2026-09-05; refresh after 365 days.
- **CycloneDX specification overview**: https://cyclonedx.org/specification/overview/
  - Scope: CycloneDX 1.7, current version listed with release date 2025-10-21.
  - Use: component/service/dependency relationship inventory and BOM metadata. Treat coverage as dependent on the generator and lifecycle stage.
  - Verified: 2026-09-05; refresh after 180 days.
- **OpenSSF Scorecard checks**: https://github.com/ossf/scorecard/blob/main/docs/checks.md
  - Scope: OpenSSF Scorecard practitioner checks on `main` as inspected 2026-09-05.
  - Use: pragmatic checks for pinned build/release dependencies, least-privilege workflow tokens, dangerous workflow patterns, binary artifacts, packaging, and signed releases.
  - Verified: 2026-09-05; refresh after 90 days.
  - Treat Scorecard output as heuristic/practitioner evidence, not a normative security certification; account for repository/provider limitations and false positives.

## Interpretation rules

- Verify the artifact and its provenance against predeclared expectations. A cryptographically valid signature from an unexpected signer, builder, repository, workflow, or parameter set is still a policy failure.
- Keep source provenance, build provenance, dependency inventory, signing identity, and vulnerability status distinct. Evidence can reinforce another layer without replacing it.
- Lockfiles and content digests strengthen repeatability only when the actual install/build path enforces them. Inspect bypasses, generated lockfiles, install modes, and tool/plugin resolution.
- SBOM completeness depends on generator, lifecycle stage, ecosystem support, and scope. Reconcile it with at least one independent source when completeness matters.
- Hermeticity, reproducibility, and deterministic output are useful build-environment properties, but do not infer an approved SLSA level solely from them or from their absence.
- For keyless Sigstore verification, constrain both issuer and expected identity/policy. Do not reduce verification to “certificate chain valid.”
- During compromise response, preserve the suspect artifact and evidence before rebuilding. Recovery is demonstrated by removing the compromised input/authority, rebuilding from reviewed inputs, and re-verifying the replacement artifact under the intended policy.
