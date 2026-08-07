# Severity Calibration and Worked Examples

Read this to calibrate finding severity. Each example shows a real finding, its priority, and the reasoning behind the rating.

## Priority Levels

| Priority | Meaning | Action |
|----------|---------|--------|
| P0 | Universal release blocker or critical failure | Must fix before merge |
| P1 | Urgent defect that should be fixed next | Fix before merge or immediately after |
| P2 | Ordinary defect that should be fixed | Fix in this PR or next |
| P3 | Low-impact issue still worth fixing | Fix when convenient |

## Worked Examples

### P0: Auth bypass on new endpoint

```
[P0] New /api/admin/users endpoint has no auth check — src/routes/users.ts:45
```

The new endpoint returns all users without verifying the caller is an admin. The existing `/api/admin/*` routes all check `requireAdmin()` middleware, but this route was added without it. Any authenticated user can enumerate all users. This is a critical security regression introduced by this change.

### P0: Data loss in migration

```
[P0] Migration drops `notes` column without data migration — migrations/015_drop_notes.sql:3
```

The migration drops the `notes` column, but the code still references it in 3 places (`src/models/task.ts:12`, `src/api/tasks.ts:87`, `src/api/tasks.ts:156`). After migration, those queries will fail. Additionally, existing note data is permanently lost with no backup or export step.

### P1: Race condition in counter update

```
[P1] Counter increment is not atomic — src/services/counter.ts:23
```

The new `incrementCounter` function reads the current value, increments in memory, and writes back. Under concurrent access, two requests can read the same value and both write `value + 1`, losing one increment. Use an atomic update (`UPDATE counters SET value = value + 1`) or a transaction with `SELECT ... FOR UPDATE`.

### P1: Error swallowing in payment handler

```
[P1] Payment failure silently ignored — src/api/checkout.ts:112
```

The catch block logs the error but returns a success response to the caller. The user sees "payment successful" while the payment actually failed. This causes incorrect order state and customer confusion. Either re-raise the error or return an explicit failure response.

### P2: Missing index on new query pattern

```
[P2] New query filters on `created_by` without index — src/api/tasks.ts:67
```

The new `GET /tasks?assigned_to=X` endpoint filters on the `assigned_to` column, which has no index. On a table with 100k+ rows, this will cause full table scans. Add an index: `CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to)`.

### P2: Floating promise in request handler

```
[P2] Analytics call not awaited — src/api/checkout.ts:98
```

`trackEvent('purchase', data)` is called without `await` or `.catch()`. If it rejects, the error is silently swallowed and the event is lost. Either `await` it, chain `.catch()`, or pass to a `waitUntil`/background queue if fire-and-forget is intentional.

### P3: Dead code from refactoring

```
[P3] Unused `validateOldFormat` function — src/utils/validation.ts:34-52
```

The old validation function is no longer called after the refactoring. It should be removed to keep the codebase clean, but it causes no runtime issues.

### P3: Inconsistent naming in new module

```
[P3] Mixed snake_case and camelCase in new file — src/services/billing.ts
```

The new file uses `calculate_total` (snake_case) on line 12 but `processPayment` (camelCase) on line 28. The codebase convention is camelCase. This doesn't affect correctness but hurts readability.

## Anti-Patterns: What NOT to Flag

These are common reviewer mistakes — things that look like issues but shouldn't be flagged:

| Anti-pattern | Why it's not a finding |
|-------------|----------------------|
| Style nits (spacing, brace placement) | Not actionable unless they obscure the code or violate an enforced linter |
| Pre-existing issues | Only flag issues introduced by the reviewed change |
| Speculative concerns ("what if someone...") | Flag only demonstrable issues with a real code path |
| Intentional behavior changes | If the diff deliberately changes behavior, don't flag the change itself |
| Performance without data | "This might be slow" without evidence is not actionable — show the O(n²) loop or the missing index |
| Personal preference | "I would have used a different pattern" is not a defect |
| Missing tests for trivial changes | One-line refactors or comment changes don't need new tests |
| TODO comments | Unless the TODO blocks correctness or security, it's not a review finding |
