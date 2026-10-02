---
name: oauth-oidc
description: Design and review OAuth and OpenID Connect flows, token validation, issuer binding, redirect protection, and refresh lifecycle. Use when OAuth, OIDC, or authorization code flows are involved; use secure-authentication for local authenticators and authorization-security for application resource permissions.
---

# OAuth and OpenID Connect

Treat OAuth as delegated authorization and OIDC as an authentication layer on top of OAuth. Identify each actor: authorization server/OpenID Provider, client/Relying Party, resource server, browser/user agent, and user. Bind every artifact to the actor, issuer, redirect, audience, client, and request that is supposed to consume it.

## Protocol workflow

1. **Inventory client type and trust.** Record public/confidential status, browser/native/server execution, registered redirect URIs, authorization server(s), resource server audiences, supported response/grant types, client authentication method, and where tokens can be stored.
2. **Prefer authorization code with PKCE.** Public clients must use PKCE; use `S256`. Bind the authorization request to the token request and reject downgrade/missing-verifier conditions. Avoid the implicit grant for new designs unless an exceptional documented case has compensating controls.
3. **Match redirects exactly.** Register exact redirect URIs and reject open redirects. Native loopback redirects may follow the specific variable-port exception. Never accept wildcard/subdomain/prefix logic that broadens the registered destination unexpectedly.
4. **Bind browser/session state.** Use `state` for CSRF/session correlation unless another standard mechanism demonstrably supplies the required protection; OIDC `nonce` binds the authentication response to the initiating session and helps prevent replay. Do not conflate the two.
5. **Validate artifacts at their intended consumer.** For JWTs, verify issuer, signature/key selection, permitted algorithm, audience/client, temporal claims, and protocol-required nonce or `azp`. Opaque access tokens instead need authenticated introspection or the provider's trusted reference-token validation, including active state and resource/scope authorization. Check authorization-code redemption separately. Decoding is not validation; an ID token is not an API access token.
6. **Prevent mix-up and token leakage.** Multi-issuer clients bind authorization responses to the expected issuer/AS and use issuer identification or distinct redirects as appropriate. Keep codes/tokens out of logs, referrers, URLs beyond protocol-required transient handling, analytics, and browser storage where the client architecture cannot protect them.
7. **Constrain bearer replay where risk justifies it.** Use sender-constrained access/refresh tokens (for example DPoP or mTLS) when appropriate. For public-client refresh tokens, use rotation or sender constraint as required by RFC 9700, detect replay/compromise, and revoke the affected token family/authorization as designed.
8. **Separate scopes from local authorization.** Scopes and token claims constrain delegated capabilities but do not replace resource-level tenant/object/field policy inside the application.

## Boundaries

- `secure-authentication` owns passwords/passkeys/MFA/recovery and local reauthentication assurance.
- `authorization-security` owns application resource policy after token/subject validation.
- `web-security` owns broader browser-origin/cookie/CSP/CORS concerns beyond protocol-specific redirect/session protections.
- `secrets-key-management` owns private keys/client secrets/KMS lifecycle; this skill consumes the resulting keys correctly.
- `security-verification` owns final runtime proof of the implemented protocol behavior.

Use [the maintained source map](references/sources.md) for RFC 9700 BCP 240, PKCE, DPoP, and OpenID Connect Core 1.0 Errata Set 2.
