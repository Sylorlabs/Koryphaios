---
name: simulation-device-testing
description: Test hardware dependent behavior using simulators, emulators, hardware in the loop, and physical devices. Use when validating firmware, robotics, GPU, or device claims, injecting device faults, or assessing simulation limits; never equate simulated evidence with physical proof.
---

# Simulation Device Testing

Treat the evidence level as part of the claim. A passing simulator run proves only the behavior represented by that simulator and test configuration. A passing physical-device run proves only the exercised device, firmware, fixture, environment, and operating range. Do not collapse either result into a universal hardware claim.

## 1. State the claim and system identity

Before choosing a harness, write the observable claim: state transition, protocol response, timing bound, control behavior, rendered result, recovery behavior, or other measurable outcome.

Record the identities that can change the result:

- device/board/GPU model and revision; serial or fixture slot when relevant;
- firmware, bitstream, kernel/driver, runtime, configuration, and build/image hash;
- simulator/emulator and model/platform description version;
- host/toolchain, transport, wiring, power mode, calibration, and attached peripherals;
- workload/input trace, random seed, virtual/real time mode, and test-harness version.

If the request omits a material identity, discover it or label the evidence conditional on the unknown.

## 2. Build a validity matrix, not a fidelity ranking

For each material property, classify the chosen environment as `modeled`, `approximated`, `passthrough/real`, or `not represented`. Useful rows include:

- instruction set, ABI, memory layout, and concurrency;
- peripheral registers, interrupts, timers, DMA, buses, and protocol framing;
- sensor range, rate, latency, noise, dropout, and calibration;
- actuator dynamics, saturation, backlash, and mechanical load;
- power, brownout, reset, watchdog, boot, thermal, RF/EMI, and clock behavior;
- GPU/accelerator device, driver, queueing, synchronization, memory pressure, and display coupling.

Do not assume `model < emulator < HIL < physical` is a universal ordering. HIL/HITL can replace sensors, buses, or commander paths and therefore bypass code or physics that another simulation mode exercises. Choose evidence by the property and injection point under test.

See [patterns.md](references/patterns.md) for the reusable matrix and evidence-level patterns.

## 3. Select the minimum sufficient evidence level

Use the cheapest level that can falsify the claim, then cross the physical boundary when the claim depends on it:

1. **Host/model simulation** for algorithms, state machines, deterministic traces, and broad fault-space exploration.
2. **ISA/peripheral emulator** when firmware image, CPU behavior, mapped peripherals, interrupts, or board-level software integration matter and the emulator models them.
3. **Device-in-loop / HIL / HITL** when real compute, drivers, buses, or control software must interact with simulated environment inputs.
4. **Integrated physical system** when analog/electrical behavior, real sensors/actuators, power, thermals, RF, mechanics, or complete physical coupling is material.

Cross-check important claims at more than one level when model error would change the decision. A simulator/device disagreement is evidence to investigate, not noise to average away.

## 4. Define the oracle before executing

For every case define:

- initial/reset state and how it is proven;
- exact stimulus or replay trace;
- expected observable state/output and tolerance;
- timeout or timing window where timing is part of the claim;
- failure classification for missing, late, malformed, or divergent output;
- safe state and recovery criteria after an injected fault.

Prefer machine-readable logs, traces, hardware maps, event ledgers, captures, and test reports over screenshots or narrative-only observations. Preserve raw artifacts when they are needed to reproduce a failure.

## 5. Exercise faults and recovery safely

Select faults reachable at the tested boundary: silence/dropout, stuck or out-of-range values, malformed/corrupt frames, latency/loss/reordering, disconnect/reconnect, reset/watchdog, resource pressure, or saturation. Inject one controlled fault at a time unless interaction effects are themselves the test target.

For energized hardware, establish the safety envelope before fault injection. Isolate or disable actuators when motion is not part of the claim, use bench limits, define abort/stop conditions, and do not expand authority from simulation into risky physical operation. On shared GPUs or lab devices, begin with non-disruptive checks and avoid resets, exclusive display changes, thermal stress, or destructive workloads unless explicitly authorized.

After the fault, verify the declared safe/degraded state and the complete recovery path. A test that proves failure detection but never proves recovery is incomplete when recovery is part of the contract.

## 6. Compare levels explicitly

When the same scenario runs in simulation and on a device, normalize only observables that are meant to be comparable. Report:

- properties represented at both levels;
- expected tolerances and why they are appropriate;
- any divergence in state, timing, ordering, fault handling, or recovery;
- properties unavailable at one level and therefore not proven there.

Do not silently tune the simulator until it matches the device. Preserve the pre-tuning divergence, calibration change, and post-tuning comparison so the result remains auditable.

## 7. Report bounded completion evidence

Every material claim should name its evidence class: `simulated`, `emulated`, `device-in-loop/HIL`, `representative physical`, or `integrated physical`. Include the exact system identity, scenario/oracle, fault and recovery result, raw artifact locations, and unresolved validity gaps.

Do not claim certification, environmental qualification, electrical compliance, real-world safety, or physical robustness from a bounded simulator/HIL test unless the governing procedure actually establishes it.

## Routing boundary

Use this skill for test design/execution where the simulation-to-device evidence boundary is material. Compose with `embedded-firmware`, `robotics-control`, `gpu-compute`, or `hardware-runtime-debugging` when those skills own implementation or diagnosis. Use `integration-fault-testing` when the main concern is software/service integration faults with no simulated or physical device boundary, and `performance-testing` when the main claim is a controlled performance budget rather than device fidelity.

Use [the maintained source map](references/sources.md) for version-sensitive simulator, HIL, board, and tooling facts.
