---
name: hardware-runtime-debugging
description: Localize device, firmware, driver, and GPU failures using hardware identity and minimally disruptive evidence. Use when physical-device behavior affects a crash, hang, or corrupt state; use simulation-device-testing for simulator fidelity and concurrency-debugging for software races independent of hardware.
---

# Hardware Runtime Debugging

Debug the observed failure without collapsing the stack into “hardware.” Record the exact board/device/GPU, revision, firmware or image hash, host OS/kernel, driver, runtime/API, debugger/probe, topology, clocks/power mode, workload, and whether a debugger or simulator changes timing or reset behavior.

## Evidence ladder

1. **Preserve the failure artifact first.** Capture crash/fault registers, exception frame, device/driver logs, Xid or equivalent vendor diagnostics, core/minidump, trace/capture, workload input, and reset reason before power-cycling or flashing. Mark missing evidence rather than recreating it from memory.
2. **Partition the stack.** Form separate hypotheses for application/firmware, runtime/API misuse, driver, transport/interconnect, power/clock/thermal conditions, and the physical device. Prefer an observation that can discriminate two layers over broad speculative changes.
3. **Reproduce with identity held fixed.** Keep the failing workload, build, hardware revision, driver/runtime, and configuration stable. Change one meaningful variable at a time and record whether the failure signature is the same, rather than merely observing another crash.
4. **Use architecture-specific fault state.** On Cortex-M, decode the exception stack and fault status/address registers before guessing at the crashing instruction. On GPU APIs, enable the platform's development validation/diagnostic layers and preserve driver/device-loss evidence. Treat vendor error codes as starting points, not root-cause proof.
When the artifact is a captured exception record, report the recorded register values verbatim before interpreting them: the fault status word and its individual status bits, which fault-address registers are valid for that class, and the stacked frame entries the core wrote. Resolve the stacked PC and LR against the exact image's symbol table, naming the function that contained the faulting instruction and the function that called it; do not name a symbol from a different build. State whether the fault is precise or imprecise and what that implies about whether the recorded instruction caused the fault or merely surfaced a pending access. Then name one cause, phrased as something in the configuration or code that can be changed, and prove the repair by building the changed source and running it on the same target until the original failure path completes. A record that was captured on one image cannot be explained by a patched image's symbols, and a repair that was never executed is a hypothesis, not a fix.

5. **Instrument narrowly.** Use breakpoints/watchpoints, trace, sanitizer/validation features, debug markers, or hardware trace where they can identify the first corrupting access or invalid command. Account for perturbation: software watchpoints, halting debug, instrumentation, and GPU validation can change timing/performance.
6. **Prove the layer.** A fix is supported when the same failing stimulus no longer produces the original signature and a targeted negative/perturbation test would still fail if the suspected layer were wrong. Re-run on the real target when the claim depends on physical timing, power, sensor/actuator behavior, or a production driver.

## Safety and recovery

- Put actuators, motors, high-current outputs, and externally dangerous devices into the documented safe state before halting, single-stepping, resetting, or forcing faults. Never bypass hardware interlocks to obtain a reproduction.
- Do not flash firmware, change fuses, overclock, alter power limits, or run destructive stress/fault injection unless the task explicitly authorizes that mutation and the recovery path is known.
- Preserve a known-good image/configuration and capture recovery evidence after any authorized device mutation.

## Boundaries

- `debugging` owns the general hypothesis/evidence loop; this skill specializes the device/runtime/driver stack and physical proof boundary.
- `simulation-device-testing` owns claims about simulator/emulator/HIL/physical fidelity and validation. Simulation can narrow hypotheses but cannot establish a physical-device fix by itself.
- `concurrency-debugging` owns thread/task/race causality when the failure reproduces independently of hardware-specific behavior.
- `performance-debugging` owns causal diagnosis of latency/throughput/resource regressions rather than crashes/hangs/corruption.
- `embedded-firmware`, `gpu-compute`, or other implementation skills own the eventual code change once evidence localizes the defect.

Use [the maintained source map](references/sources.md) for debugger behavior, Cortex-M postmortem patterns, Vulkan device-loss/validation semantics, and vendor diagnostic interpretation.
