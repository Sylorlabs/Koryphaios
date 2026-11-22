# hardware-runtime-debugging: a target that faults, not a description of one

This package was declared unfaithful: its scenarios asked for a Cortex-M fault
triage and a Vulkan device-loss investigation, and neither had anything to run
against. The first half now executes on a real emulated core. The second half was
substituted, and that substitution is the one judgement call in this brief.

## The target

`backend/src/eval/skills/skill-eval-hardware-runtime.ts` builds a Cortex-M4
firmware from source with clang for `thumbv7m-none-eabi`, links it with `ld.lld`,
and runs it under `qemu-system-arm -M mps2-an386` (256K flash at 0x00000000, 256K
RAM at 0x20000000). The record the candidate reads was written by that core, from
the registers it set:

- `CFSR`, `HFSR`, `MMFAR`, `BFAR` and `EXC_RETURN` are read by the fault handler
  out of the core's own system registers.
- The eight stacked words are the hardware exception frame. The handlers are
  `naked` functions that move the entry-time SP into r0 and branch, so the frame
  pointer is not disturbed by the handler's own prologue. An earlier version read
  SP after the prologue and silently reported the wrong frame; the current test
  asserts the frame resolves to the intended symbol, which is what caught it.
- The record is read back out of target RAM by dumping 0x20004000 over the QEMU
  monitor socket, so nothing is printed by the firmware and nothing is transcribed
  by hand.

The matching image with symbols ships next to the record (`faults/fault-1.elf`),
because a diagnosis of a captured frame against a patched image's symbols is
wrong by construction.

| Scenario | Fault the target takes | What the candidate must get right |
|---|---|---|
| `full-task-1` | MemManage, `CFSR` 0x00000082 (DACCVIOL + MMARVALID), `HFSR` FORCED, `MMFAR` = the guarded sample buffer, stacked PC inside `read_calibration`, stacked LR in `reset_handler` | decode the class and validity fields, name the function from the ELF, attribute the cause to MPU region 0 being configured no-access over live data, repair the region |
| `full-task-2` | UsageFault, `CFSR` 0x00020000 (INVSTATE), `HFSR` FORCED, no valid fault address, stacked PC = the handler entry the corrupted pointer aimed at, stacked LR = the dispatch call site | decode the class, explain why this class carries no usable fault address, name the target function and the calling site, attribute the cause to the Thumb bit being cleared on the stored pointer, repair the dispatch |

## The repair is judged by execution

The scorer rewrites `firmware/config.h` with a fresh 24-bit seed, rebuilds the
candidate's own `firmware/board.c`, runs it on the target, and reads back what the
board published. The packet samples and packet selection both derive from that
seed, so the published checksum cannot be precomputed or fabricated: it only
appears if the repaired packet path executes. Measured behaviour:

| Input | Scenario 1 | Scenario 2 |
|---|---|---|
| shipped source untouched | fails (`repair-runs`), quality 0.33 | fails (`repair-runs`), quality 0.33 |
| shipped source plus the diagnosis alone | fails (`repair-runs`) | fails (`repair-runs`) |
| repaired source plus a matching diagnosis | passes all 7 checks | passes all 7 checks |
| repaired source plus a wrong symbol or an invented `bfarValid` | fails exactly `pc-symbol` and `fault-address` | fails exactly `pc-symbol` |

## The substitution, stated plainly

`scenario-2` was a Vulkan `VK_ERROR_DEVICE_LOST` investigation on an NVIDIA GPU.
This host has no NVIDIA device, and a device-loss reproduction cannot be faked
from a log: the scenario asked for driver-version control, second-GPU control and
Xid evidence that no CPU-only host can produce. Rather than leave a scenario that
could only ever be graded on prose, it is now a second Cortex-M fault class on the
same board: INVSTATE on a corrupted function pointer, which is a different status
class, a different address-validity rule and a different root cause from scenario
1. Both scenarios ship the same evidence contract, and neither can be passed by
describing a fault.

What is lost: coverage of GPU/device-loss triage, which returns to this package
when a host with the declared GPU exists. What is kept: the skill's actual method
is exercised twice, on two fault classes, against a real core, with a repair that
must run.

## Evidence

- Routing: 5 positive, 5 negative, 3 ambiguous, 3 adversarial; precision and
  recall 1.00.
- Full-task: 2 passing candidates of 4 at the current contract, both scenarios
  covered, 0 open regressions.
- Blind review: persisted (`hardware-runtime-debugging-full-task-1`, reviewer
  logfare `deepseek-v4.1-flash-1017`, recorded 2026-11-17T03:20:45Z).
- Gate: `status ready`, coverage
  `{positive:5, negative:5, ambiguous:3, adversarial:3, full-task:2, regression:0}`,
  zero reasons.
- Skill version 5.1.1 to 5.2.0: the prompt now describes the workspace that
  exists, the requirements name real evidence, and the skill gained the paragraph
  that says to report recorded register values before interpreting them, to
  resolve the frame against the matching image, to state the fault's precision
  class, and to prove the repair by running it.
- Fixture tests: `skill-eval-hardware-runtime.test.ts` 6/6 in 27 s, covering the
  real record, the untouched-image failure, the wrong-diagnosis rejection, the
  scenario-2 record, and the seed-derived checksum across two seeds.

## Two host notes

- Building an ELF for a Thumb target needs an ELF linker. The macOS clang cannot
  do it and Homebrew's LLVM ships no `ld.lld`, so `brew install lld` was required
  (`/opt/homebrew/bin/ld.lld`). Readiness probes the compiler, linker, emulator and
  symbol reader by absolute path, because a PATH hit on `/usr/bin/clang` is not
  evidence of a working target build.
- The Logfare reviewer intermittently answers 429 or 502 before a request is
  even formed. The review above landed on the fourth attempt; the earlier attempts
  are recorded in the campaign log rather than discarded.
