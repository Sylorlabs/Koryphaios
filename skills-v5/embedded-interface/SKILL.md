---
name: embedded-interface
description: Design embedded, appliance, industrial, and constrained-device interfaces around safety, environment, physical controls, and resource limits. Use when the request specifically requires embedded ui, device interface, appliance display, industrial panel.
---

# Embedded Interface

## Responsibility

Start from the physical system, operating environment, user expertise, frequency and urgency of use, gloves or mobility constraints, lighting, noise, viewing distance, physical controls, failure consequences, connectivity, power, memory, display, and update limitations. Separate normal operation, degraded operation, maintenance, calibration, emergency, and safe-state behavior.

Match information density and control placement to task priority. Make system mode unmistakable, prevent dangerous action through constraints and confirmation proportional to risk, preserve critical operation without network service, and provide diagnostics that technicians can act on. Coordinate screen behavior with physical affordances, indicators, alarms, and haptics; never rely on color, touch, or connectivity alone for critical meaning.

For embedded anti-slop, reject decorative dashboards, ambiguous modes, ornamental animation, and density that hides safety or maintenance information. The display must reinforce physical controls, safe state, urgency, and environmental constraints rather than imitate a web product. Verify on representative hardware or a faithful simulator, including boot, power loss, brownout, sensor failure, stale data, communication loss, extreme values, long-duration operation, physical-control conflict, and recovery. Do not assume browser resources, pointer input, abundant memory, or continuously deployable software.

## Hierarchy and routing

- Broader skills: visual-interface-design, frontend-engineering.
- No narrower bundled child is declared.
- Cross-cutting facets: interaction-design, content-error-design, accessibility-practice.

## Professional practice

### Operating contract

Design constrained-device and industrial interaction around physical systems, safe states, and environment.

### Execution sequence

1. Map operator expertise, physical process, hazards, controls, environment, connectivity, and resource limits.
2. Separate boot, normal, degraded, maintenance, calibration, emergency, and recovery states.
3. Coordinate screen, physical control, indicator, alarm, and haptic meaning.
4. Implement prevention and confirmation proportional to consequence.
5. Verify hardware or faithful simulation through power, sensor, communication, and extreme-value failures.

### Decisions that must be explicit

- Which information is safety-critical and continuously visible.
- Touch, button, dial, remote, or automatic control authority.
- Network-independent behavior and stale-data policy.
- Whether a simulator represents the physical property under claim.

### Failure and recovery discipline

- Ambiguous modes or stale readings cause unsafe action.
- A decorative dashboard hides urgent state.
- Screen and physical control disagree.
- Power loss or sensor failure leaves no safe recovery.

### Evidence required before completion

- Human-device safety contract.
- Mode and alarm matrix.
- Hardware/simulation identity and validity boundary.
- Power, fault, safe-state, and recovery results.

### Anti-misinterpretation boundaries

- Never assume abundant memory, connectivity, or pointer input.
- Do not rely on color or touch alone for critical meaning.
- Do not equate simulation with physical proof.
- Do not optimize aesthetics ahead of safe operation.

## Completion evidence

- Human-device safety contract
- Hardware or faithful simulation evidence

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
