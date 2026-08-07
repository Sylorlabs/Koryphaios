# ADR-005: Optimistic locking with expectedVersion on SessionStore.update

## Status

Accepted

## Context

The prior `SessionStore.update()` accepted an optional `expectedVersion` parameter. When omitted, the update proceeded without any version check — any concurrent modification would be silently overwritten.

This caused lost updates when multiple agents or the UI modified the same session concurrently. For example:
- Agent A reads session (version 5), updates title
- Agent B reads session (version 5), updates messageCount
- Agent A writes (version 5 → 6)
- Agent B writes (version 5 → 6, overwriting A's title change)

The `update()` method also used `any` for the Drizzle update object, bypassing type checking on column names and value types.

## Decision

1. **Make `expectedVersion` mandatory** on `SessionStore.update()`. Callers must provide the version from their last read.
2. **Add `updateWithCurrentVersion()`** as a convenience wrapper for callers that don't have a version — it reads the current version, then calls `update()`. This is a read-then-update, which is still subject to concurrent modification (the version may change between the read and the update), but it's explicit about the race.
3. **Use `Partial<typeof sessions.$inferInsert>`** instead of `any` for the Drizzle update object.
4. **Return `undefined` on version mismatch** instead of throwing — callers can retry if they care about the conflict.

## Consequences

- **Positive**: Concurrent modifications are detected — the second writer gets `undefined` and can retry.
- **Positive**: Type-safe update objects (no `any`).
- **Negative**: All callers must be updated to pass `expectedVersion` or use `updateWithCurrentVersion()`.
- **Negative**: `updateWithCurrentVersion()` has a TOCTOU race (read-then-update), but this is explicit and documented.

## Alternatives considered

- **Pessimistic locking (SELECT FOR UPDATE)**: SQLite doesn't support row-level locks. An `IMMEDIATE` transaction serializes all writes, which is too coarse for session updates.
- **Throw on version mismatch**: Forces all callers to handle the error. Returning `undefined` is simpler for callers that don't care about concurrent modifications.
- **Automatic retry on mismatch**: Hides the concurrency from the caller. Better to be explicit.
