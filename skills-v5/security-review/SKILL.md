---
name: security-review
description: Review code, configuration, or changes for reachable security weaknesses and supported findings. Use when a security or vulnerability review is requested; review alone does not authorize fixes. Use security-verification for executed control proof and security specialties for design or hardening.
---

# Security Review

Review reachable behavior, not a checklist in isolation. Return only evidence-backed findings, cleared false positives, and explicit remediation/verification handoffs. Do not mutate the target unless implementation is separately requested.

## Review workflow

1. **Bound scope and threat context.** Identify diff vs baseline, reachable components, runtime/deployment assumptions, sensitive assets, identities, entry points, dependencies, and trust boundaries. Consume an existing threat model; otherwise derive only enough context to prioritize review.
2. **Trace attacker-relevant paths.** Prioritize changed trust crossings, auth/session/authorization logic, parsers, files/paths, queries, rendering/templates, process execution, outbound requests, secrets, crypto, queues/caches/logs, and privileged workflows. For each candidate, trace controlled/sensitive source → transformations/guards → identity context → sink or state change, including async/error paths that affect reachability.
3. **Prove prerequisites and clear false positives.** Record required access, control, object knowledge, user interaction, race/state, feature/deployment settings, and network position. Search for downstream enforcement, safe APIs/encoding, canonicalization, framework guarantees, caller constraints, tenant scoping, unreachable code, feature flags, or compensating controls. Scanner output is a lead, not a finding.
4. **Report only supported findings.** Include component/location, asset and trust boundary, control/data flow, missing/bypassed control, exploit prerequisites, realistic impact/blast radius, confidence, severity rationale, and focused remediation direction. CWE may classify root cause; CVSS is optional and must not substitute for business priority.
5. **Separate static evidence from runtime proof.** Mark untested assumptions. Hand concrete exploit/allow-deny/isolation/regression checks to `security-verification`; never claim code inspection proved exploitability or a fix in the running system.

## Severity rationale

In the requested report, separate reachable findings from cleared leads. For each cleared lead, name the actual guard or absent prerequisite that defeats the proposed path; an alarming string or unsafe API name alone is insufficient. For each retained finding, provide a trace to a concrete location and a verification handoff containing an exploit case, permitted control and observable effect. Keep remediation suggestions separate from changes actually authorized and performed.

Severity follows the demonstrated path: attacker position/privilege, complexity/timing, interaction, confidentiality/integrity/availability impact, privilege or tenant boundary crossed, persistence, and affected scope. Reduce confidence when prerequisites are uncertain instead of inflating severity.

## Specialty boundaries

- `application-security`: application hardening/design. `authorization-security`: subject-resource-action/tenant/delegation/revocation policy. `security-verification`: executed proof. `threat-modeling-practice`: threat model creation/refresh. `infrastructure-security`/`cloud-security`: host, network, IAM, deployment, and control-plane assessment. Compose when needed but keep evidence and ownership separate.

Use [the maintained source map](references/sources.md) for version-sensitive guidance. Explicitly say when evidence is insufficient for a vulnerability claim.
