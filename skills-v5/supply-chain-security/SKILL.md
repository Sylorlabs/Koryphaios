---
name: supply-chain-security
description: Assess software supply chain trust across dependencies, builds, provenance, signatures, and updates. Use when reviewing lockfile integrity, SBOMs, artifact attestations, or compromised tooling; use cicd-engineering for pipeline implementation without a supply chain assessment.
---

# Supply Chain Security

Own the chain-of-custody question: what exact source, dependencies, tools, builder, identity, and policy produced the artifact being consumed, and what evidence makes that chain acceptable? Treat inventory, signatures, provenance, reproducibility, and scanner output as different evidence types rather than interchangeable proof.

## Integrity workflow

1. **Freeze the subject and trust expectations.** Identify the exact source revision, package/image/artifact digest, registry or distribution path, release channel, expected builder/signing identity, and policy that decides what is trusted. Record mutable names separately from immutable identities. A valid signature from an unexpected identity is not authorization.
2. **Resolve dependencies and build inputs.** Inspect manifests together with the resolver output/lockfile and package-manager integrity metadata. Include transitive dependencies, build-only packages, plugins, CI actions/reusable workflows, container bases, compilers, generators, package-manager versions, and other toolchain inputs that can affect the artifact. Prefer ecosystem-supported immutable pins or content digests where practical; verify the lockfile is current and is actually enforced by the build/install path.
3. **Use SBOMs as inventories, not verdicts.** Record the SBOM format/version and generation point, then check its root component, transitive relationships, versions/digests, and omitted scopes against the lockfile, resolved build graph, or produced artifact when possible. SPDX and CycloneDX can represent rich inventories, but an SBOM by itself does not prove completeness, trusted provenance, non-compromise, exploitability, or that the listed components produced the artifact.
4. **Map CI and toolchain trust boundaries.** Identify which jobs execute untrusted pull-request/fork code, which jobs can read secrets or obtain identity tokens, and which jobs can publish, sign, or alter provenance. Inspect reusable workflows/actions/plugins and base images as dependencies. Prefer immutable references, minimal token permissions, isolated release jobs, protected source/release configuration, and no path where untrusted code can run with release/signing authority. A hosted builder is trusted only to the level justified by its controls and verifier policy.
5. **Assess hermeticity and reproducibility separately.** Determine whether the build can fetch undeclared network inputs, use mutable registries/tags, inherit host tools/configuration, depend on time/randomness, or reuse untrusted caches. A clean rebuild with matching output is useful corroboration; a mismatch is a diagnostic signal. Do not claim that reproducibility alone proves provenance or that SLSA Build L3 requires a hermetic/reproducible build under the current SLSA 1.2 Build track.
6. **Verify provenance and signatures against expectations.** For SLSA-style provenance, verify the envelope/signature, artifact `subject` digest, trusted builder identity, predicate type, canonical source, `buildType`, and allowed `externalParameters`; inspect `resolvedDependencies` to the extent available without assuming completeness. For Sigstore/cosign keyless verification, constrain certificate issuer and identity (or an equivalent policy), verify the artifact digest/claims, and validate required attestations/predicate policy. Treat transparency-log/bundle evidence as part of verification, not as a substitute for identity and policy checks. Fail closed when a required signature, attestation, expected field, or trust root cannot be established.
7. **Respond to suspected compromise from evidence outward.** Preserve the suspect lockfile, SBOM, artifact digest, provenance/signature bundle, CI logs, and dependency/tool versions. Stop promotion or consumption of affected artifacts; identify the compromised version/tool and reachable blast radius; rotate exposed credentials or signing authority when build-time exfiltration is plausible; remove/quarantine the bad input; rebuild from reviewed source with a known-good dependency/toolchain set in a clean environment; issue fresh provenance/signatures; and re-run the same verification policy before restoration. Record withdrawn/revoked artifacts, residual exposure, and downstream notification needs rather than declaring recovery from a version bump alone.

## Evidence contract

Return evidence that another reviewer can reproduce:

- artifact/source identities and expected trust policy;
- manifest + enforced lockfile/resolution evidence, including integrity hashes/digests where supported;
- SBOM format/version, generation point, inventory gaps, and reconciliation against another source of truth;
- CI/release trust-boundary findings, including mutable tool/plugin/action references and credential/token exposure paths;
- build-environment observations for undeclared inputs, network access, caches, and clean rebuild/reproducibility results when tested;
- exact provenance/signature/attestation verification result with subject digest, builder or signer identity, issuer/trust root, predicate/build type, and policy outcome;
- compromise containment/rebuild evidence and explicit unresolved unknowns.

Do not convert “scanner clean,” “SBOM generated,” “signature valid,” or “build reproduced” into a broader supply-chain assurance claim than the evidence supports.

## Boundaries

- `application-security` owns vulnerabilities in application behavior; this skill owns whether dependencies/build inputs/artifacts are the expected trusted ones.
- `applied-cryptography` owns algorithm/protocol/key-design questions; this skill applies supported signing and identity-verification mechanisms to artifact trust.
- `cicd-engineering` owns general pipeline implementation and delivery mechanics; this skill owns the integrity and privilege boundaries of the build/release chain.
- `container-engineering` owns container construction/runtime mechanics; this skill owns base-image provenance, immutable identity, attestation, and release trust when those are the concern.
- `secrets-key-management` owns lifecycle design for long-lived secrets and keys; compose it when a supply-chain incident requires key rotation or signer compromise response.

Use [the maintained source map](references/sources.md) for current SLSA, Sigstore/cosign, SSDF, SBOM, and OpenSSF guidance and for version-sensitive caveats.
