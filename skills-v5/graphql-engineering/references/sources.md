# Source map

This map anchors portable GraphQL decisions in the September 2025 GraphQL specification. Resolver batching, federation, and cost controls are implementation concerns whose exact mechanisms must be verified in the chosen server stack.

## Adopted principles

- Nullability is executable schema semantics. Field errors can propagate null through non-null boundaries, so nullability changes affect clients and failure behavior.
- Adopt the input/output distinction from the Non-Null and Required Arguments sections, opened 2026-09-06. Adapt compatibility review to required inputs without defaults and weakened output guarantees; reject a direction-free rule that all nullability changes have the same compatibility effect.
- The specification defines a breaking change as one that can make a previously valid request invalid. Deprecation is the built-in signal for schema elements intended for retirement.
- Enum input accepts enum values, not string literals. Enum additions and removals still need client compatibility review because generated clients can model enums exhaustively.
- Validation and execution are distinct phases; a schema-valid document can still produce field errors during execution.

## Conditional or non-adopted recipes

- DataLoader-style batching, persisted queries, federation, depth limits, and cost analyzers are stack-specific recipes, not GraphQL specification requirements.
- Cursor pagination is preferred when stable continuation is required, but no specific Relay shape is mandated unless the existing API already adopts it.
- Authorization architecture is not defined by the GraphQL specification. Enforce the repository's authorization policy at data and action boundaries.

## Verification scope

Verify schema compatibility, validation, execution errors, null propagation, pagination stability, resolver fan-out, and authorization paths in the actual server implementation. The specification establishes semantics but does not prove server-specific batching, cost, or authorization behavior.

## Primary sources

- GraphQL specification root: https://spec.graphql.org/
  - Existing navigation source retained from 2026-09-04.
- GraphQL Specification, September 2025: https://spec.graphql.org/September2025/
  - Adopted for type-system compatibility, null and error propagation, enum input, deprecation, validation, and execution semantics.
  - Verified 2026-09-06.
