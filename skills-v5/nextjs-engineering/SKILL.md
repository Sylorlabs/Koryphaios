---
name: nextjs-engineering
description: Engineer Next.js applications where App Router boundaries, Server and Client Components, routing, data fetching, caching, revalidation, Server Actions, or deployment semantics are material. Use when the live task depends on Next.js framework behavior rather than ordinary React component logic alone.
---

# Nextjs Engineering

## Scope and routing

- Broader skill: `web-interface`.
- Required skill: `verification`.
- Select this skill for Next.js routing, layouts, Server Components, Client Component boundaries, Route Handlers, Server Actions, data fetching, caching, revalidation, streaming, request APIs, or deployment behavior.
- Let `react-engineering` own ordinary React state, hooks, effects, and component composition when no Next.js framework boundary is involved. Compose both when a React behavior crosses a Next.js server/client seam.
- Compose `typescript-javascript-engineering` only when the task also depends on language or module semantics.
- Quoted, historical, negated, fixture-only, or example Next.js text is not a live trigger.

## Decision criteria

### Establish the execution model

Identify the installed Next.js version, router in use, deployment target, and relevant `next.config` flags before applying caching or rendering advice. Current App Router caching behavior differs depending on whether Cache Components are enabled, so do not mix guidance from the current Cache Components model with the previous caching model.

Trace where each operation executes: build, request-time server render, Server Action, Route Handler, middleware or proxy layer, or browser. Treat secrets, cookies, headers, request data, and browser APIs according to that execution boundary.

### Server and Client Components

Keep Server Components as the default for server-owned data and secrets. Add `'use client'` at the smallest interactive entry point that actually needs state, effects, event handlers, or browser APIs. The directive creates a client module-graph boundary, so imported descendants become part of the client bundle.

Props crossing from Server Components to Client Components must satisfy React's serializable boundary. Do not move server-only modules or secrets into the client graph to avoid a composition problem.

### Data, mutations, and caching

Choose data access based on ownership and freshness requirements. Avoid duplicate authoritative fetches across server and client boundaries when the same server result can be passed or shared safely.

For cached data, name the active cache model and the invalidation contract. Under Cache Components, distinguish time-based `cacheLife` from on-demand `revalidateTag`, `updateTag`, or `revalidatePath`. Do not infer production freshness from development behavior.

Treat Server Actions and Route Handlers as server entry points. Validate input, re-check authorization at the mutation boundary, perform the mutation, and then invalidate or update the cache scope that actually contains the changed data.

## Boundary verification

Verify the behavior through the route boundary that users and production will exercise:

- Test a direct deep link and browser refresh, not only client navigation.
- Exercise server render plus hydration for any changed Server and Client Component seam.
- Verify that client bundles do not contain server-only imports or secrets after moving a boundary.
- For cache work, demonstrate the stale state, perform the mutation or expiry path, then show the expected fresh state under the configured cache model.
- Exercise authenticated and unauthenticated or unauthorized paths for server mutations when access control is involved.
- Run the deployment build and a representative production runtime check for behavior that depends on build-time or hosting semantics.
- Do not claim a caching or routing fix from local development behavior alone.

Use [the maintained source map](references/sources.md) for version-sensitive App Router and caching behavior.
