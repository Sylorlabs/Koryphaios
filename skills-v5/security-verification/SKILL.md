---
name: security-verification
description: Test whether a security control is enforced at its actual trust, identity, or isolation boundary. Use when security verification or authorized negative tests are requested; use security-review for discovery without execution and authorization-security for permission policy design.
---

# Security Verification

Prove security properties at the layer that can enforce them. A hidden button, client-side check, prompt instruction, HTTP status alone, or successful authentication is not proof that authorization or isolation holds.

## Verification workflow

1. **Write the security claim.** Identify the protected asset, actor/identity, role or attributes, operation, object/tenant scope, trust boundary, and expected allow/deny result. Separate authentication from authorization and UI affordance from server enforcement.
2. **Build a positive/negative matrix.** Include an allowed control plus meaningful denied cases: unauthenticated, wrong role, same-role different user/object, different tenant, missing scope, expired/revoked credential, and malformed or stale identity context when applicable. Do not enumerate impossible states just to inflate coverage.
3. **Exercise the enforcing boundary.** Send the request through the real API/service/resource boundary in an owned or disposable environment. Change identifiers, identity/session context, or protocol inputs only as needed to test the declared control. Never treat merely hiding a route or client control as enforcement.
4. **Verify denied non-effects independently.** Read protected state through an independent path after denied mutations. Confirm no partial mutation, queued side effect, leaked object data, privileged cache entry, or sensitive diagnostic was created even when the response looked denied.
5. **Test revocation and dependency failure where relevant.** If authorization depends on a policy service, cache, directory, token, or key service, verify the documented stale-decision window and fail-closed/fail-safe behavior. A temporary dependency failure must not silently widen privilege beyond the contract.
6. **Inspect observability without leaking secrets.** Confirm security-relevant denials/sensitive operations produce the required audit evidence while credentials, tokens, secrets, and protected payloads do not appear in user-visible errors or logs beyond policy.
7. **Issue a bounded verdict.** Map each control claim to fresh positive and negative evidence. State which identities, roles, objects, tenants, protocol variants, and failure states were not tested.

## Boundaries

- `security-review` discovers and prioritizes risks from code/configuration/evidence; this skill executes a specific security-control proof.
- `authorization-security` designs role/attribute/resource policy and enforcement architecture; this skill verifies the implemented policy.
- `application-security`, `cloud-security`, and other security specialists own broader hardening domains.
- `oauth-oidc` owns protocol-specific OAuth/OIDC semantics. Compose it when token issuance, PKCE, redirect handling, audience, or OAuth threat mitigations are themselves under test.

Use [the maintained source map](references/sources.md) for the applicable control taxonomy and testing method. Keep testing scoped to systems the task authorizes.
