---
name: developer-experience
description: Design and evaluate the end-to-end experience of developers using APIs, SDKs, languages, tools, configuration, diagnostics, and technical workflows. Use when the task concerns developer experience, SDK or API usability, tooling UX, developer onboarding, integration friction, or a developer journey across multiple technical surfaces.
---

# Developer experience

Start from the developer's actual job, environment, constraints, and failure cost. Treat installation, authentication, configuration, APIs or commands, documentation, examples, diagnostics, observability, upgrade, rollback, and removal as one journey when they are part of the same task. Route contract-, medium-, wording-, documentation-, or test-specific depth to the narrower specialist rather than duplicating it here.

Reduce unnecessary cognitive load, shorten trustworthy feedback loops, and protect focused work without hiding state the developer needs. Make concepts, lifecycle, ownership, side effects, permissions, limits, version assumptions, and uncertain outcomes explicit. Prefer predictable conventions, inspectability, reversible defaults, and deliberate escape hatches over magic or brevity.

Validate first success, repeat use, failure diagnosis and recovery, answer-finding, compatibility and migration, rollback, and removal in a faithful environment. Evaluate first use and repeat or failure use with multiple signals: developer-reported friction or confidence, task completion or recovery behavior, and relevant system evidence. Combine developer feedback with task and system evidence; do not use one activity metric, fewer lines of code, or a fast demo as proof of good developer experience.

Make the measurement plan concrete. Include a first-use row and a repeat-use or failure-recovery row, and for each row name a developer signal, a task or recovery outcome, a system signal, and the decision the combined evidence can change. A general statement that several signals matter is not a measurement plan.

In the deliverable, label these rows explicitly `First use` and `Repeat use or failure recovery`, and name the three signal classes `developer feedback`, `task outcome`, and `system signal`. Include at least one concrete measure and one decision for each row.

[Sources](references/sources.md).
