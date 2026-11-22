import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';

/**
 * A real Cortex-M target, not a transcription of one.
 *
 * The firmware in this workspace is compiled by clang for `thumbv7m-none-eabi`,
 * linked with `ld.lld`, and executed under QEMU's `mps2-an386` (Cortex-M4) model.
 * A candidate that reads the fault record is reading values the core produced:
 * CFSR, HFSR, MMFAR, and the hardware stacked frame all come from a real fault
 * taken by the emulated CPU at a real instruction.
 *
 * The verdict on a candidate's repair is also produced by execution: the scorer
 * rewrites `firmware/config.h` with a fresh seed, rebuilds the candidate's own
 * source, runs it, and reads back what the board published. The sensor samples
 * are derived from that seed, so the published checksum cannot be fabricated
 * without actually running the repaired packet path on the target.
 */

export const HARDWARE_RUNTIME_BLOCKER =
  'Cortex-M target toolchain or emulator is unavailable (clang with thumbv7m support, ld.lld, qemu-system-arm)';

export const HARDWARE_SCENARIO_1 = 'hardware-runtime-debugging-full-task-1';
export const HARDWARE_SCENARIO_2 = 'hardware-runtime-debugging-full-task-2';

const QEMU_MACHINE = 'mps2-an386';
const RECORD_BASE = 0x2000_4000;
const RECORD_SIZE = 256;

/** Toolchain discovery is by absolute path first: the macOS system clang cannot
 * link an ELF, so a PATH hit on `/usr/bin/clang` is not evidence of a working
 * target build. */
function firstExisting(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const LLVM_BIN = '/opt/homebrew/opt/llvm/bin';

export function hardwareTargetToolchain(): {
  clang: string | null;
  ld: string | null;
  qemu: string | null;
  nm: string | null;
} {
  return {
    clang: firstExisting([join(LLVM_BIN, 'clang'), '/usr/local/opt/llvm/bin/clang']),
    ld: firstExisting(['/opt/homebrew/bin/ld.lld', '/usr/local/bin/ld.lld']),
    qemu: firstExisting(['/opt/homebrew/bin/qemu-system-arm', '/usr/local/bin/qemu-system-arm']),
    nm: firstExisting([join(LLVM_BIN, 'llvm-nm'), '/usr/local/opt/llvm/bin/llvm-nm']),
  };
}

export function hardwareRuntimeReadiness(): readonly string[] {
  const toolchain = hardwareTargetToolchain();
  const missing = Object.entries(toolchain)
    .filter(([, path]) => !path)
    .map(([name]) => name);
  if (missing.length) return [`${HARDWARE_RUNTIME_BLOCKER}: missing ${missing.join(', ')}`];
  return [];
}

/** The register definitions and the fault recorder are identical in both
 * scenarios: the diagnostic target does not change with the defect. */
export const HARDWARE_REGS_H = `#ifndef BOARD_REGS_H
#define BOARD_REGS_H

#include <stdint.h>

#define SYST_CSR   (*(volatile uint32_t *)0xE000E010u)
#define MPU_CTRL   (*(volatile uint32_t *)0xE000ED94u)
#define MPU_RNR    (*(volatile uint32_t *)0xE000ED98u)
#define MPU_RBAR   (*(volatile uint32_t *)0xE000ED9Cu)
#define MPU_RASR   (*(volatile uint32_t *)0xE000EDA0u)
#define SHCSR      (*(volatile uint32_t *)0xE000ED24u)
#define CFSR       (*(volatile uint32_t *)0xE000ED28u)
#define HFSR       (*(volatile uint32_t *)0xE000ED2Cu)
#define MMFAR      (*(volatile uint32_t *)0xE000ED34u)
#define BFAR       (*(volatile uint32_t *)0xE000ED38u)
#define ICSR       (*(volatile uint32_t *)0xE000ED04u)
#define AIRCR      (*(volatile uint32_t *)0xE000ED0Cu)

/* The capture channel. The board writes one NUL-terminated line here; the
 * harness reads the same bytes out of the target's RAM after the run, so this
 * is the record a debugger probe would have produced. */
#define RECORD_BASE 0x20004000u
#define RECORD ((volatile char *)RECORD_BASE)

#define SENSOR_SAMPLES 8

/* MPU RASR fields. */
#define RASR_XN      (1u << 28)
#define RASR_AP_NO   (0u << 24)
#define RASR_AP_RW   (3u << 24)
#define RASR_SIZE_32 (4u << 1)
#define RASR_ENABLE  (1u << 0)

#endif
`;

const RECORDER_C = `#include "regs.h"

static int record_index;
static int record_open = 1;

void record_reset(void) {
  record_index = 0;
  record_open = 1;
  RECORD[0] = 0;
}

static void record_char(char c) {
  if (!record_open) return;
  if (record_index >= 200) { record_open = 0; RECORD[199] = 0; return; }
  RECORD[record_index++] = c;
  if (c == 0) record_open = 0;
}

static void record_text(const char *text) {
  while (*text) record_char(*text++);
}

static void record_hex(uint32_t value) {
  const char *digits = "0123456789abcdef";
  for (int shift = 28; shift >= 0; shift -= 4) record_char(digits[(value >> shift) & 0xFu]);
}

/* sp is the value the core left at handler entry, so the eight words it points
 * at are the hardware exception frame itself. */
static void record_frame(uint32_t sp, const char *tag) {
  const volatile uint32_t *frame = (const volatile uint32_t *)(sp & 0xFFFFFFF8u);
  uint32_t lr;
  __asm__ volatile("mov %0, lr" : "=r"(lr));
  const uint32_t cfsr = CFSR, hfsr = HFSR, mmfar = MMFAR, bfar = BFAR;
  record_reset();
  record_text(tag);
  record_text(" cfsr="); record_hex(cfsr);
  record_text(" hfsr="); record_hex(hfsr);
  record_text(" mmfar="); record_hex(mmfar);
  record_text(" bfar="); record_hex(bfar);
  record_text(" lr="); record_hex(lr);
  for (int i = 0; i < 7; i++) {
    record_text(" f"); record_char((char)('0' + i));
    record_char('='); record_hex(frame[i]);
  }
  record_char('\\n');
  record_char(0);
  for (;;) { __asm__ volatile("nop"); }
}

void record_fault_hardfault(uint32_t sp) { record_frame(sp, "FAULT"); }

void record_fault_memmanage(uint32_t sp) { record_frame(sp, "MEMMANAGE"); }

/* Naked so the value moved into r0 is the core's SP at handler entry, before
 * this handler pushed anything of its own. */
__attribute__((naked)) void fault_handler(void) {
  __asm__ volatile("mov r0, sp\\n\\tb record_fault_hardfault");
}

__attribute__((naked)) void mem_manage_handler(void) {
  __asm__ volatile("mov r0, sp\\n\\tb record_fault_memmanage");
}

void record_publish(const char *text, uint32_t value) {
  record_reset();
  record_text(text);
  record_hex(value);
  record_char('\\n');
  record_char(0);
  for (;;) { __asm__ volatile("nop"); }
}
`;

const LINKER_SCRIPT = `MEMORY
{
  FLASH (rx)  : ORIGIN = 0x00000000, LENGTH = 256K
  RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 256K
}
SECTIONS
{
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss  : { *(.sensor) *(.bss*) *(COMMON) } > RAM
  _estack = ORIGIN(RAM) + LENGTH(RAM);
}
`;

/** Vector table plus reset path shared by both scenarios. */
const VECTORS_TEMPLATE = `__attribute__((section(".vectors"), used)) static void (*const vectors[])(void) = {
  (void (*)(void))(&_estack),
  reset_handler,
  fault_handler,          /* NMI */
  fault_handler,          /* HardFault */
  mem_manage_handler,     /* MemManage */
  fault_handler,          /* BusFault */
  fault_handler,          /* UsageFault */
};
`;

/**
 * Scenario 1: a guarded MPU region is configured from a stale constant, so the
 * sensor buffer it is supposed to protect is inside a no-access window. The
 * first telemetry packet reads it and takes a MemManage fault.
 */
export const HARDWARE_BOARD_S1 = `#include "config.h"
#include "regs.h"

extern uint32_t _estack;
void reset_handler(void);
void fault_handler(void);
void mem_manage_handler(void);
void record_reset(void);
void record_fault(const char *tag);
void record_publish(const char *text, uint32_t value);

/* The measurement path: samples land here and must not be disturbed. */
__attribute__((aligned(32), section(".sensor"))) volatile uint8_t sensor_buffer[SENSOR_SAMPLES];
/* Scratch space used by the calibration routine after the factory read. */
__attribute__((aligned(32))) uint8_t calibration_scratch[32];

static uint32_t packets;
static uint32_t checksum;
static int calibration;

/* This constant predates the last memory-map change: it still names the block
 * that used to hold calibration scratch, which is now where the sensor buffer
 * lives. */
#define GUARDED_REGION_BASE 0x20000000u

void mpu_setup(void) {
  MPU_CTRL = 0;
  __asm__ volatile("dsb\\n isb");
  MPU_RNR = 0;
  MPU_RBAR = GUARDED_REGION_BASE;
  MPU_RASR = RASR_XN | RASR_AP_NO | RASR_SIZE_32 | RASR_ENABLE;
  MPU_CTRL = 0x05u; /* ENABLE | PRIVDEFENA */
  __asm__ volatile("dsb\\n isb");
}

/* The factory calibration read. The fault frame points at this load. */
__attribute__((noinline, used)) static int read_calibration(void) {
  return (int)sensor_buffer[0];
}

static void sensor_fill(void) {
  for (int i = 0; i < SENSOR_SAMPLES; i++) {
    sensor_buffer[i] = (uint8_t)((KORY_SEED ^ (0x9E37u * (uint32_t)(i + 1))) >> 3);
  }
}

static void process_packet(void) {
  int sample = (int)sensor_buffer[packets & 7u];
  packets++;
  checksum = (checksum + (uint32_t)sample * packets) & 0xFFFFu;
}

void reset_handler(void) {
  record_reset();
  mpu_setup();
  __asm__ volatile("dsb\\n isb");
  calibration = read_calibration();
  (void)calibration;
  sensor_fill();
  while (packets < 3u) process_packet();
  record_publish("OK packets=3 checksum=", checksum);
}

${VECTORS_TEMPLATE}
`;

/**
 * Scenario 2: the packet dispatch table stores Thumb function pointers, and the
 * dispatcher clears the low bit to "align" the pointer before the call. The
 * BLX to an even address faults with INVSTATE before the handler runs.
 */
export const HARDWARE_BOARD_S2 = `#include "config.h"
#include "regs.h"

extern uint32_t _estack;
void reset_handler(void);
void fault_handler(void);
void mem_manage_handler(void);
void record_reset(void);
void record_fault(const char *tag);
void record_publish(const char *text, uint32_t value);

typedef void (*packet_handler)(const uint8_t *data, uint32_t length);

static uint32_t packets;
static uint32_t checksum;

static void on_telemetry(const uint8_t *data, uint32_t length) {
  uint32_t sum = 0;
  for (uint32_t i = 0; i < length; i++) sum = (sum * 33u + data[i]) & 0xFFFFu;
  checksum = (checksum + sum) & 0xFFFFu;
  packets++;
}

static void on_command(const uint8_t *data, uint32_t length) {
  packets++;
  checksum = (checksum + data[0] + length) & 0xFFFFu;
}

static const packet_handler handlers[] = { on_telemetry, on_command };

static void dispatch(const uint8_t *frame) {
  uint32_t index = frame[0] & 1u;
  /* "Normalise" the stored pointer before the indirect call. */
  packet_handler handler = (packet_handler)((uint32_t)handlers[index] & ~1u);
  handler(frame + 1, 2u);
}

void reset_handler(void) {
  record_reset();
  uint8_t frame[4];
  for (uint32_t packet = 0; packet < 3u; packet++) {
    frame[0] = (uint8_t)(KORY_SEED + packet);   /* selects the table slot */
    frame[1] = (uint8_t)((KORY_SEED >> 8) + packet * 3u);
    frame[2] = (uint8_t)(KORY_SEED >> 16);
    frame[3] = 0u;
    dispatch(frame);
  }
  record_publish("OK packets=3 checksum=", checksum);
}

${VECTORS_TEMPLATE}
`;

const README_TEMPLATE = (scenario: 1 | 2): string => `# Cortex-M telemetry board: fault triage

\`firmware/board.c\` is the application. \`firmware/regs.h\` has the core register
definitions, \`firmware/recorder.c\` is the capture channel, and \`firmware/link.ld\`
places the image. \`tools/build.sh\` compiles with clang for \`thumbv7m-none-eabi\`
and links with \`ld.lld\`; \`tools/capture.py\` runs the image under
\`qemu-system-arm -M ${QEMU_MACHINE}\` (Cortex-M4, 256K flash at 0x00000000, 256K RAM
at 0x20000000) and reads the record channel at 0x20004000 back out of target RAM.

\`faults/fault-1.txt\` is the record captured from the image that ships here. It was
produced by running this exact source, so it is the fault you are asked to
explain. \`tools/capture.py\` reproduces it.

## What a record means

\`\`\`
<tag> cfsr=… hfsr=… mmfar=… bfar=… lr=… f0=… f1=… f2=… f3=… f4=… f5=… f6=…
\`\`\`

\`f0 f1 f2 f3\` are r0 to r3, \`f4\` is r12, \`f5\` is the return address in the
faulting context, \`f6\` is the faulting PC. \`lr\` is EXC_RETURN. The stacked frame
is the hardware exception frame, not something the handler composed.
${scenario === 1 ? `
The board has an MPU. Region 0 is the only region the application configures;
\`firmware/board.c\` shows the base, size and access fields it writes.
` : `
The board dispatches packets through a table of handler pointers in
\`firmware/board.c\`.
`}

## What you deliver

1. A repaired \`firmware/board.c\` that reaches the publish point instead of
   latching a fault. The harness rebuilds your source with a fresh seed in
   \`firmware/config.h\` and runs it, so the repair has to work rather than read.
2. \`diagnosis.json\` at the workspace root:

\`\`\`json
{
  "faultStatus": ${scenario === 1 ? '"MemManage"' : '"UsageFault"'},
  "cfsr": "0x…",
  "hfsr": "0x…",
  ${scenario === 1
    ? `"mmfar": "0x…",
  "mmfarValid": true,
  "bfarValid": false,`
    : `"stackedPc": "0x…",
  "returnAddress": "0x…",
  "invstate": true,`}
  ${scenario === 1
    ? `"pcSymbol": "<function containing the faulting PC>",
  "cause": "mpu-region-misconfigured",
  "mpuRegion": 0,
  "regionBase": "0x…",
  "regionSizeBytes": 32,
  "regionAccess": "no-access",`
    : `"pcSymbol": "<function containing the return address>",
  "cause": "thumb-bit-cleared",`}
  "repair": "<one sentence: what you changed and why it removes the fault>"
}
\`\`\`

\`cause\` is one of ${scenario === 1 ? '`mpu-region-misconfigured`, `stack-overflow`, `unmapped-access`' : '`thumb-bit-cleared`, `unmapped-access`, `stack-overflow`'}.
Report the values the core recorded, not the values you would expect.
`;

const BUILD_SH = `#!/bin/sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
CC=\${KORY_CLANG:-/opt/homebrew/opt/llvm/bin/clang}
LD=\${KORY_LD_LLD:-/opt/homebrew/bin/ld.lld}
mkdir -p "$here/build"
for source in board recorder; do
  "$CC" --target=thumbv7m-none-eabi -mcpu=cortex-m4 -mthumb -O1 -g -nostdlib \\
    -ffreestanding -fno-common -I"$here/firmware" -c "$here/firmware/$source.c" \\
    -o "$here/build/$source.o"
done
"$LD" -T "$here/firmware/link.ld" --entry=reset_handler \\
  -o "$here/build/board.elf" "$here/build/board.o" "$here/build/recorder.o"
echo "built $here/build/board.elf"
`;

const CAPTURE_PY = `#!/usr/bin/env python3
"""Run the image under QEMU and read the record channel back out of RAM."""
import os
import re
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ELF = os.path.join(HERE, 'build', 'board.elf')
QEMU = os.environ.get('KORY_QEMU', '/opt/homebrew/bin/qemu-system-arm')
RECORD_BASE = 0x20004000
RECORD_SIZE = 256


def capture(seconds=1.5):
    with tempfile.TemporaryDirectory() as tmp:
        sock_path = os.path.join(tmp, 'monitor.sock')
        dump_path = os.path.join(tmp, 'record.bin')
        process = subprocess.Popen(
            [QEMU, '-M', 'mps2-an386', '-kernel', ELF, '-display', 'none',
             '-serial', 'null', '-monitor', 'unix:%s,server,nowait' % sock_path],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.time() + 10
        while not os.path.exists(sock_path) and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(seconds)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(sock_path)
        connection.settimeout(5)
        connection.sendall(('pmemsave 0x%08x %d "%s"\\n'
                            % (RECORD_BASE, RECORD_SIZE, dump_path)).encode())
        time.sleep(0.5)
        connection.sendall(b'quit\\n')
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        if not os.path.exists(dump_path):
            raise SystemExit('no record captured')
        with open(dump_path, 'rb') as handle:
            raw = handle.read()
    text = raw.split(b'\\x00', 1)[0].decode('utf-8', 'replace').strip()
    return text


if __name__ == '__main__':
    record = capture()
    print(record)
    sys.exit(0 if record else 1)
`;

const CONFIG_H = (seed: number): string => `#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H
/* Written by the harness for every build. The sensor samples and the packet
 * selection both derive from it. */
#define KORY_SEED 0x${(seed >>> 0).toString(16).padStart(8, '0')}u
#endif
`;

function seedForScenario(scenario: 1 | 2): number {
  // Deterministic materialization seed; the scorer overwrites it per run.
  return scenario === 1 ? 0x51ce_2a07 : 0x2b9f_7143;
}

export function hardwareMaterialize(destination: string, scenario: 1 | 2): void {
  const firmware = join(destination, 'firmware');
  mkdirSync(firmware, { recursive: true });
  mkdirSync(join(destination, 'tools'), { recursive: true });
  mkdirSync(join(destination, 'faults'), { recursive: true });
  writeFileSync(join(firmware, 'regs.h'), HARDWARE_REGS_H);
  writeFileSync(join(firmware, 'recorder.c'), RECORDER_C);
  writeFileSync(join(firmware, 'link.ld'), LINKER_SCRIPT);
  writeFileSync(join(firmware, 'config.h'), CONFIG_H(seedForScenario(scenario)));
  writeFileSync(join(firmware, 'board.c'), scenario === 1 ? HARDWARE_BOARD_S1 : HARDWARE_BOARD_S2);
  writeFileSync(join(destination, 'README.md'), README_TEMPLATE(scenario));
  writeFileSync(join(destination, 'tools', 'build.sh'), BUILD_SH, { mode: 0o755 });
  writeFileSync(join(destination, 'tools', 'capture.py'), CAPTURE_PY, { mode: 0o755 });
  const captured = buildAndCapture(destination, seedForScenario(scenario));
  writeFileSync(join(destination, 'faults', 'fault-1.txt'), `${captured.record}\n`);
  // The matching image with symbols is part of the evidence a debugger session
  // starts from, so it ships next to the record.
  writeFileSync(
    join(destination, 'faults', 'fault-1.elf'),
    readFileSync(join(destination, 'build', 'board.elf')),
  );
}

export interface HardwareRun {
  built: boolean;
  record: string;
  buildLog: string;
  runLog: string;
}

/** Build the candidate's source and return the record the target published. */
export function buildAndCapture(root: string, seed: number): HardwareRun {
  const toolchain = hardwareTargetToolchain();
  if (!toolchain.clang || !toolchain.ld || !toolchain.qemu) {
    return {
      built: false,
      record: '',
      buildLog: hardwareRuntimeReadiness().join('\n'),
      runLog: '',
    };
  }
  writeFileSync(join(root, 'firmware', 'config.h'), CONFIG_H(seed));
  const build = spawnSync('sh', [join(root, 'tools', 'build.sh')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, KORY_CLANG: toolchain.clang, KORY_LD_LLD: toolchain.ld },
  });
  const buildLog = `${build.stdout ?? ''}\n${build.stderr ?? ''}`.trim();
  if (build.status !== 0) {
    return { built: false, record: '', buildLog, runLog: '' };
  }
  const run = spawnSync('python3', [join(root, 'tools', 'capture.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, KORY_QEMU: toolchain.qemu },
  });
  return {
    built: true,
    record: (run.stdout ?? '').trim(),
    buildLog,
    runLog: `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim(),
  };
}

export interface HardwareRecord {
  tag: string;
  cfsr: number;
  hfsr: number;
  mmfar: number;
  bfar: number;
  lr: number;
  frame: number[];
}

export function parseHardwareRecord(text: string): HardwareRecord | null {
  const match = /^(\w+) cfsr=([0-9a-f]{8}) hfsr=([0-9a-f]{8}) mmfar=([0-9a-f]{8}) bfar=([0-9a-f]{8}) lr=([0-9a-f]{8}) ((?:f[0-6]=[0-9a-f]{8} ?){7})/u.exec(
    text.trim(),
  );
  if (!match) return null;
  const frame = [...match[7].matchAll(/f(\d)=([0-9a-f]{8})/gu)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((entry) => Number.parseInt(entry[2], 16));
  return {
    tag: match[1],
    cfsr: Number.parseInt(match[2], 16),
    hfsr: Number.parseInt(match[3], 16),
    mmfar: Number.parseInt(match[4], 16),
    bfar: Number.parseInt(match[5], 16),
    lr: Number.parseInt(match[6], 16),
    frame,
  };
}

/** Symbol table read straight out of the ELF the harness just built. */
export function elfSymbols(elfPath: string): { name: string; address: number }[] {
  const toolchain = hardwareTargetToolchain();
  if (!toolchain.nm || !existsSync(elfPath)) return [];
  const result = spawnSync(toolchain.nm, ['-S', elfPath], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
  const symbols: { name: string; address: number }[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^([0-9a-f]{8})(?: [0-9a-f]{8})? [TtWwDdBb] (\S+)$/u.exec(line.trim());
    if (match) symbols.push({ address: Number.parseInt(match[1], 16), name: match[2] });
  }
  return symbols.sort((a, b) => a.address - b.address);
}

/** The function whose code contains `address`, for Thumb targets where the
 * stacked PC already has bit 0 set and the symbol value does not. */
export function symbolContaining(
  symbols: readonly { name: string; address: number }[],
  address: number,
): string | null {
  const target = address & ~1;
  let found: string | null = null;
  for (const symbol of symbols) {
    if (symbol.address <= target) found = symbol.name;
    else break;
  }
  return found;
}

export function expectedChecksum(seed: number, scenario: 1 | 2): number {
  const samples = Array.from({ length: 8 }, (_, index) => ((seed ^ Math.imul(0x9e37, index + 1)) >>> 3) & 0xff);
  if (scenario === 1) {
    let checksum = 0;
    for (let packet = 0; packet < 3; packet++) {
      checksum = (checksum + samples[packet & 7] * (packet + 1)) & 0xffff;
    }
    return checksum;
  }
  const frames = Array.from({ length: 3 }, (_, packet) => [
    (seed + packet) & 0xff,
    (((seed >>> 8) + packet * 3) >>> 0) & 0xff,
    (seed >>> 16) & 0xff,
  ]);
  let checksum = 0;
  for (const frame of frames) {
    if ((frame[0] & 1) === 0) {
      let sum = 0;
      const payload = frame.slice(1, 3);
      for (const byte of payload) sum = (Math.imul(sum, 33) + byte) & 0xffff;
      checksum = (checksum + sum) & 0xffff;
    } else {
      checksum = (checksum + frame[1] + 2) & 0xffff;
    }
  }
  return checksum;
}
export interface HardwareDiagnosis {
  faultStatus?: string;
  cfsr?: string;
  hfsr?: string;
  mmfar?: string;
  mmfarValid?: boolean;
  bfarValid?: boolean;
  stackedPc?: string;
  returnAddress?: string;
  invstate?: boolean;
  pcSymbol?: string;
  cause?: string;
  mpuRegion?: number;
  regionBase?: string;
  regionSizeBytes?: number;
  regionAccess?: string;
  repair?: string;
}

export type HardwareCheck = { id: string; passed: boolean; detail: string };

const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

function readDiagnosis(root: string): HardwareDiagnosis | null {
  const path = join(root, 'diagnosis.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HardwareDiagnosis;
  } catch {
    return null;
  }
}

export interface HardwareScenarioResult {
  passed: boolean;
  checks: HardwareCheck[];
  evidence: string;
}

/**
 * Score a candidate against the fault the shipped image actually took and the
 * behaviour of the image built from the candidate's repair.
 */
export function runHardwareScenario(root: string, scenario: 1 | 2): HardwareScenarioResult {
  const blockers = hardwareRuntimeReadiness();
  if (blockers.length) return { passed: false, checks: [], evidence: blockers.join('\n') };

  const checks: HardwareCheck[] = [];
  const evidence: string[] = [];
  const faultPath = join(root, 'faults', 'fault-1.txt');
  const faultText = existsSync(faultPath) ? readFileSync(faultPath, 'utf8') : '';
  const record = parseHardwareRecord(faultText);
  const symbols = elfSymbols(join(root, 'faults', 'fault-1.elf'));
  const diagnosis = readDiagnosis(root);

  checks.push({
    id: 'contract',
    passed: Boolean(diagnosis) && Boolean(record),
    detail: diagnosis
      ? 'diagnosis.json parsed'
      : 'diagnosis.json is missing or is not valid JSON',
  });
  if (!record) evidence.push(`shipped fault record unreadable: ${faultText.slice(0, 200)}`);

  // The ground truth is the record on disk plus the symbol table of the image
  // that produced it, so a candidate is graded against the real target.
  // Both faults are precise: the stacked PC is the instruction that faulted, so
  // the symbol the candidate has to name comes from the frame in both cases.
  const truthSymbol = record ? symbolContaining(symbols, record.frame[6]) : null;

  if (record && diagnosis) {
    if (scenario === 1) {
      const classOk =
        (diagnosis.faultStatus ?? '').toLowerCase() === 'memmanage' &&
        (diagnosis.cfsr ?? '').toLowerCase() === hex(record.cfsr) &&
        (record.cfsr & 0x82) === 0x82;
      checks.push({
        id: 'fault-class',
        passed: classOk,
        detail: `reported ${diagnosis.faultStatus}/${diagnosis.cfsr}; target recorded MemManage ${hex(record.cfsr)} (DACCVIOL + MMARVALID)`,
      });
      const addressOk =
        (diagnosis.mmfar ?? '').toLowerCase() === hex(record.mmfar) &&
        diagnosis.mmfarValid === true &&
        diagnosis.bfarValid === false;
      checks.push({
        id: 'fault-address',
        passed: addressOk,
        detail: `reported mmfar=${diagnosis.mmfar} valid=${diagnosis.mmfarValid} bfarValid=${diagnosis.bfarValid}; target recorded mmfar=${hex(record.mmfar)} bfar valid=${(record.cfsr & 0x8000) === 0x8000}`,
      });
      const regionOk =
        diagnosis.cause === 'mpu-region-misconfigured' &&
        diagnosis.mpuRegion === 0 &&
        (diagnosis.regionBase ?? '').toLowerCase() === hex(record.mmfar) &&
        diagnosis.regionSizeBytes === 32 &&
        (diagnosis.regionAccess ?? '').toLowerCase() === 'no-access';
      checks.push({
        id: 'cause',
        passed: regionOk,
        detail: `reported cause=${diagnosis.cause} region=${diagnosis.mpuRegion} base=${diagnosis.regionBase} size=${diagnosis.regionSizeBytes} access=${diagnosis.regionAccess}`,
      });
    } else {
      const classOk =
        (diagnosis.faultStatus ?? '').toLowerCase() === 'usagefault' &&
        (diagnosis.cfsr ?? '').toLowerCase() === hex(record.cfsr) &&
        (record.cfsr & 0x2_0000) === 0x2_0000;
      checks.push({
        id: 'fault-class',
        passed: classOk,
        detail: `reported ${diagnosis.faultStatus}/${diagnosis.cfsr}; target recorded UsageFault ${hex(record.cfsr)} (INVSTATE)`,
      });
      const addressOk =
        (diagnosis.stackedPc ?? '').toLowerCase() === hex(record.frame[6]) &&
        (diagnosis.returnAddress ?? '').toLowerCase() === hex(record.frame[5]) &&
        diagnosis.invstate === true;
      checks.push({
        id: 'fault-address',
        passed: addressOk,
        detail: `reported pc=${diagnosis.stackedPc} lr=${diagnosis.returnAddress} invstate=${diagnosis.invstate}; target recorded pc=${hex(record.frame[6])} lr=${hex(record.frame[5])}`,
      });
      checks.push({
        id: 'cause',
        passed: diagnosis.cause === 'thumb-bit-cleared',
        detail: `reported cause=${diagnosis.cause}`,
      });
    }

    checks.push({
      id: 'pc-symbol',
      passed: Boolean(truthSymbol) && (diagnosis.pcSymbol ?? '') === truthSymbol,
      detail: `reported ${diagnosis.pcSymbol ?? '(none)'}; the fault frame resolves to ${truthSymbol ?? '(unresolved)'} in faults/fault-1.elf`,
    });
  }

  // The repair is judged by execution: fresh seed, rebuilt from the candidate's
  // own source, run on the target.
  const seed = (Date.now() & 0xff_ffff) | 0x10_0000;
  const run = buildAndCapture(root, seed);
  checks.push({
    id: 'repair-builds',
    passed: run.built,
    detail: run.built ? 'candidate source compiled and linked' : run.buildLog.slice(-600) || 'build failed',
  });
  const expected = expectedChecksum(seed, scenario);
  const published = /^OK packets=3 checksum=([0-9a-f]{8})/u.exec(run.record);
  const runsClean = run.built && Boolean(published) && Number.parseInt(published![1], 16) === expected;
  checks.push({
    id: 'repair-runs',
    passed: runsClean,
    detail: run.built
      ? `target published "${run.record.slice(0, 80)}"; expected checksum ${hex(expected)} from seed ${hex(seed)}`
      : 'target was not run because the build failed',
  });
  if (run.record) evidence.push(`repaired image record: ${run.record.slice(0, 200)}`);

  const passed = checks.length === 7 && checks.every((check) => check.passed);
  return { passed, checks, evidence: evidence.join('\n').slice(-4000) };
}

function hardwareScore(result: HardwareScenarioResult): {
  passed: boolean;
  quality: number;
  verification: number;
  integrityFailure: boolean;
  evidence: string[];
} {
  const evidence = result.checks.map(
    (check) => `${check.id}: ${check.passed ? 'pass' : 'fail'} (${check.detail})`,
  );
  if (!result.checks.length) evidence.push(result.evidence);
  const passing = result.checks.filter((check) => check.passed).length;
  return {
    passed: result.passed,
    quality: result.checks.length ? passing / result.checks.length : 0,
    verification: result.checks.length ? 1 : 0,
    integrityFailure: false,
    evidence,
  };
}

export const HARDWARE_RUNTIME_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'hardware-runtime-debugging/cortex-m-fault-triage@1',
    realRuntime: true,
    readinessBlockers: hardwareRuntimeReadiness(),
    matches: (scenario) => scenario.id === HARDWARE_SCENARIO_1,
    materialize: (destination) => hardwareMaterialize(destination, 1),
  },
  {
    id: 'hardware-runtime-debugging/cortex-m-invstate@1',
    realRuntime: true,
    readinessBlockers: hardwareRuntimeReadiness(),
    matches: (scenario) => scenario.id === HARDWARE_SCENARIO_2,
    materialize: (destination) => hardwareMaterialize(destination, 2),
  },
];

export const HARDWARE_RUNTIME_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'hardware-runtime-debugging/cortex-m-fault-triage-scorer@1',
    scenarioIds: [HARDWARE_SCENARIO_1],
    score: ({ workingDirectory }) => hardwareScore(runHardwareScenario(workingDirectory, 1)),
  },
  {
    id: 'hardware-runtime-debugging/cortex-m-invstate-scorer@1',
    scenarioIds: [HARDWARE_SCENARIO_2],
    score: ({ workingDirectory }) => hardwareScore(runHardwareScenario(workingDirectory, 2)),
  },
];
