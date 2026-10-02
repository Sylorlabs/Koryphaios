---
name: threat-modeling-practice
description: Model threats from assets, trust boundaries, attacker capabilities, abuse paths, and enforcing controls. Use when threat modeling, security design analysis, or a threat model refresh is requested; use security-review to find implementation defects and security-verification to test mitigations.
---

# Threat Modeling Practice

Use a model to make security decisions, not to produce a diagram or acronym inventory. The core questions are: what are we working on, what can go wrong, what will we do about it, and how will we know whether the result is good enough.

## Threat-modeling workflow

1. **Set scope and security objectives.** Name the feature/system boundary, protected assets and outcomes, non-goals, deployment assumptions, and the decisions the model must support. Record unknowns rather than silently treating them as trusted.
2. **Model the system as it actually operates.** Identify actors, service identities, user/device identities, data and control flows, entry points, privileged operations, stores, queues, schedulers, third-party dependencies, administration/recovery paths, and trust boundaries. Include asynchronous and out-of-band paths that a simple request diagram misses.
3. **Define attacker capabilities and starting positions.** Separate unauthenticated remote access, ordinary user access, compromised tenant/user/device, malicious dependency/plugin, insider/operator access, temporary physical access, and compromised upstream/downstream systems. Threats must state prerequisites rather than assuming an omnipotent attacker.
4. **Generate concrete abuse cases.** Use STRIDE, attack trees, LINDDUN, ATT&CK, incident history, or domain-specific prompts when useful, but anchor each scenario in the actual model. Describe attacker goal, starting capability, path across trust/privilege boundaries, affected asset, impact, and existing control/assumption.
5. **Prioritize for decisions.** Rank or group threats using evidence about reachability, prerequisites, impact, exposure, and control strength. Avoid fake precision when likelihood data is weak. Distinguish accepted residual risk, transferred/external risk, blocked threats, and threats requiring design work.
6. **Map mitigations to enforcing components.** For each material threat, identify the component that must enforce the control, the security invariant, failure behavior, dependency/assumption, and owner. UI copy, prompts, documentation, or policy statements do not count as enforcement unless the actual system constrains the action.
7. **Turn the model into verification priorities.** Define negative and abuse-path cases that can prove the highest-value mitigations: identity/tenant swaps, revoked credentials, replay, malformed transitions, lost dependencies, privilege boundary crossings, denied side effects, recovery/rollback, and other domain-specific cases. Keep planned verification separate from executed proof.
8. **Maintain the model.** Refresh after meaningful changes to architecture, data flows, identities/roles, external dependencies, trust boundaries, deployment assumptions, privileged tools/actions, or real-world consequences. Incident findings should update assumptions and threat coverage.

## Required output quality

Produce a system/trust-boundary representation, assumptions and attacker-capability record, prioritized abuse-case register, mitigation-to-enforcement map, residual-risk decisions, and verification handoff. Every high-priority threat should be traceable to concrete system elements and a disposition. State which facts came from architecture evidence versus inference.

## Boundaries

- `security-review` inspects implemented source/configuration for reachable weaknesses and owns finding severity/confidence. Threat modeling may focus that review but should not invent findings without implementation evidence.
- `security-verification` executes tests and proves controls. Threat modeling specifies what should be verified and why; do not claim a mitigation works merely because the model names it.
- `application-security`, `authorization-security`, `secure-authentication`, `cloud-security`, `embedded-device-security`, and other specialist skills own detailed control design inside their domains. Threat modeling owns cross-system attack paths, assumptions, priorities, and handoffs.
- Avoid diagram-only output, generic STRIDE lists detached from the system, exhaustive theoretical threat catalogs without prioritization, and mitigation claims with no enforcing component.

Use [the maintained source map](references/sources.md) for OWASP's maintained methodology-neutral threat-model guidance and current NIST SSDF status.
