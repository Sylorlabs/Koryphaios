---
name: web-security
description: Secure browser execution contexts, origins, cookies, framing, and messaging. Use when XSS, CSRF, CORS, CSP, or other browser security controls are central; use application-security for general application trust boundaries and oauth-oidc for federation protocol mechanics.
---

# Web Security

Reason from the browser security model: origin, site, browsing context, navigation, automatic credential attachment, DOM/HTML parsing, and execution sinks. Framework auto-escaping helps only when values stay in the context the framework expects.

## Browser security workflow

1. **Map origins and credentials.** Record scheme/host/port origins, same-site relationships, cookies, bearer tokens, embedded/parent windows, trusted third-party origins, API origins, and which requests automatically carry credentials.
2. **Trace browser sources to execution/navigation sinks.** Inventory URL/query/hash, DOM, storage, postMessage, server-rendered data, API responses, and third-party content flowing to HTML/DOM, script, style, URL/navigation, template, and framework escape-hatch sinks.
3. **Prevent XSS at the sink.** Prefer safe DOM/text APIs and framework escaping. Use context-appropriate output encoding for HTML/attribute/URL contexts and a well-maintained sanitizer when intentionally accepting HTML. Avoid unsafe HTML/DOM escape hatches unless sanitized and narrowly justified.
4. **Use CSP as defense in depth.** Build a nonce/hash-based strict policy appropriate to the app, remove broad inline/eval allowances, set required resource directives and framing controls, deploy reporting/Report-Only during migration, then verify enforcement. CSP does not excuse unsafe sinks.
5. **Protect state-changing requests from CSRF.** Determine whether credentials are automatically attached. Use framework-supported synchronizer or cookie-to-header/custom-header patterns as appropriate, SameSite as an additional control, and Origin/Fetch Metadata checks where useful. XSS can defeat many CSRF mechanisms, so fix both classes.
6. **Constrain cross-origin data.** CORS is an API response-sharing policy, not authentication. Allow only required origins/methods/headers/credentials. Never combine broad origin reflection/wildcards with credentials. Validate `postMessage` sender origin and message schema, and send to an exact target origin.
7. **Control navigation/framing.** Validate redirect/navigation destinations, avoid open redirects where they amplify phishing/token flows, constrain embedding via CSP `frame-ancestors` (and legacy X-Frame-Options where required), and reason explicitly about window opener relationships.
8. **Protect cookies and browser storage.** Set Secure/HttpOnly/SameSite/path/domain according to the session model; avoid broad Domain scope. Do not put long-lived credentials in browser storage merely for convenience when a server/BFF design can avoid exposing them to script.

## Boundaries

- `application-security` owns broader files, subprocesses, parsers, server-side outbound requests, serialization, and non-browser trust boundaries.
- `secure-authentication` owns authenticator lifecycle and assurance; browser cookies may carry resulting session state but are not the authenticator design itself.
- `oauth-oidc` owns redirect registration, state/nonce, PKCE, issuer/audience, and token protocol checks.
- `authorization-security` owns resource permissions after browser/request identity is established.
- `security-verification` owns final runtime proof of the implemented browser controls.

Use [the maintained source map](references/sources.md) for the current CSP3 draft status, OWASP browser-defense guidance, and ASVS 5.0.0 requirements.
