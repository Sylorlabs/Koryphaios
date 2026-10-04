# Source map

`ISO 9241-110:2020` is the primary `interaction-design` authority because its principles are explicitly independent of technology, application, and environment. Platform guidance is evidence for platform conventions rather than a universal interaction rule. Community skills are workflow pattern references only.

## Maintained interpretation

- Model the task and system behavior before choosing control placement or visual treatment.
- For each consequential action, make entry/preconditions, system response, feedback, completion, failure, cancellation, and recovery explicit. Consider initial, processing, partial, empty, invalid, blocked, success, failure, cancellation, undo, reconnection, and restoration states, but add only states that change what the person can understand or do.
- Favor task suitability, self descriptiveness, predictability, learnability, controllability, and use error robustness according to context and risk rather than treating any single principle as absolute.
- Predictability and controllability depend on context and established conventions. Do not invent a universal gesture, keyboard, pointer, voice, or touch model. Route medium specific conventions to the relevant interface skill.
- Reversibility is especially valuable for exploration and recovery, but not every operation can be undone. When reversal is impossible, make consequences and the safe recovery path clear before commitment.
- Interaction design owns behavior and transition contracts. Information organization, visual styling, copy, accessibility conformance, and implementation remain distinct specialist responsibilities even when they contribute to the same interaction.

## Community pattern review

The MIT licensed `product-design-and-ux` skill usefully treats task flows, state and recovery models, and interface contracts as observable behavior rather than pixels or framework code. Since the prior inspection, upstream added explicit guidance to follow multi-role work through recipient-side outcomes and to make uncertainty, human control, and feedback part of AI interaction contracts without treating model outputs or confidence signals as correctness evidence. Kory incorporates those interaction-contract patterns while retaining its own narrower skill boundaries and verification gates.

## Verification record

- `ISO 9241-110:2020`: official ISO page verified 2026-09-04. ISO lists edition 2 as current and confirmed in 2025. Recheck within 180 days or after a revision.
- Apple HIG Undo and redo: verified 2026-09-04; recheck within 90 days. Apply only where Apple platform conventions are relevant.
- Magnus919 `product-design-and-ux`: GitHub `main` at `aebc684075f5` inspected 2026-10-03; skill frontmatter declares MIT. The 2026-09-14 source update added multi-role handoff and AI-interaction guidance. Recheck within 30 days.
