# ADR-004: Graceful degradation with disabledComponents tracking in bootstrap

## Status

Amended by the 2026-08-09 reliability hardening

## Context

The prior `bootstrap()` function had no degradation strategy. Every component was initialized in sequence, and any failure would either:

- Crash the entire startup (if the failure threw)
- Be silently swallowed (if the failure was caught with `catch {}`)

This meant a missing MCP server, a broken credit accountant, or a failed encryption init would prevent the entire backend from starting — even though the core (DB, providers, tools) was fine.

There was also no way for downstream code to know which components were available. Code that depended on MCP or encryption would get a runtime surprise when it tried to use them.

## Decision

Classify each component as **critical** or **degradable**:

- **Critical** (failure aborts startup): Environment validation, Database, Encryption (in production)
- **Degradable** (failure logs a warning and continues with an explicit unavailable state): Credit accounting, MCP, and non-critical cleanup

Process-supervisor recovery is now critical. If its durable active-process
query fails, bootstrap stops rather than allowing a live agent child to become
untracked. Encryption remains degradable only in development; credential
writes and legacy migrations then fail closed. Goal recovery must preserve a
truthful paused/degraded state and may not silently mark work complete.

Track degraded components in `AppContext.disabledComponents: Set<string>`. Downstream code can check `ctx.disabledComponents.has('mcp')` before using MCP.

## Consequences

- **Positive**: The backend starts even when optional components fail.
- **Positive**: Downstream code can check availability instead of guessing.
- **Positive**: Operators see which components are degraded in the startup log.
- **Negative**: Downstream code must check `disabledComponents` — forgetting to check leads to runtime errors when calling a disabled component.
- **Negative**: Optional features can be unavailable, but the API/UI must expose that state; silent unavailability is not accepted.

## Alternatives considered

- **Fail fast on any component failure**: The prior behavior. Too fragile for a product with many optional integrations.
- **Lazy initialization**: Initialize components on first use instead of at startup. More complex, and doesn't surface failures early.
