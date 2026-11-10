# Source map

## Applied curation, 2026-09-06

[REP 103](https://reps.openrobotics.org/rep-0103/) (updated 2026-01-30) and [REP 105](https://reps.openrobotics.org/rep-0105/) (updated 2025-10-18) were inspected on the current Open Robotics site. Adopt explicit units, coordinate conventions, transform ownership, and the distinction between continuous local odometry and potentially discontinuous global localization. Preserve justified documented exceptions rather than mandating ROS for all control systems. Refresh within 180 days. Frame documentation and simulation do not constitute physical safety certification or permission to actuate hardware.

`robotics-control` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **ROS 2 documentation source**: https://raw.githubusercontent.com/ros2/ros2_documentation/rolling/source/index.rst
  - Scope: ROS 2 Rolling documentation source as available 2026-10-19
  - Use: Robotics nodes, messages, QoS, coordinate frames, lifecycle, and tooling reference.
  - Verified: 2026-10-19; refresh after 45 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
