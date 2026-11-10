# Source map

`incident-response` owns command and coordination of an active technical incident through verified operational recovery and handoff. It does not replace subsystem specialists, retrospective analysis, observability design, or planned reliability qualification. Formal V5 promotion still requires paired tasks on the same model, with and without the skill, and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader reliability-verification.
- Routing: five positive, five negative cases about neighboring skills, three compound or ambiguous, and three adversarial withheld cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, pairing on the same model with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Incident Management Guide**: https://sre.google/resources/practices-and-processes/incident-management-guide/
  - Scope: guidance available 2026-09-05.
  - Use: preparation, the coordinate/communicate/control model, and clear Incident Commander, Communications Lead, and Operations Lead responsibilities.
  - Verified: 2026-09-05; refresh after 180 days.
- **Google SRE Workbook: Incident Response**: https://sre.google/workbook/incident-response/
  - Scope: workbook chapter available 2026-09-05.
  - Use: clear command, defined roles, working record, early incident declaration, mitigation versus incident management, and scalable response structure.
  - Verified: 2026-09-05; refresh after 365 days.
- **NIST SP 800-61 Rev. 3**: https://csrc.nist.gov/pubs/sp/800/61/r3/final
  - Scope: final April 2025; supersedes SP 800-61 Rev. 2.
  - Use: current guidance for preparation, detection, response, recovery, and improvement when an incident has a security dimension. Do not apply forensic requirements to every ordinary outage.
  - Verified: 2026-09-05; refresh after 365 days.
- **PagerDuty public incident-response roles**: https://response.pagerduty.com/before/different_roles/
  - Scope: practitioner guidance available 2026-09-05.
  - Type: community pattern, not a normative standard.
  - Use: IC decision ownership, scribe/timeline separation, SME/operations execution, and scaling roles to incident size.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Roles scale with incident size; preserve the single command function even if one person temporarily holds multiple roles.
- Keep observation, hypothesis, decision, and action distinct in the timeline. A plausible recent deployment is a hypothesis until evidence discriminates it.
- Prefer reversible mitigation that reduces impact over exploratory production changes. One mutation should have one owner and an explicit intended observation.
- Resolution requires user recovery plus relevant state, dependency, and backlog evidence through an appropriate observation window.
- For security or privacy incidents, compose the relevant response requirements and protect forensic evidence. Operational restoration must not erase legally or technically significant evidence.
