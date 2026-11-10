# Source map

`edge-cdn` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Portable HTTP caching semantics come from RFC 9111, while provider defaults, cache keys, status headers, stale behavior, purge and tiering can change quickly. Refresh the selected CDN's current documentation before encoding operational behavior.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader network-service-backend.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **RFC 9111: HTTP Caching**: https://www.rfc-editor.org/rfc/rfc9111
  - Scope: current HTTP caching standard.
  - Use: shared/private cache semantics, freshness, validation, cache controls and stale response requirements independent of provider implementation.
  - Verified: 2026-09-05; refresh after 365 days.
- **Cloudflare default cache behavior**: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
  - Scope: documentation updated 2026-09-14.
  - Use: current Cloudflare method/Cache-Control/Set-Cookie and default cacheability behavior. Provider rules/plan options can override defaults.
  - Verified: 2026-10-16; refresh after 14 days.
- **Cloudflare cache keys**: https://developers.cloudflare.com/cache/how-to/cache-keys/
  - Scope: documentation updated 2026-09-29.
  - Use: default/custom cache-key composition and cache fragmentation implications; do not assume another CDN keys the same request dimensions.
  - Verified: 2026-10-16; refresh after 14 days.
- **Cloudflare purge cache**: https://developers.cloudflare.com/cache/how-to/purge-cache/
  - Scope: documentation updated 2026-09-29.
  - Use: current targeted purge modes and provider guidance favoring granular invalidation; custom-key purges must account for key dimensions as documented.
  - Verified: 2026-10-16; refresh after 14 days.
- **Cloudflare revalidation**: https://developers.cloudflare.com/cache/concepts/revalidation/
  - Scope: documentation updated 2026-09-29.
  - Use: current fully asynchronous stale-while-revalidate behavior introduced in 2026 plus validator/cache-status semantics.
  - Verified: 2026-10-16; refresh after 14 days.
- **Cloudflare Tiered Cache**: https://developers.cloudflare.com/cache/how-to/tiered-cache/
  - Scope: documentation updated 2026-09-29.
  - Use: lower/upper-tier topology and origin shielding; distinguish edge MISS from actual origin request.
  - Verified: 2026-10-16; refresh after 14 days.
- **Cloudflare cache responses**: https://developers.cloudflare.com/cache/concepts/cache-responses/
  - Scope: documentation updated 2026-09-04.
  - Use: current cache-status and Age interpretation, including tiered-cache behavior.
  - Verified: 2026-10-16; refresh after 14 days.

## Interpretation rules

- Shared-cache safety precedes hit rate. Decide cacheability for auth/cookies/Set-Cookie/private data before selecting TTL/key optimizations.
- Enumerate the cache key and every field that can change a cacheable representation. Same key must mean interchangeable response; omitted correctness/security dimensions can leak or poison, while unbounded dimensions destroy cache efficiency.
- Distinguish browser freshness, shared edge freshness and object retention. Use provider status/Age plus validators to observe miss/hit/revalidation/stale states.
- Custom keys and purges are coupled. Targeted invalidation must include the provider-required key dimensions; routine purge-everything is not a substitute for sound versioning/key design.
- Verify stale behavior against current provider semantics. Cloudflare changed stale-while-revalidate to fully asynchronous behavior in 2026, so older examples can be materially wrong.
- Tiered cache changes origin topology. Measure lower/upper tier and actual origin requests separately.
- Edge certificate success does not prove edge-to-origin TLS or generic network path. Keep origin hostname/SNI/trust and underlay evidence separate.
- Validate multiple relevant POPs and cold/warm/expired/failure/recovery states before claiming a global CDN rollout is correct.
