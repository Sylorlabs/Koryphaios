---
name: embedded-firmware
description: Engineer embedded firmware around hardware contracts, interrupts, timing, memory, power, buses, boot, update, safety, and observability. Use when the request specifically requires embedded firmware, microcontroller, rtos firmware, device firmware; prefer a narrower child only when its boundary is established.
---

# Embedded Firmware

## Boundary

Resolve MCU and board revision, clocks, memory map, peripherals, electrical assumptions, RTOS or bare-metal model, ISR and task ownership, watchdog, power states, boot and update path, and safety constraints. Hardware revision and vendor reference material outrank generic firmware patterns for register, timing, DMA, cache, and electrical behavior.

## Hierarchy and routing

- Broader skills: compiler-runtime-backend.
- No narrower bundled child is declared.
- Cross-cutting facets: embedded-device-security.
- Required skills: verification, simulation-device-testing.

Compose `embedded-device-security` when boot trust, update authenticity, debug access, secret storage, radio or network exposure, or device identity changes. FreeRTOS-specific guidance applies only when the target actually uses FreeRTOS. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Keep ISR work bounded. Prefer an ISR-safe handoff to task context for work that can block, allocate, parse, log heavily, or wait on a peripheral.
- Identify who owns each DMA buffer and when CPU and device access becomes valid. Do not infer cache coherence or transfer completion from a generic RTOS rule.
- Make stack, heap, static allocation, watchdog deadlines, and worst-case queue depth explicit for hard resource limits.
- Preserve a recoverable boot or update path for field-updated devices. Do not make an irreversible image transition without an established recovery mechanism.
- Make every durable write a commit of a self-validating record, and never let the write erase or overwrite the page that currently holds the newest committed record. With two erase pages the cost of that rule is a slot region per page plus a sequence number: a save appends the next slot, and only a full page triggers an erase of the page that is already superseded, so an interruption at any single erase or program still leaves the previous record intact and loadable. Partial programming is expected, not exceptional, so validation must reject a record whose checksum or terminator did not arrive, and the loader must scan rather than trust a fixed slot.
- Treat wear as a second invariant of the same design, not a finish step. Alternate the erase target between pages and verify the erase counts stay within one of each other after a long commit run; a scheme that erases the same page every save passes a brownout test and still wears the device out early.
- Size ring indices to the capacity, not to the bus width, and count every rejected byte. A producer/consumer ring that drops a byte when full without incrementing a rejection counter destroys the consumer's framing and leaves the failure unexplained; the invariant to check is that pushed minus consumed equals rejected, so no byte is lost silently. Wrap the ring many times in verification, not once, and confirm a fresh boot reinitialises both indices and the counter.

## Failure discriminators

- If a fault is load-sensitive or timing-sensitive, distinguish stack exhaustion, priority inversion, ISR latency, missed synchronization, DMA ownership, and watchdog reset before adding delays.
- If simulation passes but hardware fails, inspect clocks, pin configuration, electrical levels, peripheral errata, cache, and board revision before changing pure logic.
- If a device resets unexpectedly, capture reset cause and watchdog or brownout evidence before treating it as a software crash.
- If a bus transaction intermittently fails, separate protocol error, electrical integrity, timeout policy, and task or ISR race.

## Verification at the device boundary

- Unit-test pure state machines and protocol logic off target, but reserve timing, power, peripheral, DMA, watchdog, and electrical claims for representative hardware.
- Exercise reset during initialization, watchdog expiry where safely testable, bus timeout or error, and queue or buffer boundary conditions.
- For RTOS changes, verify task and ISR API choice against the target RTOS version and observe scheduling under representative load.
- For firmware updates, verify interrupted update and rollback or recovery behavior on non-production hardware before claiming field safety.
- Record MCU, board revision, firmware build, RTOS version, and relevant clock or peripheral configuration with hardware evidence.
- Prove persistence by interrupting the commit, not by rebooting after a clean save: replay the device's own erase/program journal with the interrupted operation applied to half of its bytes and boot each resulting image, asserting that every one loads either the new or the previous committed record and none loads a hybrid.
- Measure interrupt duration with a hardware counter (a SysTick current-value read is enough for a handler shorter than one reload period); a host-side timing of an emulated run is not evidence about the handler.

## Completion evidence

- MCU, board revision, RTOS or bare-metal model, and ownership assumptions affected
- Hardware evidence for every timing, peripheral, power, watchdog, or DMA claim
- Recovery evidence for boot or update changes, with unavailable physical checks stated explicitly

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
