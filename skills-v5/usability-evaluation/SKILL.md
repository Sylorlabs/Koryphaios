---
name: usability-evaluation
description: Evaluate whether representative people can understand, complete, recover from, and trust realistic tasks. Use when work requires usability testing, UX evaluation, cognitive walkthroughs, heuristic reviews, task-based evaluation, or usability findings.
---

# Usability evaluation

Define the decision before choosing the method. Name the participant population or justified proxy, product/version, realistic goal-framed tasks, environment/medium, success and recovery signals, measures, and what result would change the plan. Use moderated tasks, unmoderated tasks, cognitive walkthroughs, heuristic inspection, or another method only when it can answer that decision with acceptable evidence.

When observing people, describe believable goals rather than teaching the intended interface path. Record completion, errors, hesitation/backtracking, recovery, assistance, comprehension, confidence, and trust. Preserve the observation layer before interpretation: distinguish what happened, the hypothesized cause, the implication, and the proposed change. Keep contradictory cases rather than averaging them away.

Scope every claim to the actual people, tasks, product state, environment, and method. A small convenience sample can reveal mechanisms and concrete breakdowns; it does not establish population prevalence or statistical effect size. Expert walkthroughs/heuristics can identify plausible problems and generate hypotheses, but label them as expert evidence rather than participant behavior.

Prioritize findings by consequence to the task: harm, irreversibility, task criticality, frequency within the observed evidence, assistance/workaround, and confidence. Tie each recommendation to the observed breakdown it is intended to address. Retest consequential changes under comparable tasks and conditions; a changed interface is not proof that the original usability problem is solved.

For bounded evaluation exercises that ask for a pure function or structured result, implement the stated observable contract exactly before adding richer study detail. Preserve required task names and ordering, participant slices, severity labels, input field meanings, and decision rules as written; return the requested fields without extra wrappers that change the result shape. Derive output fields from the input field named by the contract rather than guessing the input key from the output name: when `participantSlices` is defined from input `profiles`, read `profiles`. Likewise, when the input supplies task coverage under `scenarios`, use `scenarios` as the stated coverage source even when the output calls the canonical list `requiredTasks`. Keep synthetic plan logic separate from observed findings, and never convert missing participant evidence into findings.

Use `user-research` for broader unmet-needs/context questions and quantitative/statistical practice when the claim requires prevalence or causal inference.

[Sources](references/sources.md).
