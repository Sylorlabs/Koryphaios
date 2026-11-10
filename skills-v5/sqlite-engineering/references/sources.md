# Source map

## Adopted principles

- SQLite transaction and journal mode are runtime semantics, not implementation details. WAL changes reader/writer concurrency and checkpoint behavior but does not create multi-writer concurrency.
- Foreign-key declarations need runtime enforcement to protect referential invariants.
- Live backup should use a mechanism designed for database consistency rather than assuming a file copy is safe while connections are active.

## Conditional recipes

- WAL is not adopted universally. Its same-host shared-memory model and deployment constraints can make rollback journaling or another database more appropriate.
- Busy timeout values, connection-pool size, synchronous level, checkpoint scheduling, `VACUUM INTO`, and Online Backup API usage remain application-specific choices.

## Verification scope

SQLite documentation defines transaction, WAL, foreign-key, and backup behavior. It does not prove the linked library version, compile options, filesystem locking, application connection lifecycle, migration safety, or crash behavior. Verify those in the target build and storage environment.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader relational-data-modeling.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SQLite Write-Ahead Logging**: https://sqlite.org/wal.html
  - Scope: SQLite documentation checked 2026-09-06.
  - Use: WAL concurrency, single-writer behavior, checkpointing, and same-host constraints.
- **SQLite transactions**: https://sqlite.org/lang_transaction.html
  - Scope: SQLite documentation checked 2026-09-06.
  - Use: implicit and explicit transaction behavior plus `BEGIN` modes.
- **SQLite foreign keys**: https://sqlite.org/foreignkeys.html
  - Scope: SQLite documentation checked 2026-09-06.
  - Use: foreign-key support and enforcement semantics.
- **SQLite Backup API**: https://sqlite.org/backup.html
  - Scope: SQLite documentation checked 2026-09-06.
  - Use: consistent online backup mechanics and alternatives.
