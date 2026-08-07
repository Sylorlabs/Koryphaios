# Defect Categories by Language and Ecosystem

Read the section(s) relevant to the code under review. These are the common defect categories worth checking — not an exhaustive list, but the high-signal ones that real reviews catch.

## Table of Contents

- [Universal Categories](#universal-categories)
- [Python](#python)
- [TypeScript/JavaScript](#typescriptjavascript)
- [Rust](#rust)
- [Go](#go)
- [SQL and Database Changes](#sql-and-database-changes)
- [Security Cross-Cutting](#security-cross-cutting)

## Universal Categories

These apply regardless of language:

| Category | What to check | Severity range |
|----------|--------------|----------------|
| Null/nil dereference | Optional/nullable values used without guards | P0–P2 |
| Off-by-one errors | Loop bounds, slice indices, pagination | P1–P2 |
| Resource leaks | Files, connections, handles not closed on all paths | P1–P2 |
| Error swallowing | Catch blocks that silently ignore errors | P1–P2 |
| Race conditions | Shared mutable state accessed without synchronization | P0–P1 |
| Dead code | Unreachable branches, unused imports introduced by the change | P3 |
| API contract violations | Function signature changes that break callers | P0–P1 |
| Missing test coverage | New behavior without corresponding tests | P2–P3 |

## Python

| Pattern | What to look for | Example |
|---------|-----------------|---------|
| Mutable default arguments | `def f(x=[])` or `def f(x={})` | Shared state across calls |
| Bare `except:` | Catches `KeyboardInterrupt`, `SystemExit` | Use `except Exception:` |
| `except Exception` without re-raise | Swallows errors silently | Log + re-raise or handle explicitly |
| Async without `await` | Coroutine never scheduled | `async def` called without `await` |
| `os.path` vs `pathlib` mixing | Inconsistent path handling | Pick one per module |
| `__init__` side effects | Network calls, file I/O in constructors | Move to explicit setup |
| `threading` without locks | Shared mutable state | Use `threading.Lock` or `queue` |
| `subprocess` with `shell=True` | Shell injection if input is untrusted | Use `shell=False` with arg list |

## TypeScript/JavaScript

| Pattern | What to look for | Example |
|---------|-----------------|---------|
| `any` type | Defeats type safety | Replace with specific type or `unknown` |
| Floating promises | Promise not awaited/returned/voided | `someAsync()` without `await` |
| `==` vs `===` | Loose equality coercion | Use `===` unless intentionally loose |
| Mutable exports | Module-level mutable state | Cross-request leaks in server contexts |
| `useEffect` missing deps | React hook with stale closures | Add deps or disable with justification |
| Unhandled promise rejections | `.then()` without `.catch()` | Add `.catch()` or wrap in try/catch with await |
| `process.env` without fallback | Missing env var crashes at runtime | Provide default or validate at startup |
| Prototype pollution | `Object.assign` with user input | Use `Object.create(null)` or validate keys |

## Rust

| Pattern | What to look for | Example |
|---------|-----------------|---------|
| `unwrap()` on fallible ops | Panics on `None`/`Err` | Use `?`, `ok_or`, or handle explicitly |
| `clone()` in hot paths | Unnecessary allocations | Use references or `Cow` |
| Integer overflow | `as` casts truncating | Use `try_from` or checked arithmetic |
| `unsafe` blocks | Soundness violations | Document safety invariants |
| Deadlock potential | Lock ordering across multiple mutexes | Acquire in consistent order |
| `Drop` not implemented | Resource leaks for custom types | Implement `Drop` or use RAII guards |
| `Send`/`Sync` bounds | Thread safety violations | Verify trait bounds on shared types |

## Go

| Pattern | What to look for | Example |
|---------|-----------------|---------|
| Ignored errors | `_ = err` or no error check | Handle or explicitly document why ignored |
| Goroutine leaks | Goroutines without exit condition | Use `context.Context` for cancellation |
| Defer in loops | Resources not released until function end | Move resource cleanup inside loop body |
| Map concurrent access | Unsynced map reads/writes | Use `sync.Map` or `sync.RWMutex` |
| `interface{}` overuse | Loses type safety | Use concrete types or generics |
| Nil pointer dereference | Pointer without nil check | Check before dereference |

## SQL and Database Changes

| Pattern | What to look for |
|---------|-----------------|
| Missing index on new query pattern | New WHERE/JOIN column without index |
| N+1 queries | Loop executing individual queries |
| Unbounded result sets | SELECT without LIMIT |
| Transaction scope too wide | Long-running transactions holding locks |
| Missing migration for schema change | Code references column/table not in migrations |
| Data loss in migration | DROP without backup or rollback plan |

## Security Cross-Cutting

| Category | What to check |
|----------|--------------|
| Injection | User input reaching SQL, shell, or template engines without sanitization |
| Auth bypass | New endpoints without auth checks; changed permission boundaries |
| Secret exposure | Tokens, keys in logs, error messages, or source code |
| Path traversal | User-controlled paths joining without normalization |
| SSRF | Server-side requests with user-controlled URLs |
| Mass assignment | User input bound directly to model fields without allowlists |
| CORS misconfiguration | Wildcard origins with credentials |
| Rate limiting gaps | New expensive endpoints without rate limits |
