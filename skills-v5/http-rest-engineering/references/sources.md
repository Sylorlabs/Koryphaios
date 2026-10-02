# Source map

This map keeps core HTTP semantics, caching semantics, error representation, and machine-readable API description separate. Runtime proxy and cache behavior still needs verification in the deployed path.

## Adopted principles

- RFC 9110 defines method safety and idempotency, status semantics, representations, validators, conditional requests, and field semantics that intermediaries depend on.
- RFC 9111 defines cache storage, freshness, revalidation, `Vary`, authenticated-response constraints, and shared versus private cache behavior.
- Adopt strong `If-Match` comparison for entity-tag preconditions and distinguish it from cache revalidation. RFC 9110 sections 8.8 and 13.1.1 were opened 2026-09-06; modification dates may miss changes within their resolution.
- RFC 9457 provides a standard Problem Details representation when an HTTP API needs structured error details.

## Conditional or non-adopted recipes

- OpenAPI is a conditional contract artifact and remains under the broader API-contract concern; it is not required for every HTTP endpoint.
- Problem Details is optional. Existing stable error formats should not be replaced without a compatibility reason.
- CDN products, reverse proxies, retry middleware, and cache libraries are implementation choices and are not prescribed here.
- Adapt replay checks to an isolated test path. Reject blanket replacement of established application-version contracts and live non-idempotent replay without task authority.

## Verification scope

Verify method retry behavior, status and content negotiation, validators, preconditions, cache storage and revalidation, `Vary`, authenticated responses, proxy-derived fields, timeouts, and disconnects through the actual intermediary chain. Standards define semantics but do not prove configuration.

## Primary sources

- RFC 9110, HTTP Semantics: https://www.rfc-editor.org/rfc/rfc9110.html
  - Validator strength, conditional requests, and method semantics inspected 2026-09-06.
- OpenAPI latest reference: https://spec.openapis.org/oas/latest.html
  - Existing API-description source retained from 2026-09-04.
- RFC 9111, HTTP Caching: https://www.rfc-editor.org/rfc/rfc9111.html
  - Adopted for cache storage, freshness, `Vary`, revalidation, and shared-cache behavior.
  - Verified 2026-09-06.
- RFC 9457, Problem Details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457.html
  - Conditional structured error representation.
  - Verified 2026-09-06.
