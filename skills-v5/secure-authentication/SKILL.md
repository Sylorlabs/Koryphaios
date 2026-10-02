---
name: secure-authentication
description: Design login and authenticator lifecycle controls, including passkeys, MFA, recovery, and reauthentication. Use when proving user identity or securing account access; use oauth-oidc for federation protocols and authorization-security for resource permissions.
---

# Secure Authentication

Treat authentication as a lifecycle, not a login form. Define enrollment, binding, verification, throttling, recovery, replacement, revocation, reauthentication, and session-establishment behavior for each authenticator type and assurance requirement.

## Authentication workflow

1. **Define assurance and threat model.** State account sensitivity, remote attacker capabilities, phishing/credential-stuffing risk, recovery risk, device assumptions, and where phishing-resistant authentication is required. Do not label SMS/OTP or memorized-secret flows phishing-resistant.
2. **Separate identifier discovery from secret verification.** Avoid unnecessary account enumeration through login/recovery errors and timing, while preserving usable operational diagnostics. Rate-limit/anti-automate based on the abuse model without making a single attacker-controlled key a trivial denial-of-service lever.
3. **Handle passwords as verifiers, not shared application secrets.** Support long passwords/passphrases, block compromised/common values where policy requires, avoid composition rules that reduce usability without evidence, store only a modern salted password-verifier output, and never log or expose the password.
4. **Bind passkeys/WebAuthn to the correct relying party.** Validate challenge freshness, origin/RP ID, credential identity, signature, user-verification requirements, and sign-counter/backup-state semantics as supported by the chosen WebAuthn level/platform. Treat attestation as optional unless the business/security policy actually needs authenticator provenance.
5. **Design MFA and recovery together.** Enrollment and replacement of a strong factor must require adequate existing assurance or a deliberately designed recovery process. Recovery codes, help-desk paths, email links, device migration, and factor reset can become the weakest authenticator if they bypass the primary controls.
6. **Reauthenticate for sensitive transitions.** Credential changes, recovery, adding/removing strong authenticators, high-risk secret export, and other critical actions should require appropriately fresh authentication. Invalidate or constrain existing sessions when account compromise/recovery requires it.
7. **Make failure and lifecycle observable.** Preserve security-relevant events for enrollment, failed verification, throttling, recovery, authenticator replacement, and revocation without storing secrets or raw authenticator material unnecessarily.

## Boundaries

- `oauth-oidc` owns authorization-code/PKCE, redirects, issuer/audience, ID/access/refresh token validation, nonce/state, and federation protocol details.
- `authorization-security` owns what an authenticated subject may do to a resource.
- `application-security` owns wider session/state storage and cross-cutting application attack surfaces when authenticator logic is not the primary question.
- `web-security` owns browser-origin controls such as CSP/CSRF/CORS/cookie configuration beyond authentication-specific RP/origin binding.
- `security-verification` owns final runtime proof of the implemented authentication controls.

Use [the maintained source map](references/sources.md) for NIST SP 800-63B-4, ASVS 5.0.0 authentication requirements, and current WebAuthn status.
