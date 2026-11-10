---
name: growth-engineering
description: Engineer product growth loops with trustworthy acquisition, activation, retention, referral, experimentation, instrumentation, and guardrails. Use when the request specifically requires growth engineering, activation funnel, growth loop, referral system.
---

# Growth Engineering

## Responsibility

Map the growth mechanism from source through activation and retained value, including identity, attribution, incentives, abuse, instrumentation, and downstream quality. Prefer compounding product loops over isolated conversion tricks and protect user trust, deliverability, and marketplace quality.

Verification focus: Instrument full funnels with valid denominators, run controlled experiments where appropriate, monitor retention/quality/abuse guardrails, and reconcile attribution or referral credit to authoritative events.

Failure boundaries: Do not optimize signup conversion while degrading retained value, create incentives without fraud modeling, dark-pattern consent, or claim channel causality from last-touch attribution alone.

## Hierarchy and routing

- Broader skills: product-analytics.
- No narrower bundled child is declared.
- Required skills: product-analytics.

## Build and test the mechanism

Identify the limiting step between a qualified arrival and repeated useful behavior. State what the intervention changes, why that should affect the next step, and which downstream harm could offset the gain. A referral loop needs a genuine recipient benefit, attribution rules, reward liability, consent, and defenses against self referrals or repeated claims.

Define eligibility, assignment, exposure, attribution window, and success before launching an experiment. Use stable identities and authoritative qualifying events. Reconcile duplicate, delayed, reversed, and fraudulent events before issuing credit. Do not let a client supplied success event create an unbounded reward or bypass account authority.

Treat sample ratio mismatch or inconsistent exposure as evidence of an experiment defect until investigated. Keep conversion, retained value, revenue quality, support burden, complaints, and abuse separate so an attractive aggregate cannot hide a worse product. Account for immature cohorts and changes in channel mix.

Ship only within the authorized product and audience. Record rollout limits, observation duration, rollback conditions, and whether the intervention actually changes retained value. Under a fixed task budget or sealed evidence, complete the minimum evidence contract before elaborating: state the decision and boundary; map the mechanism; name authoritative identity, events, and denominator; define guardrails and rollback; give one success plus one negative or recovery check; and label unavailable or unresolved evidence. Stop rather than inventing unavailable runtime results or adjacent statistical work. The parent owns valid measurement; this child owns the implementation and evaluation of a growth loop, not a mandate to use referrals or any particular growth tactic.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
