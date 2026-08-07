# Architecture Decision Records

This directory contains ADRs for load-bearing decisions in the Koryphaios backend.

Each ADR documents a decision that is:
- **Load-bearing** — changing it later would require significant rework
- **Non-obvious** — the reasoning isn't clear from reading the code alone
- **Consequential** — getting it wrong caused or would cause production incidents

## Index

- [ADR-001: pino with synchronous file destination for compiled mode](./001-pino-destination-compiled-mode.md)
- [ADR-002: Terminal-event delivery guarantee via pendingTerminalEvents queue](./002-terminal-event-delivery-guarantee.md)
- [ADR-003: Exponential backoff + restartCount preservation in process supervisor](./003-process-supervisor-restart-backoff.md)
- [ADR-004: Graceful degradation with disabledComponents tracking in bootstrap](./004-bootstrap-graceful-degradation.md)
- [ADR-005: Optimistic locking with expectedVersion on SessionStore.update](./005-session-store-optimistic-locking.md)
- [ADR-006: Explicit stub marking for embeddings instead of fake vectors](./006-embeddings-explicit-stub.md)
- [ADR-007: Env-based KMS provider selection](./007-kms-env-based-selection.md)
