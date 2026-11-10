---
name: technical-communication
description: Explain technical systems, decisions, and incidents with traceable evidence. Use when producing a design document, RFC, architecture explanation, engineering report, or technical postmortem; not for executive briefs, tutorials, lookup references, or implementation without documentation.
---

# Technical Communication

Make the system understandable enough for a technical reader to review, operate, or change it without confusing intention with implementation.

## Workflow

1. Establish document type, audience, decision/review goal, system/version scope, and evidence boundary. Follow documentation conventions specific to the project before generic style guidance.
2. State context and constraints before the proposed or observed mechanism: problem, goals/non-goals, assumptions, interfaces, dependencies, scale/latency/reliability/security constraints, and compatibility boundaries that affect the design.
3. Describe the mechanism using the system's real nouns and boundaries. Trace components, control/data flow, state transitions, failure paths, and ownership. Use diagrams/tables only when they clarify relationships that prose obscures.
4. For proposals/RFCs, separate current state from proposed state. Record alternatives considered, decision drivers, rejected options, migration/rollback, operational impact, and unresolved decisions. Do not fabricate consensus or call an option rejected without evidence.
5. For engineering reports/postmortems, separate observations, measurements, hypotheses, causal conclusions, remediation, and residual risk. Timeline correlation is not proof of causation.
6. Keep claims traceable to code, tests, measurements, specs, incidents, or cited sources. Examples must be executable/validated where practical or explicitly labeled illustrative/pseudocode.
7. Cover interfaces and failure behavior, not only the happy path: inputs/outputs, ownership, errors, retry/idempotency assumptions, degraded behavior, observability, rollback/recovery, and compatibility.
8. Review for version drift, undefined terms, stale diagrams, mismatched examples, missing alternatives, hidden assumptions, and whether a reviewer can identify what is fact, proposal, inference, and open question.

When the repository supplies a structured design artifact or acceptance contract, treat its fields, value types, and identifiers as part of the interface. Populate the exact decision, mechanism, alternatives, verification, rollback, risk, and open-question fields from the available evidence rather than relying on prose to imply them. When a decision field is defined as an alternative identifier, return that exact identifier, and when alternatives are defined as an identifier list, preserve that scalar-array shape rather than replacing it with descriptive objects; put names and tradeoffs in companion prose unless the contract explicitly gives them structured fields. Preserve every supplied alternative identifier while making the chosen one explicit, and make durable handoff, idempotency, worker ownership, retry/dead-letter behavior, negative-path verification, and rollback concrete when those are material to the design.

## Boundaries

- `documents-communication` supplies shared audience/format/factual discipline and is inherited as the broader document skill.
- `executive-communication` owns leadership-facing decision/status framing where implementation detail matters only insofar as it changes impact, risk, cost, timing, or asks.
- `instructional-communication` owns procedures where the reader's primary goal is to perform and verify a task.
- `reference-communication` owns lookup-oriented exact API/config/schema/command descriptions rather than narrative explanation or design rationale.
- `repository-research` or domain engineering skills establish the technical evidence; this skill turns verified evidence into a reviewable technical artifact and does not itself authorize code changes.

## Failure and recovery

- If implementation evidence is unavailable, label architecture as proposed/documented rather than current.
- If source code and design docs conflict, report the executable/configured behavior and the documentation drift separately.
- If an example cannot be executed in the target environment, mark it illustrative and avoid claiming validation.
- If a diagram would be stale or unverifiable, prefer a smaller text/table trace tied to source evidence.

Use [the maintained source map](references/sources.md) when refreshing technical-writing and documentation-architecture guidance.
