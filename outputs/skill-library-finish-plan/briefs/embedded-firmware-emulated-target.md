# embedded-firmware: an emulated Cortex-M4 target instead of a gate

`embedded-firmware` was one of nine packages whose two full-task scenarios were served by
`EXTERNAL_ENVIRONMENT_GATES`, which returns a fail-closed scanner that can never pass. The
gate said "requires the declared firmware/MCU execution environment for brownout
persistence and ISR overrun behavior; host-only simulation cannot certify the full task".
That statement is true of a host-only simulation. It is not true of an emulated target that
actually executes the candidate's firmware, so the gate is now a real harness.

## What runs

Every boot in this fixture is a clang-built `thumbv7m-none-eabi` image running under QEMU's
`mps2-an386` (Cortex-M4) machine, linked by `ld.lld` against a linker script that places the
vector table at `0x00000000` and RAM at `0x20000000`.

Toolchain discovery is by absolute path, not by `PATH`:

| tool | path |
| --- | --- |
| clang | `/opt/homebrew/opt/llvm/bin/clang` |
| ld.lld | `/opt/homebrew/bin/ld.lld` (23.1.5, installed for this work) |
| qemu-system-arm | `/opt/homebrew/bin/qemu-system-arm` (11.1.1) |

A `PATH` hit on `/usr/bin/clang` is not evidence of a working target build: the macOS system
clang cannot produce an ELF. If any of the four prerequisites is missing, the materializer
declares a readiness blocker and the campaign reports the scenario as environment-blocked.
It never falls back to a gate that could pass.

## Scenario 1: brownout-safe configuration store

Workspace: `config_store.c` is the candidate's file. Everything under `src/` is
harness-owned and is rewritten from the harness templates before every scoring run, so an
edit there has no effect on the verdict.

The device model is two 256-byte NOR pages with real programming semantics enforced by the
harness when it replays the device's own journal: an erase fills a page with `0xFF`, a
program can only clear bits, and a `P` operation is applied to half of its bytes when the
power budget dies during it. `src/flash_port.c` is the only path to flash, consumes one
operation from `power.txt` per erase or program, appends an `E`/`P` line to `ops.log`, and
exits through semihosting when the budget is spent.

The scored properties, all six measured on the target:

1. `contract` builds against `src/config_store.h` and a blank device loads status 0.
2. `persists` 64 commits each load back with their own sequence number and fields.
3. `brownout-sweep` the erase-crossing save is replayed from `ops.log` at every truncation
   point and each rebuilt image must load either the new committed record or the previous
   one, never a hybrid and never status 0.
4. `torn-write` the half-programmed image must load the previous committed record.
5. `wear-rotation` after 64 commits the per-page erase counts must stay within one of each
   other and records must have landed on both pages.
6. `legacy-schema` a schema 1 record written by the harness into a blank image still loads.

Measured discrimination, same build and same budget:

| source | sweep | torn write | erases | verdict |
| --- | --- | --- | --- | --- |
| shipped single-slot store | 2 of 3 truncation points broken | status `0xFFFFFFFF` | 64/0 | fails 3 of 6 |
| two-page slot journal with sequence | new 1, previous 2, broken 0 | previous record | 3/4 (within one) | passes 6 of 6 |

The shipped store is a real defect and not a strawman: erasing the only page that holds the
last good configuration is the classic way a settings store is lost on brownout, and it also
erases the same page on every save, which is why the wear check fails with 64 erases on page
0 and none on page 1.

## Scenario 2: interrupt producer into a fixed-capacity ring

Workspace: `ring.c` is the candidate's file. A real SysTick exception (reload 249) pushes
bytes from a compiled-in 960-byte corpus of 120 framed messages into a 32-byte ring while
the main loop pops bytes and decodes `0x02 <length> <payload> <xor checksum> 0x03` frames.
Two knobs are set before each boot: `rate.txt` (bytes per interrupt) and `slow.txt` (a
busy-wait the consumer runs between drains).

Checks: `contract`, `framing-intact` (4 bytes per interrupt, every frame in order, no gaps,
no checksum errors, no overruns), `wrap` (8 bytes per interrupt, about 30 index wraps, still
every frame), `overflow-accounted` (64 bytes per interrupt with a slowed consumer must
produce overruns greater than zero and `pushed - popped == overruns`), `restart-clean` (a
fresh boot after an overflow starts from a clean ring), and `isr-bounded` (the longest
handler must stay under 400 cycles).

Measured: the shipped ring drops the byte silently and never increments its counter, so the
overflowing run reports `overruns=0` with `pushed=960` and a popped count around 460, so the accounting check fails
while the other five pass. A ring that counts the rejection reports roughly 500 overruns against the same
960 pushed, and `pushed - popped` equals the overrun count exactly. Handler durations
measured across runs were 74 to 226 cycles.

## Two substitutions, recorded rather than hidden

**The producer is a timer, not the UART receive line.** The plan was a UART ISR. This
machine's CMSDK UART holds its RX interrupt line asserted once `RXIRQEN` is set, even with no
data pending: `INTSTATUS` reads bit 1 set on entry, and QEMU `-d int` shows the core
tail-chaining back into the same exception forever after one byte is drained. A UART cannot
be the interrupt source on `mps2-an386`, so the producer is SysTick. The ring contract, the
interrupt/consumer interleaving and the overrun accounting are unaffected, but this scenario
does not exercise a UART driver and the brief does not claim it does.

**The handler is clocked from SysTick, not from the DWT cycle counter.** `DWT->CYCCNT`
reads 0 and stays 0 on this machine even with `DEMCR.TRCENA` and `DWT_CTRL.CYCCNTENA` set
(measured: every run reported `maxisr=0`). The duration is therefore computed from the
SysTick current-value register at handler entry and exit, which is valid for a handler
shorter than one reload period and is what the 400-cycle budget is checked against.

## Harness defects found by measurement and fixed

- The corpus generator checksummed frames with a CRC-8 while the guest verified an XOR, so
  every frame after the third failed. Fixed in the generator; the guest decoder was the
  specification.
- The workspace's own `build.sh` compiled only harness sources, so a candidate's file was
  never linked and every candidate "failed" the same way. Fixed.
- QEMU resolves semihosting paths against its own working directory, which was the
  repository rather than the workspace. Fixed by setting `cwd`.
- Emulator console capture is not a stable channel: a boot occasionally exits 0 with its
  output lost. The guest now writes its summary to `result.txt` as well, and the harness
  reads that file. A boot that could not be spawned at all (this host runs several campaigns
  concurrently) is retried up to three times instead of being scored as a firmware that
  printed nothing.
- The first design used a 10 microsecond SysTick and a 7200-byte corpus, which took 50 to 80
  seconds per scenario: each emulated SysTick exception costs several milliseconds of host
  time on this machine regardless of its period (measured: 7201 interrupts took 46.0 s with
  reload 250 and 46.6 s with reload 25000). The corpus is now 960 bytes so a full scenario is
  a few hundred interrupts.
- One template literal had an unescaped `\n`, which produced a raw newline inside a C
  character literal. Same failure class as the hardware-runtime harness; caught by compiling
  the materialized workspace in a test.

## Qualification

Campaign executor `logfare-text-patch` with subject `deepseek-v4.1-flash-1017`, the
only model on the account that completed a full pair while the others were returning 429,
503 or truncated streams. The provider was degraded for most of this session: four models
failed probes, and several campaign attempts ended as infrastructure failures
(`Provider stream ended without a complete event`, `The model did not respond in time`)
which are excluded from evidence rather than scored.

Two full-task rounds, `--force` for the second, all pairs scored by the target itself:

| scenario | with-skill | without-skill |
| --- | --- | --- |
| brownout configuration store | pass | fail at `brownout-sweep`, `torn-write`, `wear-rotation` (quality 0.667) |
| interrupt ring buffer | pass | pass |

The ring scenario does not separate the arms here: the no-skill candidate also counted its
rejections, which is the honest outcome and is recorded rather than engineered away. The
brownout scenario separates them in every round.

Routing evidence was recorded for revision 5.2.0 before the campaign: 16 cases, with-skill
16 of 16 and without-skill 8 of 16, failing exactly the positive and ambiguous cases.

Blind review `blind-v5-555493c20c530373604a`, reviewer `independent-agent` on
`deepseek-v4.1-flash-1017`, recorded 2026-11-18T01:25:00Z, mapping A = with-skill. Verdict:
preference A. Its stated grounds are that the with-skill artifact passes all six properties
including `brownout-sweep` and `torn-write`, that its slot-based append with a commit tail
and page rotation preserves the previous record at every interruption point, and that the
erase-then-program scheme loses the previous committed record on interruption.

Gate: `status ready`, coverage `{positive:5, negative:5, ambiguous:3, adversarial:3,
full-task:2, regression:0}`, one persisted blind review, zero open regressions, no reasons.

The reviewer spent its whole token budget on a sealed 57 KB assignment at the default cap:
three attempts returned `finish=length` with empty content at 4096 and 16000 tokens, and the
same assignment adjudicated normally at 16000 once the reviewer model was pinned to
`deepseek-v4.1-flash-1017`. Two attempts also died on transport (503, 429) before one
completed. That is provider state, not a property of the fixture.

## Wiring

- Harness: `backend/src/eval/skills/skill-eval-embedded-runtime.ts`.
- Tests: `backend/src/kory/__tests__/skill-eval-embedded-runtime.test.ts`, four tests, all
  passing: the corpus checksum matches the decoder, the starter fails for the named reason
  and a correct implementation passes every check on both scenarios, and the scorers are
  registered for exactly the two scenario ids.
- Registered in `skill-eval-fixtures.ts`; the `embedded-firmware` entry is removed from
  `skill-eval-external-environment-boundaries.ts`.
- External-environment gate counts moved honestly: 57 to 55 gated scenarios and 53 to 51
  fail-closed materializer/scorer pairs, because these two scenarios now have real runtimes.
- Scenario JSONs were rebuilt from the committed originals, keeping `maturity`, `scorers`,
  `requiredEvidence`, `requiredArtifacts` and the six `falsifiableChecks` ids; prompts and
  environment requirements were rewritten to describe the target that actually exists and
  the measurements above.
- `skills-v5/embedded-firmware/SKILL.md` gained four measured statements: never erase the
  page holding the newest committed record, validate a partially programmed record instead
  of trusting a fixed slot, treat wear as a second invariant, size ring indices to capacity
  and account for every rejected byte, and prove persistence by replaying the journal plus
  clock the handler from a hardware counter. Version 5.1.1 to 5.2.0.

## What this does not claim

- The brownout model is a journal replay, not a power rail. It reproduces the two properties
  that matter to a flash commit (an operation is atomic or half applied, and the device stops
  there) and nothing about voltage ramp, brownout detector threshold or write disturb.
- The emulator does not model cache behaviour, electrical integrity, peripheral errata or
  real flash endurance. The erase counters are the harness's, not the part's.
- `isr-bounded` measures the candidate's push path on an emulated M4, not worst-case latency
  with flash wait states and higher priority interrupts on silicon.
- No claim is made about a UART driver, which the platform finding above rules out here.

## Shared files touched

- `backend/src/eval/skills/skill-eval-embedded-runtime.ts` (new)
- `backend/src/kory/__tests__/skill-eval-embedded-runtime.test.ts` (new)
- `backend/src/eval/skills/skill-eval-fixtures.ts` (two imports, two spreads)
- `backend/src/eval/skills/skill-eval-external-environment-boundaries.ts` (gate entry removed)
- `backend/src/kory/__tests__/skill-eval-external-environment-fixtures.test.ts` (counts 57 to 55, 53 to 51)
- `skills-v5/embedded-firmware/SKILL.md`, `skills-v5/embedded-firmware/kory.json`,
  `skills-v5/embedded-firmware/evals/tasks/scenario-{1,2}.json`
