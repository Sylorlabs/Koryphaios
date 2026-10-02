---
name: http-rest-engineering
description: Engineer HTTP and REST interfaces with correct methods, status, caching, conditional requests, content negotiation, proxies, and resilience. Use when the request specifically requires rest api, http endpoint, http caching, http status; prefer a narrower child only when its boundary is established.
---

# Http Rest Engineering

## Responsibility

Use HTTP semantics deliberately: safe/idempotent methods, status classes, Location, validators, conditional requests, Cache-Control, content types, redirects, range/streaming, and proxy behavior. Separate application identity/auth from transport connection identity.

## Transferable decisions

- Choose methods from HTTP semantics first: whether an operation is safe, idempotent, cacheable, or state-changing determines retry and intermediary behavior.
- Use status codes and representation bodies together. A status communicates protocol-level outcome; domain details can use a stable error representation such as Problem Details when that format fits the API.
- Define cache keys, freshness, validators, and `Vary` inputs explicitly for reusable responses. Personalized or authenticated responses need deliberate shared-cache policy.
- Distinguish cache revalidation from lost-update protection. `If-Match` uses strong entity-tag comparison; modification dates can be too coarse for concurrent writes. Prefer standard preconditions when they fit, but preserve a valid existing application-version contract unless its replacement is justified and compatible.
- Trust proxy-derived identity or scheme information only from configured trusted intermediaries.

## Observable checks

- In an isolated fixture or authorized provider test mode, replay changed operations to verify duplicate behavior and non-idempotent retry protection. Do not create real charges, messages, or other live side effects merely to test a replay.
- Exercise cache miss, fresh hit, stale revalidation, `Vary` variants, and authenticated or personalized responses at the actual cache boundary.
- Send malformed content, unsupported media types, invalid preconditions, missing auth, and denied auth, then verify status and response semantics.
- Test validator-based concurrent modification with stale and current validators.
- Exercise timeout and streaming disconnect behavior through the same proxy or gateway path used in deployment.

## Failure boundaries

Do not tunnel every action through POST without reason, cache personalized data incorrectly, trust forwarded headers from untrusted peers, or retry non-idempotent requests blindly. Do not infer origin behavior from a direct local request when production intermediaries can change caching, headers, or timeouts.

## Hierarchy and routing

- Broader skills: api-contract-design.
- No narrower bundled child is declared.
- Required skills: verification.

Route here when method, status, caching, validators, content negotiation, redirects, proxies, or HTTP retry semantics are central. Keep resource lifecycle and transport-neutral public contract decisions in `api-contract-design`.

## Completion evidence

- Method, status, cache, validator, and content-type decisions for the changed operations.
- Retry and concurrent-modification results through a deployment-representative HTTP path, identifying the isolated test environment and any production-only unknowns.
- Cache hit, revalidation, `Vary`, and personalized-response evidence where caching changed.
- Proxy, timeout, or streaming-disconnect evidence when intermediaries are part of the path.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
