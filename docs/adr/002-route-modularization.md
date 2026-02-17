# ADR-002: Route Modularization

## Status

Accepted (2026-02-16)

## Context

The original `server.ts` was a monolithic file containing 50+ route handlers, WebSocket management, authentication logic, provider configuration, and more. This violated the Single Responsibility Principle and made the codebase:

- Difficult to test (requiring mocking the entire universe)
- Hard to maintain (any change required touching a massive file)
- Prone to merge conflicts (multiple developers editing the same file)
- Impossible to reason about (too much context required)

## Decision

We split the monolithic server into modular route handlers:

```
backend/src/routes/
├── types.ts        # Route interfaces and helpers
├── router.ts       # Router class with middleware support
├── sessions.ts     # Session CRUD routes
├── providers.ts    # Provider configuration routes
├── messages.ts     # Message sending routes
├── git.ts          # Git operation routes
└── index.ts        # Module exports
```

### Router Pattern

Each route module exports a factory function that accepts dependencies:

```typescript
export function createSessionRoutes(deps: RouteDependencies): RouteHandler[]
```

This enables:
1. **Dependency Injection**: Dependencies are passed in, not imported
2. **Testability**: Routes can be tested with mock dependencies
3. **Isolation**: Each route module focuses on one domain

### Middleware Chain

The router supports middleware for cross-cutting concerns:

```typescript
router.use(authMiddleware());
router.use(loggingMiddleware());
router.use(validationMiddleware());
```

## Consequences

### Positive

- **Testability**: Routes can be unit tested in isolation
- **Maintainability**: Changes are localized to relevant modules
- **Readability**: Each file has a clear, focused purpose
- **Team collaboration**: Less merge conflicts

### Negative

- **More files**: Increased number of files to navigate
- **Indirection**: Route matching happens in router, not immediately visible

### Neutral

- **Pattern familiarity**: Developers need to understand the router pattern

## Implementation Notes

1. Routes are registered in the `Router` constructor via factory functions
2. Route matching uses a combination of string and regex patterns
3. Path parameters are extracted and passed to handlers
4. Error handling is centralized in the router