# Source map

Source curation for `embedded-firmware`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **FreeRTOS task notifications from interrupts**: https://freertos.org/Documentation/02-Kernel/02-Kernel-features/03-Direct-to-task-notifications/04-As-event-group
  - Adopted: when FreeRTOS is the target, use ISR-safe notification APIs to hand bounded interrupt work to task context instead of invoking task-only behavior from an ISR.
  - Conditional: this guidance applies only to FreeRTOS and only where task-notification semantics match the required handoff.
  - Limit: it does not define MCU-specific interrupt latency, DMA coherence, peripheral ordering, or electrical behavior.
- **FreeRTOS documentation overview**: https://www.freertos.org/Documentation/00-Overview
  - Preserved use: discover the exact kernel API and version specific scheduling or synchronization reference for a FreeRTOS target.
  - Limit: the overview alone is not evidence for a particular API's ISR safety or timing guarantee.

For clocks, registers, DMA, cache, power, reset causes, errata, and electrical timing, the exact MCU, peripheral, board revision, and vendor documentation are required. Simulator or RTOS documentation cannot establish those hardware facts.
