# Source map

`threat-modeling-practice` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources support a methodology-neutral, decision-oriented threat-model workflow; the actual architecture, identity model, data/control flows, and supplied operational evidence determine the concrete model.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: root responsibility.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OWASP Threat Modeling Project**: https://owasp.org/www-project-threat-modeling/
  - Scope: maintained project guidance as verified 2026-09-05.
  - Use: methodology-neutral four-question framework, current practice references, model maintenance, and the explicit position that OWASP does not mandate one threat-modeling methodology.
  - Verified: 2026-09-05; refresh after 90 days.
- **OWASP Threat Modeling Cheat Sheet**: https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
  - Scope: current OWASP Cheat Sheet Series content as verified 2026-09-05.
  - Use: practical system modeling, threat identification/ranking, response/mitigation, review/validation, and maintenance. STRIDE is an example technique rather than the required output shape.
  - Verified: 2026-09-05; refresh after 90 days.
- **NIST SP 800-218: SSDF Version 1.1**: https://csrc.nist.gov/pubs/sp/800/218/final
  - Scope: Version 1.1 final from February 2022. NIST lists SP 800-218 Rev. 1 / SSDF Version 1.2 as draft, not final, as verified 2026-09-05.
  - Use: secure-development lifecycle context and risk-based software security practices. It does not replace system-specific threat modeling or dictate one modeling method.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Start from the concrete system and decisions, then use a technique such as STRIDE or attack trees to improve coverage; never substitute the technique's categories for a system model.
- Threat scenarios should state attacker prerequisites, path, affected asset/outcome, and existing control/assumption so they can be prioritized and verified.
- A named mitigation is not proof. Record the enforcing component and hand executable checks to the relevant implementation/verification skill.
- Maintain the model when architecture, identities, trust boundaries, dependencies, privileged tools/actions, or consequences change; agentic authority can change even when diagrams do not.
- Preserve residual risk and explicit assumptions instead of converting uncertainty into invented controls or fake numeric precision.
