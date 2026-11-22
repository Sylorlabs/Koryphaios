---
name: privacy-engineering
description: Engineer privacy across personal-data collection, use, sharing, retention, deletion, and preference controls. Use when designing or testing minimization, consent behavior, de-identification, or privacy-risk reduction; keep jurisdiction-specific legal conclusions separate from engineering evidence.
---

# Privacy Engineering

Treat privacy as a system property, not a notice-writing exercise. Trace how information about people is created, inferred, linked, transformed, copied, exposed, retained, and removed. Evaluate privacy risk even when confidentiality controls are functioning correctly.

## Engineering workflow

1. **Map the data lifecycle.** For each personal-data field or derived signal, identify the subject, collector, source, stated purpose, processing purpose, transformations/inferences, stores, recipients, access paths, retention trigger, deletion path, and recovery/backup behavior. Include telemetry, logs, caches, queues, search/vector indexes, data warehouses, exports, support tools, and third-party processors where relevant.
2. **Test necessity and proportionality as engineering questions.** Ask whether the product objective can be achieved with less data, lower precision, shorter retention, local/on-device processing, aggregation, sampling, delayed collection, or unlinkable/pseudonymous identifiers. Record why each retained field or inference is actually needed.
3. **Design for predictability.** A user's observable controls and product behavior should match the system's actual processing. Avoid hidden secondary uses, ambiguous defaults, or preference UI that does not change downstream processing.
4. **Design for manageability.** Make access, correction, suppression, selective disclosure, retention, and deletion implementable at the granularity the system promises. Propagate state changes across derived stores and downstream consumers; prevent deleted or suppressed data from being silently repopulated by CDC, queues, retries, restores, or stale exports.
5. **Design for disassociability where feasible.** Avoid persistent identity linkage when the purpose does not require it. Distinguish aggregation, pseudonymization, and de-identification; do not call data anonymous merely because a direct identifier was removed.
6. **Make retention executable.** Define the retention clock, legal/business hold exceptions supplied by policy, enforcement job, retry/failure behavior, evidence of deletion, and treatment of backups. A backup that cannot be selectively edited needs an explicit expiration and restore-time reapplication strategy rather than a false claim of immediate erasure.
7. **Verify the control path.** Exercise representative collection, opt-in/opt-out or preference changes, export/access, retention expiry, deletion, restore, and downstream propagation using synthetic identities. Inspect durable state and emitted events rather than accepting UI confirmation as proof.

## Evidence and claims

Produce a field-level lifecycle map, purpose/necessity rationale, retention/deletion matrix, preference/control contract, and observable verification results. Mark systems that are unavailable, simulated, or governed by external processors. Do not claim that deleting source records removes information from model weights, immutable audit artifacts, third-party systems, or backups unless the actual mechanism and evidence support that claim.

## Deliverable fidelity

The supplied evaluator and evidence corpus are read only inputs. Editing either one, or writing output into its path, is recorded as an integrity failure, and no other result offsets it.

Implement the control the task asks for in the artifact it names, at the path and in the shape its reader expects. A typed spec is mirrored field for field with every boolean answered, and an opt out or minimization rule belongs in executable behaviour rather than in accompanying prose.

When a task supplies synthetic identities or a queue and restore path, exercise them through the code path production uses. A described control is not a verified one.


An aggregate event identity has to be pseudonymous and unique per event: derive it from the subject with a per event nonce so two identical calls produce different values, and never emit the account id, the email address or a stable device identifier into emitted events. Opting out deletes the derived profile and tombstones queued events so a later queue drain cannot rehydrate one, and a restore reapplies that suppression before serving.

## Boundaries

- `authorization-security` owns who may access or mutate a resource; privacy-engineering owns whether the data should exist, how much should be processed, and how its lifecycle is governed.
- `application-security` owns hostile-input and privileged-sink safety; privacy-engineering may require confidentiality but also covers privacy harms that occur without a security exploit.
- `analytics-engineering` owns analytical modeling and pipelines; privacy-engineering owns minimization, linkage, purpose, retention, and user-control constraints on personal-data analytics.
- `secure-authentication` owns authentication assurance for sensitive privacy actions; this skill defines the privacy action and lifecycle outcome.
- `security-review` owns review-only vulnerability findings; `security-verification` owns final security-control proof. Privacy verification remains focused on data-processing and lifecycle behavior.
- Do not convert engineering findings into jurisdiction-specific statements about consent validity, statutory rights, lawful bases, notice text, or retention mandates without the governing policy/legal source supplied for that jurisdiction.

Use [the maintained source map](references/sources.md) for the current NIST Privacy Framework status and NIST privacy-engineering objectives.
