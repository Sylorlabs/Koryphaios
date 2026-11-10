---
name: interaction-design
description: Design behavior. Use when a task needs interaction design, task flow, state transitions, undo, or recovery.
---

# Interaction design

Design the behavior before the visual treatment. Start with the person's goal, current state, available actions, system constraints, and consequences. Model each consequential interaction as an explicit contract: preconditions → action → immediate feedback → processing/partial state → completion or failure → cancellation/undo/recovery. Add a state only when it changes what the person can understand or do.

For each flow, cover the relevant initial, empty, loading/progress, partial, invalid, blocked, success, failure, interrupted, offline/reconnecting, restored, and irreversible states. Preserve predictability: the same action under the same visible conditions should not produce surprising outcomes. Preserve controllability: expose cancellation, reversal, confirmation, or a safe recovery path in proportion to consequence and reversibility. Never invent an undo path for an irreversible operation; make the consequence clear before commitment instead.

For cross role flows, follow the behavior through each handoff until the intended human outcome is reached. Submission, delivery, or an intermediate status is terminal only when it is the actual outcome. Make state, ownership, permissions, failure, and recovery explicit for recipients when they affect completion.

For AI, predictive, or generated interactions, model uncertainty and human control as part of the interaction contract: what the system proposes or generates, what evidence or provenance is visible, what the person can inspect, edit, reject, or confirm, and which action causes side effects. Treat confidence, explanations, citations, and user feedback as interface signals rather than proof that an output is correct.

Treat keyboard, pointer, touch, voice, controller, and assistive input conventions as medium specific evidence rather than universal rules. Keep the behavioral contract independent from control placement or styling so the appropriate interface skill can implement it faithfully.

Verify the transition model rather than only the happy path screen. Walk representative success, error, cancellation, retry, interruption, and recovery paths and check that feedback reflects actual system state. If the implementation cannot distinguish states the design depends on, surface that as an engineering contract gap rather than papering it over in copy.

Respect established product behavior and control conventions unless the task or evidence establishes a reason to change them. Do not redesign adjacent flows, add confirmation steps, or introduce new interaction states merely to make the solution look more comprehensive. Keep every added state tied to a user decision, system fact, or recovery need.

Keep organization/findability with `information-architecture`, visual hierarchy with `visual-interface-design`, language with `content-error-design`, accessibility requirements with `accessibility-practice`, and observed task performance with `usability-evaluation`.

[Sources](references/sources.md).
