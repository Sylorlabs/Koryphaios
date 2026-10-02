# Source map

`embedded-device-security` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound current IoT device-security and platform-firmware guidance; the actual device, silicon revision, fuse state, boot chain, and observed hardware behavior remain authoritative for a concrete claim.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST IR 8259 Rev. 1: Foundational Cybersecurity Activities for IoT Product Manufacturers**: https://csrc.nist.gov/pubs/ir/8259/r1/final
  - Scope: final April 2026 revision; supersedes the original 2020 IR 8259.
  - Use: current manufacturer lifecycle activities for identifying customer cybersecurity needs, addressing product cybersecurity risk, and supporting products throughout their lifecycle.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST IR 8259A: IoT Device Cybersecurity Capability Core Baseline**: https://csrc.nist.gov/pubs/ir/8259/a/final
  - Scope: final May 2020 publication and still the core device-capability baseline in NIST's 8259 series as verified 2026-09-05.
  - Use: device identification, configuration, data protection, logical access to interfaces, software update, cybersecurity-state awareness, and device security.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST SP 800-193: Platform Firmware Resiliency Guidelines**: https://csrc.nist.gov/pubs/sp/800/193/final
  - Scope: final May 2018 publication.
  - Use: protect platform firmware from unauthorized change, detect unauthorized change, and recover securely; useful for root-of-trust, update, and recovery reasoning.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- A device capability baseline is a starting point, not proof that a particular board or firmware enforces the capability correctly.
- Trace trust from the earliest executing stage. Later signature checks cannot repair an earlier mutable privileged stage.
- Treat update authenticity, product binding, freshness/anti-rollback, atomicity, failure recovery, and recovery authority as separate properties.
- State physical-access assumptions explicitly. Debug-lock or hardware-backed-secret claims require evidence from the relevant production silicon/configuration when those properties are hardware enforced.
- Keep release provenance and build-pipeline trust in `supply-chain-security`; keep device acceptance/enforcement of the resulting artifact here.
