---
name: authorization-security
description: Design and review resource, tenant, field, and delegated permission enforcement. Use when access control, roles, revocation, or an authorization boundary is central; use secure-authentication for proving identity and security-verification for executed control evidence.
---

# Authorization Security

Model authorization independently from UI visibility and authentication: may this subject, in this context and possibly through an intermediary, perform this action on this exact resource or field now?

## Policy workflow

1. **Inventory decision inputs.** Enumerate subject/type, tenant, resource ownership/relationships, action, field capability, roles/attributes, delegation, context, admin paths, and state transitions that change entitlement.
2. **Write an explicit matrix.** Define allow/deny and required policy facts for material subject-resource-action combinations. Cover peers, tenant/global admins, service identities, suspended/revoked users, unknown resources, and malformed cases. Unmatched cases deny.
   Role names such as admin, owner, maintainer, or support do not create implicit override authority. Grant only the resource/action/field scope justified by the supplied product policy and relationships; preserve object and tenant constraints for privileged roles unless an explicit policy fact grants a broader override.
3. **Enforce in a trusted tier before the operation.** Client hiding, route guards, disabled controls, or schema visibility are presentation behavior, not authorization boundaries.
4. **Preserve the originating subject through intermediaries.** User-originated service-to-service work must carry the subject/delegation context required by policy instead of inheriting a broader machine identity. Treat confused-deputy paths explicitly.
5. **Scope every lookup and side effect.** Re-check tenant/ownership/relationship after lookup when needed; opaque IDs never replace permission checks. Include bulk/nested/field operations, exports, indirect references, and downstream privileged calls. Denial must prevent durable writes/messages/downloads and other side effects.
6. **Define revocation and staleness.** State when role/relationship/tenant/suspension/revocation changes take effect. If tokens/caches permit bounded staleness, document the window, high-risk exceptions, compensating controls, and fail-closed behavior when policy state is unavailable.

## Verification handoff

Produce the authorization matrix, trusted enforcement map, revocation/staleness contract, denied-side-effect rules, and negative cases. `security-verification` proves them in the running system with independent state inspection.

## Boundaries

- `application-security`: wider application attack surface/implementation. `secure-authentication`: identity and authenticator/session assurance. `oauth-oidc`: OAuth/OIDC protocol mechanics. `cloud-security`: provider IAM/control-plane policy. `security-verification`: final executed proof. None substitutes for the local subject-resource-action decision.

Use [the maintained source map](references/sources.md) for versioned ASVS authorization requirements, OWASP enforcement guidance, WSTG test design, and resource-centric zero-trust principles.
