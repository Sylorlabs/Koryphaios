# Package local checks

Run the scoped checks from the repository root with the installed Bun runtime:

```sh
bun test skills-v5/graphql-engineering/evals/package-local.test.ts
bun test skills-v5/graphql-engineering/evals/executor-evidence.test.ts
git diff --check -- skills-v5/graphql-engineering
```

The checks are offline and read only with respect to the repository. The package test validates the package schema, source map provenance and refresh policies, local Markdown links, prose signal, public and held out package only routing, full task identities and artifact contracts, and the registered evaluator negative controls for both GraphQL scenarios. The executor probe attempts a real installed `graphql-js` executor. When present, it executes the supplied-style persisted legacy operation, absent/present avatar responses, nested non null `Avatar.url` failure, and `__type` introspection with deprecation metadata. When absent, it emits an explicit unavailable evidence assertion instead of substituting SDL regexes or helper calls. Neither test seeds global skills, writes a ledger, runs a qualification campaign, runs a blind review campaign, or creates paired same model task evidence.

The read-only avatar fixture also keeps explicit dispositions in
`evals/fixtures/nullable-field-evolution/boundary-dispositions.json` for mutation
authorization, N plus 1 and batching, pagination, authorization bypass, and
query-cost limits. Each disposition includes a reason and is a bounded local
fixture statement, not evidence for a production boundary.

The registered evaluator controls are useful regression instruments. They reject the vulnerable starters and exercise the scenario contract, but they do not prove that a future worker will produce a correct result. The full task fixtures still require current paired skill and no skill runs with the same model and starting state, calibrated deterministic evidence, and independent blind semantic review before promotion.

## Evidence boundary

The package owns GraphQL schema, resolver, loader, execution, and GraphQL specific security and performance decisions. `api-contract-design` remains the broader transport neutral contract owner. `authorization-security` owns authorization policy; GraphQL enforcement paths are tested here when they are part of the live GraphQL task. `http-rest-engineering`, `grpc-protobuf`, and `backend-engineering` own their respective transport, wire, and backend responsibilities.

Local results establish package integrity and bounded fixture controls only. The avatar boundary matrix records mutation, N plus 1, pagination, authorization, and query-cost status as exercised, not applicable, or unavailable; those labels are not proof of the absent boundaries. Production traffic, real client deserialization, remote subgraph behavior, deployed HTTP intermediaries, and latency or resource claims outside the fixture are unavailable unless separately exercised and recorded.
