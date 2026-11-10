# Source map

`interface-usability-testing` owns evidence from concrete interface tasks. Human usability claims require representative observation; automated interaction runs prove mechanics and state transitions only. Formal V5 promotion still requires paired same-model skill/no skill runs plus independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader testing-engineering, usability-evaluation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GOV.UK Service Manual: Using moderated usability testing**: https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing
  - Scope: guidance available 2026-09-05.
  - Use: actual/likely participants, believable goal-oriented tasks, neutral instructions, observation discipline, recovery, recording, dummy-data caveats, and assistive-technology setups.
  - Verified: 2026-09-05; refresh after 180 days.
- **GOV.UK Service Manual: Usability benchmarking a website or whole service**: https://www.gov.uk/service-manual/measuring-success/usability-benchmarking-a-website-or-whole-service
  - Scope: guidance available 2026-09-05.
  - Use: stable representative tasks, clear correct/success outcomes, repeated measurement, and comparability over time.
  - Verified: 2026-09-05; refresh after 180 days.
- **W3C WAI: Selecting Web Accessibility Evaluation Tools**: https://www.w3.org/WAI/test-evaluate/tools/selecting/
  - Scope: WAI guidance available 2026-09-05.
  - Use: boundary rule that automated tools can identify potential accessibility issues but cannot determine accessibility by themselves; knowledgeable human judgment is required.
  - Verified: 2026-09-05; refresh after 180 days.
- **Nielsen Norman Group: Usability Testing 101**: https://www.nngroup.com/articles/usability-testing-101/
  - Scope: practitioner article last reviewed 2026-07-15.
  - Type: community pattern, not normative authority.
  - Use: realistic participants and tasks, facilitator observation, neutral follow-up, think-aloud, and avoiding accidental influence.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Match the evidence to the claim. A green automation trace can support task mechanics, not comprehension or ease-of-use claims.
- Avoid universal participant-count rules. Choose sampling and research method for the question; document the actual participant population and limitations.
- Keep task wording stable when comparing rounds, and do not include the UI control name or route when that would prime the participant.
- When accessibility, visual rendering, or business correctness becomes a material acceptance claim, compose the corresponding specialist instead of expanding this skill's verdict.
