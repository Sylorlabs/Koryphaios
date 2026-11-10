# Device and simulation test patterns

Use these patterns when the task needs more detail than the portable `SKILL.md` should carry.

## Validity matrix

Create the matrix before execution and keep unknowns explicit.

| Property                        | Host/model          | Emulator              | HIL / device-in-loop              | Integrated physical | Claim requirement                                      |
| ------------------------------- | ------------------- | --------------------- | --------------------------------- | ------------------- | ------------------------------------------------------ |
| Algorithm/state machine         | modeled             | modeled               | real firmware/software            | real                | Define deterministic state/output oracle               |
| CPU/ISA/ABI                     | host substitute     | modeled or translated | real target CPU                   | real target CPU     | Use target evidence when ISA/runtime behavior matters  |
| Peripheral registers/interrupts | stubbed             | model-dependent       | often real                        | real                | Record exact injection point and modeled omissions     |
| Bus/protocol framing            | synthetic           | model-dependent       | real endpoint plus synthetic peer | real                | Preserve byte/frame traces and timing tolerance        |
| Sensor noise/latency/dropout    | synthesized         | synthesized           | synthesized at chosen boundary    | real                | Do not call synthesized sensor behavior physical proof |
| Actuator/mechanics              | abstract            | usually absent        | simulated or isolated             | real                | Physical dynamics require physical evidence            |
| Power/brownout/reset            | usually absent      | model-dependent       | partially real                    | real                | State which reset/power path actually executed         |
| Thermal/RF/EMI                  | absent              | absent                | absent or highly abstract         | real                | Require dedicated physical/environmental procedure     |
| GPU driver/device memory        | mock/CPU substitute | model-dependent       | real when using target device     | real                | Pin device, driver, runtime, queue/sync behavior       |

`modeled`, `approximated`, `passthrough/real`, and `not represented` are more useful labels than a single fidelity score.

## Run manifest

Capture enough identity to reproduce a surprising result:

- test/scenario ID and oracle version;
- source revision and firmware/image hash;
- board/device model, revision, serial/slot when relevant;
- simulator/emulator name, version, platform description/model checksum;
- host OS/toolchain/driver/runtime versions;
- fixture wiring, transport, power mode, calibration, and safety interlock state;
- random seed, virtual/real time mode, input/replay trace hash;
- exact test command or harness configuration;
- raw output/report/trace artifact locations.

## Fault matrix

Choose only faults reachable and safe at the test boundary.

| Fault                     | Observable oracle                            | Recovery oracle                                            |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Silence/dropout           | timeout/degraded state within declared bound | valid data accepted only after declared recovery condition |
| Corrupt/malformed frame   | frame rejected; no invalid state committed   | next valid frame/sequence handled according to contract    |
| Out-of-range/stuck sensor | value rejected/clamped/failsafe as specified | normal state restored only under declared policy           |
| Delay/loss/reorder        | sequencing/timeout behavior matches contract | no duplicate or stale state survives recovery              |
| Disconnect/reconnect      | connection loss is observable and safe       | re-enumeration/rebind restores declared capability         |
| Reset/watchdog            | expected reset cause/boot path is visible    | state restoration and persistent-data contract hold        |
| Resource saturation       | bounded degradation or explicit failure      | cleanup returns system to known state                      |

Always include a clean baseline and a post-fault recovery case. If the fault can move hardware, energize an actuator, reset a shared device, or cause thermal/power stress, establish authorization and safety controls before injection.

## Cross-level comparison

For a scenario executed at multiple evidence levels:

1. Use the same logical input trace and oracle where the systems expose comparable observables.
2. Record level-specific setup separately; do not pretend virtual time and wall clock time are equivalent.
3. Compare state transitions, ordering, accepted/rejected inputs, and timing only within declared tolerances.
4. Classify each mismatch as `implementation`, `model`, `fixture`, `calibration`, `timing`, or `unresolved` only when evidence supports the label.
5. Preserve unresolved divergence as a failed/blocked qualification result.

## HIL/HITL safety gate

Before connecting a simulator to a real controller, prove the physical boundary is safe:

- actuators/props/motors are isolated, disabled, or mechanically constrained unless motion is explicitly in scope;
- power/current limits and emergency stop/abort path are known;
- the controller is in the intended HIL/device-test mode, and the mode is visible in logs/telemetry;
- simulator and real-device transport are pinned and can be reset to a known state;
- failure injection cannot escape into an unintended real environment.

Record this preflight as evidence. A narrative claim that "the rig was safe" is weaker than an observable interlock/configuration check.
