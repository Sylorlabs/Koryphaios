# Source map

This map separates transport neutral contract decisions from protocol specific child guidance. OpenAPI is a concrete schema contract reference for HTTP APIs. It is not a mandatory representation for every API style.

## Adopted principles

- A machine readable operation contract needs explicit request and response shapes. OpenAPI 3.2 defines operations, responses, parameters, schemas, security, callbacks, and links as distinct contract elements.
- A compatibility review should identify whether a previously valid caller interaction becomes invalid or changes meaning. The exact protocol rules belong to the child skill that owns that protocol.
- Error payloads need stable machine readable identity when clients are expected to branch on error semantics. RFC 9457 is one standardized HTTP representation when Problem Details is chosen.
- A client supplied continuation token that must resist tampering needs authenticated integrity or opaque server side state. RFC 2104 defines HMAC as keyed message authentication; a plain checksum is not an authentication mechanism.
- RFC 4648 sections 3.2, 3.3, 3.5, and 5 distinguish padding policy, alphabet rejection, canonical pad bits, and base64url. The continuation procedure adopts exact reencoding as an explicit application policy when a token has one accepted spelling. Encoding alone provides neither integrity nor confidentiality.
- Schema documents and generated clients are artifacts to compare with runtime behavior, not substitutes for contract tests.

## Conditional recipes and recipes not adopted

- OpenAPI is conditional on HTTP APIs that already use or need an OpenAPI description. It is not required for GraphQL or gRPC services.
- RFC 9457 Problem Details is a reusable HTTP error format, not a requirement for every API or every error response.
- No versioning scheme, pagination style, code generator, or schema registry is prescribed globally.
- The caller compatibility procedure is applied engineering guidance. Neither OpenAPI nor the cited RFCs prescribe a particular cancellation boundary, enum adaptation, cursor lifetime, deprecation window, or replay response. Supplied caller promises govern those choices. Preserving normative inputs and executing maintained regressions are evidence practices, not protocol requirements.

## Verification scope

Verify schema validity, prior contract compatibility, representative success and failure states, pagination boundaries, retry behavior, concurrency conflicts, and deployed implementation conformance where reachable. Generated code compilation alone does not verify runtime behavior.

## Primary sources

- OpenAPI latest reference: https://spec.openapis.org/oas/latest.html
  - Existing navigation source retained from 2026-09-04.
- OpenAPI Specification 3.2.0: https://spec.openapis.org/oas/v3.2.0.html
  - Adopted for exact operation, response, parameter, schema, security, callback, and link semantics.
  - Verified 2026-09-06.
- RFC 9457, Problem Details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457.html
  - Conditional error representation for HTTP APIs.
  - Verified 2026-09-06.
- `RFC 2104, HMAC: Keyed-Hashing for Message Authentication`: https://www.rfc-editor.org/rfc/rfc2104.html
  - Adopted only when a continuation token or comparable caller supplied state must resist tampering.
  - Verified 2026-09-13.
- RFC 4648, The Base16, Base32, and Base64 Data Encodings: https://www.rfc-editor.org/rfc/rfc4648.html
  - Adopted for alphabet, padding, and canonical encoding facts; the strict token acceptance policy remains explicit in the application contract.
  - Verified 2026-10-17.
