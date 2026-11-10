---
name: content-error-design
description: Design user-facing labels, instructions, status, errors, diagnostics, and recovery language that helps people understand and act. Use when a task requires content design, error messages, microcopy, status text, diagnostic wording, or recovery copy.
---

# Content and error design

Write for the reader's decision and next useful action, not for internal implementation vocabulary. Establish the audience, task, actual system state, urgency, impact, vocabulary, and what action is genuinely available. Say only what the system can support. Preserve uncertainty when commit, sync, permission, recovery, or remote state is unknown; never turn an inference into a confident diagnostic claim.

Design the relevant language as a state family: orientation, instructions, empty states, progress, partial completion, cancellation, warnings, permissions, unavailable/offline/degraded states, validation, failure, recovery, and success should use consistent terms and never contradict one another. Empty results are not failed loads. For a user-correctable error, identify the affected item using its visible label or useful source location and give a concrete correction when known and safe to disclose. Do not blame a person for service failure, capacity, policy, permissions, or an unknown root cause.

Bind copy to supplied state/category IDs, authoritative triggers, impact/uncertainty, exact text, safe dynamic fields, and available action labels/effects. Missing facts stay unresolved. Distinguish automatic recovery from reader action; offer recovery, support, timing or retention/loss claims only when supported. Explain when no fix exists. For partial completion, name affected items. Local save is not remote sync; requested cancellation is not confirmed cancellation.

Preserve diagnostic identifiers/context when they materially help support or debugging, but never expose secrets, tokens, private data, exploit detail, or unsupported internals. Avoid vague codes, cute distress language, false reassurance, all-caps urgency, or a bare “try again.” Retry language is valid only when retry is safe/reasonable and the message still explains what happened.

Review wording in the actual surface, including localization expansion, constrained layouts, assistive output, interruption, and long running operations. Verify comprehension and actionability with representative evidence when the wording is consequential; grammar approval is not usability evidence.

Check success, failure and failed/unavailable recovery against state facts. Record trigger, expected understanding/action, method, actual result and evidence. Mark proposed reader/assistive checks unexecuted.

Preserve any supplied artifact schema, field names, and machine format exactly. Complete the smallest required parseable artifact before adding optional rewrite examples or secondary explanation. If output space is constrained, keep required evidence and valid syntax first.

Preserve evidence ownership. A comparison or report that the evaluation harness owns is always recorded as external, never as unavailable, because its absence from your bundle is not the same as the evidence not existing. Mark other evidence you could not obtain as unavailable with the reason. Never label evidence you did not produce as produced.

Keep behavior/state transitions with `interaction-design`, organization with `information-architecture`, styling with `visual-interface-design`, formal accessibility conformance with accessibility specialists, and implementation error handling with engineering.

[Sources](references/sources.md).
