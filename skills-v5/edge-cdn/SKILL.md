---
name: edge-cdn
description: Engineer CDN and edge delivery with correct cache identity, freshness, invalidation, and origin boundaries. Use when diagnosing edge caching, personalized response leakage, origin shielding, or propagation; use networking-systems for general DNS, IP, and transport path issues.
---

# Edge CDN

Treat the CDN as a distributed HTTP state machine, not a transparent pipe. The decisive questions are what is cacheable, which request dimensions identify one representation, how freshness/revalidation works, what each POP/tier currently stores, and how a change or purge reaches every relevant variant without exposing personalized data.

Preserve the task's existing configuration and artifact contract. When repository types, schemas, or required fields already define the edge policy shape, populate that shape directly. Do not replace required fields with a cleaner nested model or a provider shaped abstraction unless the task asks for a schema change.

## Workflow

When the task supplies a concrete contract, required fields, or artifact schema, satisfy that contract exactly while applying edge delivery discipline; do not replace requested outputs with a different shape.

1. **Pin the edge configuration.** Record provider, zone/property/service, hostname, rules/configuration revision, relevant POP/region, origin hostname, cache tier/shield topology and deployment timestamp. Provider defaults and cache-status headers are version-sensitive.
2. **Define cacheability before tuning hit rate.** For each route/status/method, decide whether shared caching is allowed. Account for `Cache-Control`, `CDN-Cache-Control` or provider overrides, `private`/`no-store`/`no-cache`, authorization, cookies, `Set-Cookie`, error statuses and dynamic responses. Never make personalized output cacheable merely to improve HIT ratio.
3. **Write the cache-key contract explicitly.** List scheme/host/path, query parameters, headers, cookies, device/geo/language and rewrite/origin dimensions that change representation. Exclude noise deliberately; include every correctness/security dimension. Unbounded high-cardinality dimensions can destroy hit rate, while omitted dimensions can leak or mix content.
4. **Keep cache key and origin behavior aligned.** If two requests share a cache key, their cacheable response must be interchangeable. Verify rewrites, normalization, redirects and origin `Vary`/content negotiation do not create variants that the CDN key collapses incorrectly. When content coding changes the stored bytes, make the normalized encoding variant (`br`, `gzip`, `identity`, or the provider's equivalent) part of the effective cache identity or prove from current provider behavior that the CDN safely partitions it for you; purge and verification must cover those variants too.
5. **Separate browser, edge and shared-cache freshness.** Model `max-age`, `s-maxage`, explicit edge TTL overrides, validators (`ETag`/`Last-Modified`), stale-while-revalidate, stale-if-error and provider-specific stale settings. Treat stale-while-revalidate and stale-if-error as separate allowances with their own cutoffs: test healthy revalidation, origin timeout/5xx inside the stale-if-error window, and failure after that window expires. TTL is freshness, not guaranteed retention.
6. **Test miss, hit, revalidation and stale states.** Observe provider cache-status and `Age`/validator behavior from representative POPs. A single HIT does not prove key correctness, global propagation or stale behavior.
7. **Make invalidation match the actual key.** Prefer targeted purge by exact URL/key/tag/prefix/hostname when supported. If custom key dimensions are involved, include the dimensions required by the provider's purge semantics. Do not use purge-everything as a routine substitute for versioned assets or correct invalidation design.
8. **Bound personalized and authorization-sensitive caching.** Prefer bypass/private responses unless a finite, auditable key dimension genuinely partitions authorization state. Verify anonymous, authenticated, different-user/tenant and logged-out transitions; ensure one user's response cannot become another's shared HIT.
9. **Protect against cache poisoning and uncontrolled variance.** Only key on trusted/bounded headers/query values, normalize or reject ambiguous inputs where appropriate, and verify unkeyed request fields cannot alter a cacheable response. Escalate exploit/threat design to the security skill while retaining edge-cache evidence here.
10. **Model tiered cache/origin shielding.** Know which lower/upper tier can contact origin, how revalidation flows, and whether origin traffic metrics reflect edge misses or upper-tier misses. Verify shielding reduces origin fan-out without hiding stale or failed upper-tier behavior.
11. **Verify origin and edge TLS separately.** Pin client-to-edge hostname/certificate behavior and edge-to-origin SNI/hostname/trust/mTLS settings. A valid edge certificate does not prove origin TLS is correct; generic route/TCP failures remain `networking-systems` work.
12. **Treat errors and origin failure deliberately.** Decide which statuses may cache, how stale-on-error works, and whether failover/origin shielding changes freshness. Test origin timeout/5xx and recovery so stale content cannot persist beyond policy or error storms bypass the intended shield.
13. **Measure global behavior, not one POP.** Sample materially different POPs/regions and both cold/warm states where the feature is global. Track cache-status, age, selected key variant, origin request count and deployment/purge propagation. Tie observations to the deployed revision and timestamp, and label locations or tiers you did not observe instead of promoting representative samples into a global-completion claim.
14. **Deploy reversibly.** Stage cache-rule/key/TTL/origin changes, retain a known-safe rollback target, use versioned immutable assets where practical, perform the narrow purge required for changed representations and verify rollback does not leave incompatible cached variants behind. The immediately previous revision is not automatically a valid rollback target: if it caused or preserved the incident, fall back to a known-safe revision or a safe bypass posture instead of reactivating it.

## Boundaries

- `networking-systems` owns generic DNS, route, NAT/firewall, TCP/UDP, PMTUD and TLS path localization. `edge-cdn` owns CDN-specific edge selection, caching, tiering and edge-to-origin policy after/beside that underlay.
- `network-service-backend` owns origin application behavior and HTTP/gRPC service logic. This skill owns how the CDN caches, forwards, shields and revalidates those responses.
- `application-security` owns threat analysis and exploit remediation beyond the cache boundary. This skill owns cache-key/privacy/poisoning evidence and the safe edge configuration needed to prevent shared-cache mixing.
- Cloud-provider skills own provider account/IAM/infrastructure control planes. This skill owns CDN behavior independent of which cloud hosts the origin.
- Browser-only cache tuning, generic reverse-proxy application config, certificate issuance, or static asset build tooling do not activate this skill unless shared edge/CDN behavior is changing or being evaluated.

Use [the maintained source map](references/sources.md) before relying on provider-specific cache defaults, purge, revalidation, status or tiering behavior.
