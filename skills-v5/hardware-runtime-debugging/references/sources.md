# Source map

`hardware-runtime-debugging` localizes failures across application/firmware, runtime/API, driver, transport/platform, and physical-device layers. Simulator or debugger evidence must be labelled by the layer it actually observes. V5 promotion still requires paired same-model skill/no-skill evidence and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging, simulation-device-testing.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **GNU GDB: Set Watchpoints**: https://sourceware.org/gdb/current/onlinedocs/gdb.html/Set-Watchpoints.html
  - Scope: current GDB manual available 2026-09-05.
  - Use: hardware/software watchpoint behavior, observation precision, performance perturbation, and target limits.
  - Verified: 2026-09-05; refresh after 90 days.
- **Vulkan 1.4.351 ratified specification**: https://registry.khronos.org/vulkan/specs/latest-ratified/pdf/vkspec.pdf
  - Scope: Vulkan 1.4.351 available 2026-09-05.
  - Use: `VK_ERROR_DEVICE_LOST`, logical versus physical device loss, and recovery boundaries.
  - Verified: 2026-09-05; refresh after 90 days.
- **Khronos Vulkan Validation Overview**: https://github.khronos.org/Vulkan-Site/guide/latest/validation_overview.html
  - Scope: Vulkan documentation available 2026-09-05.
  - Use: valid-usage diagnostics, `VK_LAYER_KHRONOS_validation`, synchronization/GPU-assisted validation, and development-only overhead.
  - Verified: 2026-09-05; refresh after 90 days.
- **NVIDIA Xid Errors: Introduction**: https://docs.nvidia.com/deploy/xid-errors/introduction.html
  - Scope: NVIDIA documentation available 2026-09-05.
  - Use: vendor GPU diagnostics and the explicit warning that Xids can originate from application, software/driver, or hardware problems and are investigation starting points.
  - Verified: 2026-09-05; refresh after 90 days.
- **Memfault Interrupt: Cortex-M HardFault debugging**: https://interrupt.memfault.com/blog/cortex-m-hardfault-debug
  - Scope: practitioner guide available 2026-09-05.
  - Type: community pattern, not normative architecture specification.
  - Use: exception-frame recovery, CFSR/HFSR/MMFAR/BFAR interpretation, imprecise-fault caveats, and postmortem workflow.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Use the target MCU/GPU/device's own architecture and vendor reference manual when its register meanings or recovery behavior differ; the generic sources above do not replace device-specific documentation.
- Preserve raw diagnostic evidence before translating it into a cause. Vendor codes and API errors are symptoms unless a discriminating experiment ties them to a layer.
- State whether evidence came from a simulator, debugger-attached target, or autonomous physical run. Halting/debug instrumentation can change timing, power, watchdog, and reset behavior.
- Never claim a physical-device repair from emulation alone, and never bypass documented safety interlocks for a reproduction.
