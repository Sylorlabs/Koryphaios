# GraphQL schema evolution and regression playbook

Use this when a live client continues selecting an old field while the domain adds an optional richer representation. Apply the repository's own migration contract and the policy for supported clients; the example is illustrative, not a mandate to rewrite every API this way.

## Investigate before choosing a nullability transition

Capture the old SDL, the actual persisted client query, mobile and generated client version support, how the resolver handles absence, and the current resolver's error propagation. Keep storage tables and join strategy behind the resolver boundary.

For example, an existing schema might promise:

```graphql
type User {
  id: ID!
  avatarUrl: String!
}
```

Now an absent avatar is valid domain data, and a new richer representation is requested. A transitional schema **may** be:

```graphql
type User {
  id: ID!
  avatar: Avatar
  avatarUrl: String @deprecated(reason: "Use avatar.url; null when no avatar is set.")
}

type Avatar {
  url: String!
  width: Int!
  height: Int!
}
```

The richer `avatar` is nullable because absence is valid. Its fields are non null only if every _present_ Avatar guarantees those values. The old `avatarUrl` still resolves from the same domain object; an absent avatar resolves to `null` under this revised contract. The old operation remains syntactically valid and discoverable via introspection `includeDeprecated: true`.

**Do not call this unconditionally backward compatible.** `avatarUrl: String!` → `String` weakens an old runtime guarantee, and generated clients might crash or reject nullable output. If the existing public contract already defines a meaningful non null placeholder, keeping `String!` throughout the compatibility window might be preferable. If no honest fallback exists, explicitly document the nullability relaxation, update/qualify affected clients, and coordinate its rollout; never invent a fake asset to satisfy a type. The domain's "no avatar" state cannot be reconciled with an unconditional non null guarantee without a deliberate policy.

## Rollout contract

1. **Expand:** add the optional field, implement resolver mapping from the public domain model, keep the original query name/selection valid. Define how absence differs from a failure to fetch data.
2. **Coexist:** use the legacy nullability approved by the migration, deprecate with an actionable reason, ship/validate both old and new operations in the same server deployment. Keep the compatibility field until the declared support window ends.
3. **Observe:** track actual persisted operation use and versions of generated clients. Treat schema diff output as advisory until old client execution/parsing is tested. Check introspection returns `isDeprecated` and `deprecationReason` for the legacy field.
4. **Retire:** remove only when explicit usage and exit criteria for supported clients are met. State rollback conditions and how old deployed clients behave after rollback/cutover.

Do not bury a storage migration or a new API version in a GraphQL field change without a demonstrated public requirement.

## Executable acceptance matrix

| Query/condition                                           | Expected execution evidence                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Original persisted mobile operation, avatar present       | Legacy URL still selected, same user identity, no errors.                                                                               |
| Original operation, avatar absent                         | Defined legacy absence result; if field was made nullable, verify the parser of old clients tolerates `null` or record incompatibility. |
| New operation, avatar present                             | Object `url`/dimensions populated with declared types.                                                                                  |
| New operation, avatar absent                              | `avatar: null`, user/sibling fields preserved, no error for legitimate absence.                                                         |
| New operation, avatar resolver throws                     | `avatar: null` plus error with `path: ["user", "avatar"]` (or alias key); user remains if `avatar` is nullable.                         |
| Legacy non null resolver throws (when `String!` retained) | Error propagates through the non null field to the nearest nullable ancestor.                                                           |
| Introspection query, deprecated fields included           | Legacy field discoverable, `isDeprecated: true`, migration reason present.                                                              |
| Old/new query documents                                   | Validation passes against the transitional schema; generated client/runtime compatibility checked separately.                           |

Prefer tests through the installed GraphQL executor rather than only invoking a helper function. Resolve the executor from the actual project environment, record its package and version, and retain the observed result. For example, with `graphql-js`:

```ts
const result = await graphql({
  schema,
  source: legacyOperation,
  variableValues: { id: 'u2' },
  contextValue: testContext,
});
expect(result.data?.user).toBeDefined();
expect(result.errors ?? []).toEqual([]);
```

Add separate assertions for nullable output, deprecation/introspection, and thrown resolver behavior. Use the actual query (including fragments/aliases), declared variable types, and client deserialization where possible. The introspection assertion must request `includeDeprecated: true` and inspect `isDeprecated`, `deprecationReason`, and the nullable `type` wrapper, rather than matching SDL text. A schema regex, TypeScript compile, or mock return value alone cannot prove GraphQL execution semantics.

If the project has no installed executor, report an evidence record such as `executor: unavailable; lookup: import("graphql"); reason: package is not installed; unperformed: persisted execution and __type introspection`. This is an explicit limitation, not a simulated executor result. A package local probe may attempt the real import and run the same persisted operation, absence case, nested non null failure, and introspection query when the dependency is present.

## Boundary disposition for the nullable avatar migration

The following checks must be classified instead of silently omitted:

| Boundary                    | Disposition for a singular `Query.user` avatar migration                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutation authorization      | `not applicable` when the supplied operation and fixture are read only and expose no avatar mutation. If a mutation is added, execute its input validation, authorization, and side effect boundary separately.                             |
| N plus 1 and batching       | `not applicable` when the fixture contains one user and no repeated avatar/backend lookup, otherwise `unavailable` until the real resolver/backend call count is measured. Do not treat one successful field response as batching evidence. |
| Pagination                  | `not applicable` for `Query.user(id: ID!)`, which is singular. A connection or list requires stable cursor/order evidence across a page boundary and a nearby write.                                                                        |
| Authorization bypass        | `unavailable` when no policy, viewer context, or protected nested field is supplied. If protected data is in scope, exercise aliases, fragments, direct lookup, and nested resolvers against the authoritative policy.                      |
| Query cost and abuse limits | `unavailable` when no installed validation/cost boundary is present. If configured, record the actual executor, limits, rejected operation, permitted boundary, and measured downstream fan out.                                            |

These dispositions do not prove safety outside the fixture. They prevent a local read only migration result from being promoted into mutation, performance, authorization, pagination, or production claims.

When running a regression for a known defect, confirm the new tests fail against the original broken resolver/schema and pass the repaired version. Keep these tests in the maintained test suite. Record any testing with a real mobile client that could not run as **unavailable**, not as compatible.
