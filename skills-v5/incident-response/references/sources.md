# Source map

`incident-response` owns command and coordination of an active technical incident through verified operational recovery and handoff. It does not replace the subsystem specialist, postmortem analysis, observability design, or planned reliability qualification. Formal V5 promotion still requires paired same-model skill/no-skill evidence and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader reliability-verification.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
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
  - Use: current cybersecurity-incident preparation, detection, response, recovery, and improvement guidance when the incident has a security dimension. Do not apply security-forensic assumptions to every ordinary service outage.
  - Verified: 2026-09-05; refresh after 365 days.
- **PagerDuty public incident-response roles**: https://response.pagerduty.com/before/different_roles/
  - Scope: practitioner guidance available 2026-09-05.
  - Type: community pattern, not a normative standard.
  - Use: IC decision ownership, scribe/timeline separation, SME/operations execution, and scaling roles to incident size.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Roles scale with incident size; preserve the single command function even if one person temporarily holds multiple roles.
- Keep observation, hypothesis, decision, and action distinct in the timeline. A plausible recent deployment is a hypothesis until evidence discriminates it.
- Prefer reversible impact-reducing mitigation over exploratory production mutation. One mutation should have one owner and an explicit intended observation.
- Resolution requires user-impact recovery plus relevant state/dependency/backlog evidence through an appropriate observation window.
- For security/privacy incidents, compose security response requirements and protect forensic evidence; operational restoration must not erase legally or technically significant evidence.
