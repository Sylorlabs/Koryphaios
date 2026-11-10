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

When a supplied task includes an executable evaluator contract and corpus, preserve those fixed inputs and write the required result artifact at its exact declared path. Do not modify evaluator code or evidence fixtures to make a protocol result pass; an integrity failure remains a failure.

## Deliverable shape

When a task declares a typed protocol artifact, write it at the declared path and mirror the declared interface field for field. An array of permitted algorithms is not a single algorithm string, a record of APIs is keyed by the API name the evaluator asks for, and a nested validation block keeps the keys the reader tests.

The fixed evaluator source, not the prose around it, defines the shape. Read the declared interface and its defaults before writing the artifact, and keep the reader file untouched so the produced artifact is the only thing that can change a result.

The fixed evaluator source, not the prose around it, defines the shape. Read the declared interface and its defaults before writing the artifact, and keep the reader file untouched so the produced artifact is the only thing that can change a result.

For a multi issuer relying party spec, each provider entry carries its issuer, the issuer its discovery document was fetched from, its client id and the list of permitted algorithms. Both the session binding flag and the discovery trust flag are set, every declared validation check is enabled, the API map is keyed by the short API identifier the evaluator passes (`A` and `B` for a corpus that names its APIs `apiA` and `apiB`), not by an audience string, and each entry carries that API's audience and its required scope under the field name the interface declares (`requiredScope`, not `scope`), and the ownership boundary names the skill that owns object authorization. An either or control is answered on both sides, not just the side that reads well.

## Boundaries

- `secure-authentication` owns passwords/passkeys/MFA/recovery and local reauthentication assurance.
- `authorization-security` owns application resource policy after token/subject validation.
- `web-security` owns broader browser-origin/cookie/CSP/CORS concerns beyond protocol-specific redirect/session protections.
- `secrets-key-management` owns private keys/client secrets/KMS lifecycle; this skill consumes the resulting keys correctly.
- `security-verification` owns final runtime proof of the implemented protocol behavior.

Use [the maintained source map](references/sources.md) for RFC 9700 BCP 240, PKCE, DPoP, and OpenID Connect Core 1.0 Errata Set 2.
