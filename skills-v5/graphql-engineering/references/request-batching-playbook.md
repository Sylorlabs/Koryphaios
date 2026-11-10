# GraphQL resolver batching, authorization, and execution playbook

Use this for N+1 resolver fan out, DataLoader cache lifetimes, subscriptions, or per key failures. Work from the runtime's actual context factory, resolver order, and backend lookup semantics. If the repository does not depend on a DataLoader library, implement equivalent queued batching while preserving the same invariants. A nullable avatar migration with one user lookup is not batching evidence; explicitly classify batching as not applicable or unavailable when the fixture cannot exercise it.

## The request boundary invariant

A loader is created from a _trusted authenticated GraphQL execution context_. It may memoize repeated keys only during that execution. A later HTTP request, even for the same viewer, gets a new loader. A subscription connection or authentication handshake does not own the cache: each emitted event executes with fresh loaders and current permitted caller context. A service singleton holding rows or errors visible to callers is unsafe.

Per key authorization is enforced by the backend or trusted resolver at the actual resource/field boundary. Do not rely on a root field permission check, an untrusted viewer argument, or the batcher's machine identity. For each requested ID, the viewer's tenant, relationship, field scope, and current revocation state must govern returned data. Be deliberate about consistency if access changes during a long lived operation.

## Example: implementation shape

This TypeScript sketch assumes an installed `DataLoader` implementation and a backend that **already** enforces viewer specific access and returns one entry per requested ID in the same order. Adapt to the stack; do not add a dependency simply for the sketch.

```ts
type CustomerResult = Customer | null | Error;

function makeRequestContext(viewer: VerifiedViewer, backend: Backend) {
  const customer = new DataLoader<string, Customer | null>(async (keys) => {
    const results: CustomerResult[] = await backend.batchGetVisible(viewer, [...keys]);

    if (results.length !== keys.length) {
      throw new Error('Customer batch returned the wrong number of results');
    }
    // Returning an Error for one key rejects only that key's load().
    return results;
  });
  return { viewer, loaders: { customer } };
}

const resolvers = {
  Order: {
    customer: (order: Order, _args: unknown, ctx: RequestContext) =>
      ctx.loaders.customer.load(order.customerId),
  },
};
```

If the backend returns unordered rows, index authorized results by requested ID and reconstruct an output slot for _every_ key; use explicit `null` for a permitted missing record and a per key error for a failed lookup according to policy. Never let a missing row shift results onto the wrong ID. Keep batch sizes bounded if backend parameters have a limit; measure resulting calls rather than assuming exactly one for arbitrarily large queries.

The GraphQL executor normally receives a rejected promise for an Error at one selected field and applies the schema's null propagation. For a custom executor/aggregate helper, **start all loads before awaiting** and settle each outcome independently:

```ts
const pending = orders.map((order) => ctx.loaders.customer.load(order.customerId));
const outcomes = await Promise.allSettled(pending);
// Produce one order result and, where rejected, one field error per selection.
```

Serial `await loader.load(id)` inside a loop may defeat batching even with a request local cache. `Promise.all` without per field error handling may wrongly abort the entire list on one failed key. Duplicate IDs must return the same viewer specific value within one request, without repeating the backend read. A DataLoader that caches per key Error values needs an explicit `clear(key)` policy for retries of transient failures in the same request; clearing cannot substitute for a new loader on the next request.

## Maintained executable regressions

Drive the real resolver/execution boundary using an instrumented backend, not just a mocked loader method. Assert calls **and** data/errors visible to the user.

| Case                                              | Required observation                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Many orders, few distinct customers               | One batch per scheduling turn with each distinct key once; mapped order outputs all correct.                                                            |
| One customer ID repeated in three orders          | One backend lookup for the key in a request; all three waiters settle.                                                                                  |
| One missing or denied key                         | Explicit `null` or authorized error for that key, consistent with the GraphQL field contract; no substitution of the wrong row or existence disclosure. |
| One key returns Error, other keys succeed         | Partial `data` and an error at the affected field's path; unrelated items remain when nullable.                                                         |
| Concurrent viewer A and B request the same ID     | Separate backend calls with each viewer identity; no row for another viewer, permission decision, or cached Error.                                      |
| Same viewer, second GraphQL request               | Fetches again under its fresh context and sees updated visibility/data.                                                                                 |
| Two subscription events on one connection         | Each event uses a newly created cache and can observe revocation/data changes.                                                                          |
| Nested/alias/fragment path and protected mutation | Each path consults the authoritative policy; forbidden access denied without privileged side effects.                                                   |

For example, instrument `calls.push({ viewerId, ids })` inside the backend boundary. Assert both `calls.length` and each batch's distinct `ids`, plus returned labels from the _authenticated_ viewer. Use `Promise.all` around two request executions to make the concurrency test real. Include an error in the middle of a larger batch so partial results cannot pass by truncation.

First run the new regression suite against the **original** implementation with a global cache or serial lookup: it must fail for the intended defect. Then run it against the repair and report both results. For subscription behavior, run two distinct event executions; one request containing two fields is not proof of event isolation.

## Performance and abuse checks

Use representative nested operations (including fragments and aliases), count backend fan out and total keys, compare before/after, and test the maximum allowed page size/cost limit. Bound depth, aliases, list cardinality, and downstream calls together; depth alone cannot stop expensive sibling fan out. If batching merges errors or nullifies a non null parent, fix the execution semantics rather than suppressing errors. A local test proves local behavior only; mark policies that apply only at deployment, production traffic, and remote subgraph observations as unverified when unavailable.
