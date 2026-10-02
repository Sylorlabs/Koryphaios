---
name: robotics-control
description: Engineer robotics systems around sensing, estimation, planning, control, timing, safety, calibration, simulation, and physical verification. Use when the request specifically requires robotics, robot control, motion planning, sensor fusion robot.
---

# Robotics Control

## Responsibility

Define physical plant, coordinate frames, sensors/actuators, rates/latencies, calibration, estimator state, planner constraints, controller limits, safety interlocks, and human/environment interaction. Separate perception uncertainty from control authority and keep commands bounded by physical limits.

Verification focus: Progress from deterministic simulation to hardware-in-loop and controlled physical tests, measuring tracking error, stability, timing, saturation, sensor dropout, emergency stop, localization loss, and recovery under safe bounds.

Failure boundaries: Do not tune controllers from one trajectory, bypass safety interlocks for testing, assume simulation friction/noise matches reality, or command hardware without validated units/frames.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Cross-cutting facets: embedded-device-security.
- Required skills: verification, simulation-device-testing.

## Control the physical boundary

Document the unit, coordinate frame, timestamp, uncertainty, and validity interval of each measurement and command. Transform once at an explicit interface rather than compensating with unexplained sign changes or rotations. Separate a locally continuous estimate from a global estimate that may jump after relocalization; a correction to the map must not silently become an unsafe actuator step.

Define who owns each transform, estimator update, plan, and actuator command. Bound speed, force, travel, acceleration, timing, and stale command behavior to the actual plant. Use verified interlocks, watchdogs, and an independent stop path where the hazard analysis requires them. A model's confidence is not permission to move hardware.

Test calibration errors, delayed or missing sensors, saturation, timing jitter, localization loss, and recovery. Start with simulation and controlled interfaces, then obtain hardware evidence only within authorized safe conditions. Record the gap between simulated noise or friction and measured behavior; do not transfer stability claims from one trajectory or environment to another without evidence.

Reuse ROS frame conventions when ROS is the target, documenting justified exceptions. Other platforms need equivalent explicit units, frame semantics, ownership, and safety limits, not mandatory ROS packages. The implementation parent and device testing requirement supply execution and evidence discipline; this skill owns sensing and control consequences.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
