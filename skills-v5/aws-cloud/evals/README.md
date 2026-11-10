# AWS evaluation boundaries

This package defines routing and full-task acceptance contracts. Their presence does not establish qualification, a paired-run result or live AWS readiness.

## Task artifacts and coverage

| Scenario                           | Candidate-owned artifacts                                                   | Acceptance focus                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-cloud-full-task-1-individual` | `.kory-eval/cloud-baseline.json`, `.kory-eval/cloud-baseline-evidence.json` | Member-account baseline, temporary identity, IAM/KMS/network allow/deny paths, correct RDS deployment semantics, durable audit/telemetry, quota/change/rollback and usable restore evidence. |
| `aws-cloud-full-task-2-individual` | `.kory-eval/cloud-recovery.json`, `.kory-eval/cloud-recovery-evidence.json` | Regional recovery distinct from AZ HA, secondary readiness, recovery/key isolation, timestamp-derived RTO 240 minutes/RPO 15 minutes, partial/denied recovery and bounded failback.          |

The remaining `*-paired-evaluation` required artifact belongs to the outer evaluator. Candidates must not manufacture a paired comparison or blind judgment.

Both registered fixtures materialize a fixed `src/cloud-sim.ts`, a minimal `evidence/starting-state.json` and a README. They do **not** supply AWS credentials, full account/resource/policy inventories, a service-quota snapshot, or an operational restore/failover engine. Preserve the fixed files. Chosen account/resource IDs and illustrative timestamps remain synthetic assumptions; unsupported operations and observations remain unavailable. Both outputs must retain `liveProviderVerified:false` and the evidence output must use `evidenceKind:synthetic`.

## What the deterministic scorer proves

The current registered cloud simulators check required booleans, some numeric bounds, resource/timestamp field presence, fixed simulator integrity, and nonempty IAM/KMS/environment/audit evidence fields. They do not independently execute an AWS policy/network/restore path, validate evidence provenance or prove application/data usability. The recovery scorer does not recompute RTO/RPO from timestamps, reject every impossible timestamp ordering, or require a demonstrated failed attempt. Starting-state preservation is checked only through a provider marker, weaker than this package's byte-identity requirement.

The six falsifiable checks in each task therefore define a stronger acceptance boundary than a simulator pass. A review must map each claim to an artifact/observation or an explicit unavailable status. For the outage drill, use UTC timestamps with `recoveryPoint <= incidentStart <= serviceRestored`; derive minutes from their differences, including failed attempts in elapsed RTO. Negative, non-finite, inconsistent or over-budget values fail the timing claim. Report unexercised failback as unverified. A source citation establishes documented semantics, not deployment success.

Executable enforcement of these stronger assertions needs a separate harness/scorer change outside this package. Package-local structural and resolver checks cannot certify that gap closed.

## Routing contract

`routing.jsonl` contains five operational positives, five responsibility-boundary negatives, three compound cases and four adversarial cases. `expectedSkills` asserts relevant bundle composition; `adjacentSkills` alone is descriptive metadata. Keep the conceptual-only regression and quoted/inert-context failures visible. Public and held out prompts must not be identical, and neither may be copied into activation/exclusion metadata merely to make a failing case pass.
