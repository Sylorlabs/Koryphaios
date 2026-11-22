import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';

/**
 * A real Cortex-M target, not a model of one.
 *
 * Every boot in this fixture is a clang-built `thumbv7m-none-eabi` image running
 * under QEMU's `mps2-an386` (Cortex-M4) machine. Persistent state is a byte image
 * the guest reads at boot and journals every erase and program of; a brownout is
 * the harness exhausting that journal's operation budget so the device dies at
 * the failing operation, after which the harness replays the journal into a new
 * image and boots again. The flash rules the harness enforces while replaying are
 * the physical ones: erase writes 0xFF, program can only clear bits, and a torn
 * operation is applied to half of its bytes.
 *
 * The second scenario drives a fixed-capacity ring from a real SysTick interrupt
 * and decodes framed traffic in the main loop, so producer and consumer really do
 * interleave on the target. The producer is a timer rather than the UART RX line
 * because this machine's CMSDK UART latches RXIRQ and re-asserts it with no data
 * pending (measured: `INTSTATUS` reads 2 on every entry after draining one byte),
 * which tail-chains the core forever. The ring contract, the interrupt/consumer
 * interleaving, and the overrun accounting are unaffected by that substitution.
 */

export const EMBEDDED_RUNTIME_BLOCKER =
  'Cortex-M target toolchain or emulator is unavailable (clang with thumbv7m support, ld.lld, qemu-system-arm)';

export const EMBEDDED_SCENARIO_1 = 'embedded-firmware-full-task-1-individual';
export const EMBEDDED_SCENARIO_2 = 'embedded-firmware-full-task-2-individual';

const QEMU_MACHINE = 'mps2-an386';
const FLASH_PAGE_SIZE = 256;
const FLASH_PAGE_COUNT = 2;
const FLASH_TOTAL = FLASH_PAGE_SIZE * FLASH_PAGE_COUNT;
const RECORD_BYTES = 32;
const COMMITS = 64;
const RING_CAPACITY = 32;

function firstExisting(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** macOS system clang cannot produce an ELF, so discovery is by absolute path
 * before PATH: a PATH hit on `/usr/bin/clang` is not evidence of a working build. */
export function embeddedToolchain(): {
  clang: string | null;
  ld: string | null;
  qemu: string | null;
  includeDir: string | null;
} {
  const clang = firstExisting([
    '/opt/homebrew/opt/llvm/bin/clang',
    '/usr/local/opt/llvm/bin/clang',
  ]);
  const includeRoot = firstExisting([
    '/opt/homebrew/opt/llvm/lib/clang',
    '/usr/local/opt/llvm/lib/clang',
  ]);
  let includeDir: string | null = null;
  if (includeRoot && existsSync(includeRoot)) {
    for (const version of readdirSorted(includeRoot)) {
      const candidate = join(includeRoot, version, 'include');
      if (existsSync(candidate)) {
        includeDir = candidate;
        break;
      }
    }
  }
  return {
    clang,
    ld: firstExisting(['/opt/homebrew/bin/ld.lld', '/usr/local/bin/ld.lld']),
    qemu: firstExisting([
      '/opt/homebrew/bin/qemu-system-arm',
      '/usr/local/bin/qemu-system-arm',
    ]),
    includeDir,
  };
}

function readdirSorted(directory: string): string[] {
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    return readdirSync(directory).sort().reverse();
  } catch {
    return [];
  }
}

export function embeddedRuntimeReadiness(): string[] {
  const toolchain = embeddedToolchain();
  const missing = [
    toolchain.clang ? null : 'clang',
    toolchain.ld ? null : 'ld.lld',
    toolchain.qemu ? null : 'qemu-system-arm',
    toolchain.includeDir ? null : 'clang builtin includes',
  ].filter((entry): entry is string => entry !== null);
  return missing.length
    ? [`${EMBEDDED_RUNTIME_BLOCKER}. Missing: ${missing.join(', ')}`]
    : [];
}

const STARTUP = `#include <stdint.h>
extern int main(void);
extern uint32_t __stack_top, __bss_start__, __bss_end__;
void reset_handler(void);
void fault_handler(void);
void producer_isr(void);

__attribute__((section(".vectors"), used))
void (*const vectors[16 + 16])(void) = {
  [0] = (void (*)(void))&__stack_top,
  [1] = reset_handler,
  [2 ... 14] = fault_handler,
  [15] = producer_isr,           /* SysTick exception 15 */
  [16 ... 31] = fault_handler,
};

void fault_handler(void) {
  register int r0 __asm__("r0") = 0x04;
  register void *r1 __asm__("r1") = (void *)"FAULT\\n";
  __asm__ volatile ("bkpt 0xab" : "+r"(r0) : "r"(r1) : "memory");
  for (;;) __asm__ volatile ("nop");
}

void reset_handler(void) {
  for (uint32_t *p = &__bss_start__; p < &__bss_end__; p++) *p = 0;
  main();
  for (;;) __asm__ volatile ("nop");
}
`;

const LINKER_SCRIPT = `MEMORY { FLASH (rx) : ORIGIN = 0x00000000, LENGTH = 256K
         RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
ENTRY(reset_handler)
SECTIONS {
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) } > FLASH
  .data : { *(.data*) } > RAM AT > FLASH
  .bss (NOLOAD) : { __bss_start__ = .; *(.bss*) *(COMMON) __bss_end__ = .; } > RAM
  .stack (NOLOAD) : { . = ALIGN(8); . = . + 0x2000; __stack_top = .; } > RAM
}
`;

/** Arm semihosting, used by every firmware here for file IO and exit. */
const SEMIHOSTING_C = `#include <stdint.h>

static int sh_call(int op, void *arg) {
  register int r0 __asm__("r0") = op;
  register void *r1 __asm__("r1") = arg;
  __asm__ volatile ("bkpt 0xab" : "+r"(r0) : "r"(r1) : "memory");
  return r0;
}

static __attribute__((noinline)) uint32_t slen(const char *s) {
  uint32_t n = 0;
  while (s[n]) n++;
  return n;
}

static void io_out(const char *s) { sh_call(0x04, (void *)s); }

static void io_finish(int code) {
  uint32_t block[2] = { 0x20026u, (uint32_t)code };
  sh_call(0x20, block);
  for (;;) __asm__ volatile ("nop");
}

static void io_put_u32(uint32_t value) {
  char digits[12];
  int count = 0;
  if (!value) digits[count++] = '0';
  while (value) { digits[count++] = (char)('0' + value % 10u); value /= 10u; }
  char text[12];
  for (int i = 0; i < count; i++) text[i] = digits[count - 1 - i];
  text[count] = 0;
  io_out(text);
}

static int io_open(const char *path, int mode) {
  uint32_t block[3] = { (uint32_t)(uintptr_t)path, (uint32_t)mode, slen(path) };
  return sh_call(0x01, block);
}

static int io_write(int handle, const void *buffer, uint32_t length) {
  uint32_t block[3] = { (uint32_t)handle, (uint32_t)(uintptr_t)buffer, length };
  return sh_call(0x05, block);
}

static int io_read(int handle, void *buffer, uint32_t length) {
  uint32_t block[3] = { (uint32_t)handle, (uint32_t)(uintptr_t)buffer, length };
  return sh_call(0x06, block);
}

static int io_close(int handle) { return sh_call(0x02, &handle); }

typedef struct { char data[256]; uint32_t at; } report_line;

static void report_start(report_line *line, const char *tag) {
  line->at = 0;
  for (uint32_t i = 0; tag[i]; i++) line->data[line->at++] = tag[i];
}

static void report_text(report_line *line, const char *text) {
  for (uint32_t i = 0; text[i] && line->at < 240u; i++) line->data[line->at++] = text[i];
}

static void report_u32(report_line *line, uint32_t value) {
  char digits[12];
  int count = 0;
  if (!value) digits[count++] = '0';
  while (value) { digits[count++] = (char)('0' + value % 10u); value /= 10u; }
  while (count && line->at < 240u) line->data[line->at++] = digits[--count];
}

static void report_key(report_line *line, const char *key, uint32_t value) {
  report_text(line, " ");
  report_text(line, key);
  report_text(line, "=");
  report_u32(line, value);
}

static void report_finish(report_line *line) {
  line->data[line->at++] = '\\n';
  line->data[line->at] = 0;
  int handle = io_open("result.txt", 4);
  if (handle >= 0) { io_write(handle, line->data, line->at); io_close(handle); }
  io_out(line->data);
}

static int io_read_file(const char *path, char *buffer, uint32_t capacity) {
  int handle = io_open(path, 0);
  if (handle < 0) return -1;
  int read = io_read(handle, buffer, capacity - 1);
  io_close(handle);
  if (read < 0) read = 0;
  buffer[read] = 0;
  return read;
}
`;

/** Harness-owned flash port for the persistence scenario. The candidate never
 * touches persistent storage directly: every erase and program goes through this
 * port, which journals the operation and dies when the power budget is spent. */
const FLASH_PORT_C = `${SEMIHOSTING_C}
#include "board.h"

static uint8_t shadow[FLASH_TOTAL];
static uint32_t wear_count[FLASH_PAGE_COUNT];
static uint32_t remaining_ops;
static int journal_handle = -1;

static void io_append_u32(char *out, uint32_t value) {
  char digits[11];
  int count = 0;
  if (!value) digits[count++] = '0';
  while (value) { digits[count++] = (char)('0' + value % 10u); value /= 10u; }
  for (int i = 0; i < count; i++) out[i] = digits[count - 1 - i];
  out[count] = 0;
}

static void io_append_hex(char *out, const uint8_t *data, uint32_t length) {
  const char *digits = "0123456789abcdef";
  for (uint32_t i = 0; i < length; i++) {
    out[i * 2] = digits[data[i] >> 4];
    out[i * 2 + 1] = digits[data[i] & 0xf];
  }
  out[length * 2] = 0;
}

/* The budget is consumed before the operation starts: when it is exhausted the
 * device dies exactly at that erase or program, which is what a brownout does. */
static void consume_power(void) {
  if (!remaining_ops) {
    io_out("POWERFAIL\\n");
    io_finish(9);
  }
  remaining_ops--;
}

void flash_port_init(void) {
  int image = io_open("flash.img", 0);
  if (image >= 0) {
    io_read(image, shadow, FLASH_TOTAL);
    io_close(image);
  } else {
    for (uint32_t i = 0; i < FLASH_TOTAL; i++) shadow[i] = 0xff;
  }
  char text[16];
  int read = io_read_file("power.txt", text, sizeof text);
  remaining_ops = 0;
  if (read > 0) {
    uint32_t value = 0;
    for (int i = 0; i < read; i++)
      if (text[i] >= '0' && text[i] <= '9') value = value * 10u + (uint32_t)(text[i] - '0');
    remaining_ops = value;
  }
  journal_handle = io_open("ops.log", 8);
}

int flash_port_erase(uint32_t page) {
  if (page >= FLASH_PAGE_COUNT) return -1;
  consume_power();
  char line[32] = "E ";
  char number[11];
  io_append_u32(number, page);
  uint32_t at = 2;
  for (uint32_t i = 0; number[i]; i++) line[at++] = number[i];
  line[at++] = '\\n';
  io_write(journal_handle, line, at);
  for (uint32_t i = 0; i < FLASH_PAGE_SIZE; i++) shadow[page * FLASH_PAGE_SIZE + i] = 0xff;
  wear_count[page]++;
  return 0;
}

int flash_port_program(uint32_t page, uint32_t offset, const void *data, uint32_t length) {
  if (page >= FLASH_PAGE_COUNT || offset + length > FLASH_PAGE_SIZE) return -1;
  const uint8_t *bytes = (const uint8_t *)data;
  for (uint32_t done = 0; done < length; done += 32u) {
    uint32_t chunk = length - done < 32u ? length - done : 32u;
    consume_power();
    char line[24 + 2 * 32];
    char number[11];
    uint32_t at = 0;
    line[at++] = 'P';
    line[at++] = ' ';
    io_append_u32(number, page);
    for (uint32_t i = 0; number[i]; i++) line[at++] = number[i];
    line[at++] = ' ';
    io_append_u32(number, offset + done);
    for (uint32_t i = 0; number[i]; i++) line[at++] = number[i];
    line[at++] = ' ';
    io_append_u32(number, chunk);
    for (uint32_t i = 0; number[i]; i++) line[at++] = number[i];
    line[at++] = ' ';
    io_append_hex(&line[at], bytes + done, chunk);
    at += chunk * 2;
    line[at++] = '\\n';
    io_write(journal_handle, line, at);
    for (uint32_t i = 0; i < chunk; i++)
      shadow[page * FLASH_PAGE_SIZE + offset + done + i] &= bytes[done + i];
  }
  return 0;
}

void flash_port_read(uint32_t page, uint32_t offset, void *destination, uint32_t length) {
  const uint8_t *source = &shadow[page * FLASH_PAGE_SIZE + offset];
  uint8_t *out = (uint8_t *)destination;
  for (uint32_t i = 0; i < length; i++) out[i] = source[i];
}

uint32_t flash_port_wear(uint32_t page) {
  return page < FLASH_PAGE_COUNT ? wear_count[page] : 0;
}
`;

const EMBEDDED_BOARD_H = `#ifndef BOARD_H
#define BOARD_H
#include <stdint.h>

#define FLASH_PAGE_SIZE ${FLASH_PAGE_SIZE}u
#define FLASH_PAGE_COUNT ${FLASH_PAGE_COUNT}u
#define FLASH_TOTAL (FLASH_PAGE_SIZE * FLASH_PAGE_COUNT)
#define RING_CAPACITY ${RING_CAPACITY}u

void flash_port_init(void);
int flash_port_erase(uint32_t page);
int flash_port_program(uint32_t page, uint32_t offset, const void *data, uint32_t length);
void flash_port_read(uint32_t page, uint32_t offset, void *destination, uint32_t length);
uint32_t flash_port_wear(uint32_t page);
#endif
`;

const CONFIG_STORE_H = `#ifndef CONFIG_STORE_H
#define CONFIG_STORE_H
#include <stdint.h>

#define CONFIG_SCHEMA_LEGACY 1u
#define CONFIG_SCHEMA_CURRENT 2u

typedef struct {
  uint32_t schema;
  uint32_t seq;
  uint32_t baud;
  uint32_t mode;
  uint32_t flags;
} config_record;

/* Load the newest committed record.
 *   1  a committed record was loaded into out
 *   0  no committed record exists yet
 *  -1  only torn or corrupt records were found                              */
int config_load(config_record *out);

/* Durably commit one record. Returns 0 on success, negative on failure. */
int config_save(const config_record *in);

#endif
`;

const EMBEDDED_MAIN_1 = `${SEMIHOSTING_C}
#include "board.h"
#include "config_store.h"

typedef struct { const char *cursor; } parser;

static void skip_space(parser *p) { while (*p->cursor == ' ') p->cursor++; }

static uint32_t parse_u32(parser *p) {
  skip_space(p);
  uint32_t value = 0;
  int any = 0;
  while (*p->cursor >= '0' && *p->cursor <= '9') {
    value = value * 10u + (uint32_t)(*p->cursor - '0');
    p->cursor++;
    any = 1;
  }
  return any ? value : 0xffffffffu;
}

static int expect_word(parser *p, const char *word) {
  skip_space(p);
  for (uint32_t i = 0; word[i]; i++) if (p->cursor[i] != word[i]) return 0;
  p->cursor += slen(word);
  return 1;
}

int main(void) {
  flash_port_init();
  char command[128];
  if (io_read_file("command.txt", command, sizeof command) <= 0) {
    io_out("RESULT error=no-command\\n");
    io_finish(2);
  }
  parser p = { command };
  report_line line;
  if (expect_word(&p, "load")) {
    config_record record;
    int status = config_load(&record);
    report_start(&line, "RESULT load");
    report_key(&line, "status", (uint32_t)status);
    if (status == 1) {
      report_key(&line, "seq", record.seq);
      report_key(&line, "schema", record.schema);
      report_key(&line, "baud", record.baud);
      report_key(&line, "mode", record.mode);
      report_key(&line, "flags", record.flags);
    }
    report_finish(&line);
    io_finish(0);
  }
  if (expect_word(&p, "save")) {
    config_record record;
    record.schema = CONFIG_SCHEMA_CURRENT;
    record.seq = 0;
    record.baud = parse_u32(&p);
    record.mode = parse_u32(&p);
    record.flags = parse_u32(&p);
    int status = config_save(&record);
    report_start(&line, "RESULT save");
    report_key(&line, "status", (uint32_t)status);
    report_key(&line, "wear0", flash_port_wear(0));
    report_key(&line, "wear1", flash_port_wear(1));
    report_finish(&line);
    io_finish(0);
  }
  report_start(&line, "RESULT error");
  report_text(&line, " unknown-command");
  report_finish(&line);
  io_finish(3);
  return 0;
}
`;

const CONFIG_STORE_STARTER = `#include <stddef.h>
#include "board.h"
#include "config_store.h"

#define MAGIC 0x3147434Bu

typedef struct {
  uint32_t magic;
  uint32_t schema;
  uint32_t seq;
  uint32_t baud;
  uint32_t mode;
  uint32_t flags;
  uint32_t crc;
  uint32_t tail;
} stored_record;

static uint32_t crc32(const uint8_t *data, uint32_t length) {
  uint32_t crc = 0xffffffffu;
  for (uint32_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
  }
  return crc ^ 0xffffffffu;
}

int config_load(config_record *out) {
  stored_record record;
  flash_port_read(0, 0, &record, sizeof record);
  if (record.magic != MAGIC) return 0;
  if (crc32((const uint8_t *)&record, offsetof(stored_record, crc)) != record.crc) return -1;
  out->schema = record.schema;
  out->seq = record.seq;
  out->baud = record.baud;
  out->mode = record.mode;
  out->flags = record.flags;
  return 1;
}

int config_save(const config_record *in) {
  stored_record record;
  config_record previous;
  uint32_t seq = config_load(&previous) == 1 ? previous.seq + 1 : 1;
  record.magic = MAGIC;
  record.schema = CONFIG_SCHEMA_CURRENT;
  record.seq = seq;
  record.baud = in->baud;
  record.mode = in->mode;
  record.flags = in->flags;
  record.crc = crc32((const uint8_t *)&record, offsetof(stored_record, crc));
  record.tail = 0xffffffffu;
  if (flash_port_erase(0) < 0) return -2;
  if (flash_port_program(0, 0, &record, sizeof record) < 0) return -3;
  return 0;
}
`;

const STARTUP_FLASH = `#include <stdint.h>
extern int main(void);
extern uint32_t __stack_top, __bss_start__, __bss_end__;
void reset_handler(void);
void fault_handler(void);

__attribute__((section(".vectors"), used))
void (*const vectors[16])(void) = {
  [0] = (void (*)(void))&__stack_top,
  [1] = reset_handler,
  [2 ... 15] = fault_handler,
};

void fault_handler(void) {
  register int r0 __asm__("r0") = 0x04;
  register void *r1 __asm__("r1") = (void *)"FAULT\\n";
  __asm__ volatile ("bkpt 0xab" : "+r"(r0) : "r"(r1) : "memory");
  for (;;) __asm__ volatile ("nop");
}

void reset_handler(void) {
  for (uint32_t *p = &__bss_start__; p < &__bss_end__; p++) *p = 0;
  main();
  for (;;) __asm__ volatile ("nop");
}
`;

const RING_H = `#ifndef RING_H
#define RING_H
#include <stdint.h>

/* Single producer in interrupt context and a single consumer in the main loop.
 * ring_push must not block, allocate, or read the ring's own memory holes. */
void ring_init(void);

/* Returns 1 when the byte was stored, 0 when it was rejected. */
int ring_push(uint8_t byte);

/* Returns 1 when a byte was taken, 0 when the ring was empty. */
int ring_pop(uint8_t *byte);

/* Total bytes rejected since ring_init. */
uint32_t ring_overflows(void);

#endif
`;

const RING_REFERENCE = `#include "board.h"
#include "ring.h"

static volatile uint8_t buffer[RING_CAPACITY];
static volatile uint16_t head;
static volatile uint16_t tail;
static volatile uint32_t overflows;

void ring_init(void) {
  head = 0;
  tail = 0;
  overflows = 0;
}

int ring_push(uint8_t byte) {
  uint16_t next = (uint16_t)((head + 1u) % RING_CAPACITY);
  if (next == tail) {
    overflows++;
    return 0;
  }
  buffer[head] = byte;
  head = next;
  return 1;
}

int ring_pop(uint8_t *byte) {
  if (tail == head) return 0;
  *byte = buffer[tail];
  tail = (uint16_t)((tail + 1u) % RING_CAPACITY);
  return 1;
}

uint32_t ring_overflows(void) { return overflows; }
`;

const RING_STARTER = `#include "board.h"
#include "ring.h"

static volatile uint8_t buffer[RING_CAPACITY];
static volatile uint8_t head;
static volatile uint8_t tail;
static uint32_t overflows;

void ring_init(void) {
  head = 0;
  tail = 0;
}

int ring_push(uint8_t byte) {
  uint8_t next = (uint8_t)((head + 1u) % RING_CAPACITY);
  if (next == tail) return 0;
  buffer[head] = byte;
  head = next;
  return 1;
}

int ring_pop(uint8_t *byte) {
  if (tail == head) return 0;
  *byte = buffer[tail];
  tail = (uint8_t)((tail + 1u) % RING_CAPACITY);
  return 1;
}

uint32_t ring_overflows(void) { return overflows; }
`;

const PRODUCER_H = `#ifndef PRODUCER_H
#define PRODUCER_H
#include <stdint.h>
void producer_init(uint32_t bytes_per_tick);
uint32_t producer_max_isr_cycles(void);
uint32_t producer_isr_count(void);
uint32_t producer_pushed(void);
#endif
`;

const PRODUCER_C = `#include "board.h"
#include "corpus.h"
#include "producer.h"
#include "ring.h"

#define SYST_CSR (*(volatile uint32_t *)0xE000E010)
#define SYST_RVR (*(volatile uint32_t *)0xE000E014)
#define SYST_CVR (*(volatile uint32_t *)0xE000E018)
#define SYST_RELOAD 250u

static volatile uint32_t max_cycles;
static volatile uint32_t isr_count;
static volatile uint32_t pushed;
static volatile uint32_t cursor;
static volatile uint32_t per_tick;

void producer_init(uint32_t bytes_per_tick) {
  per_tick = bytes_per_tick;
  cursor = 0;
  SYST_RVR = SYST_RELOAD - 1u;
  SYST_CVR = 0;
  SYST_CSR = 7u;
}

/* The producer runs as a real SysTick exception. Its duration is measured by the
 * harness-owned cycle counter around the candidate's push. */
__attribute__((used)) void producer_isr(void) {
  uint32_t started = SYST_CVR;
  isr_count++;
  for (uint32_t i = 0; i < per_tick; i++) {
    if (cursor >= CORPUS_BYTES) break;
    ring_push(corpus_byte(cursor));
    cursor++;
    pushed++;
  }
  uint32_t ended = SYST_CVR;
  uint32_t elapsed = started >= ended ? started - ended : started + (SYST_RELOAD - ended);
  if (elapsed > max_cycles) max_cycles = elapsed;
}

uint32_t producer_max_isr_cycles(void) { return max_cycles; }
uint32_t producer_isr_count(void) { return isr_count; }
uint32_t producer_pushed(void) { return pushed; }
`;

const EMBEDDED_MAIN_2 = `${SEMIHOSTING_C}
#include "board.h"
#include "corpus.h"
#include "producer.h"
#include "ring.h"

#define FRAME_START 0x02u
#define FRAME_END 0x03u
#define MAX_PAYLOAD 32u

static uint32_t read_number(const char *path, uint32_t fallback) {
  char text[16];
  if (io_read_file(path, text, sizeof text) <= 0) return fallback;
  uint32_t value = 0;
  int any = 0;
  for (int i = 0; text[i]; i++)
    if (text[i] >= '0' && text[i] <= '9') { value = value * 10u + (uint32_t)(text[i] - '0'); any = 1; }
  return any ? value : fallback;
}

int main(void) {
  corpus_init();
  ring_init();
  uint32_t per_tick = read_number("rate.txt", 1);
  uint32_t slow_spin = read_number("slow.txt", 0);
  producer_init(per_tick);

  uint32_t frames = 0, gaps = 0, badcrc = 0, expected = 0, last = 0, popped = 0, idle = 0;
  uint8_t payload[MAX_PAYLOAD];
  uint32_t payload_len = 0, payload_at = 0, state = 0;
  uint8_t checksum = 0;

  for (;;) {
    uint8_t byte;
    int progressed = 0;
    while (ring_pop(&byte)) {
      progressed = 1;
      popped++;
      if (state == 0) {
        if (byte == FRAME_START) state = 1;
      } else if (state == 1) {
        payload_len = byte;
        payload_at = 0;
        checksum = byte;
        state = payload_len <= MAX_PAYLOAD ? 2 : 0;
      } else if (state == 2) {
        if (payload_at < MAX_PAYLOAD) payload[payload_at] = byte;
        checksum ^= byte;
        if (++payload_at == payload_len) state = 3;
      } else if (state == 3) {
        if (byte == checksum) state = 4;
        else { badcrc++; state = 0; }
      } else {
        if (byte == FRAME_END) {
          uint32_t index = payload_len >= 2 ? (((uint32_t)payload[0] << 8) | payload[1]) : 0xffffffffu;
          if (frames != 0 && index != expected) gaps++;
          expected = index + 1;
          last = index;
          frames++;
        } else {
          badcrc++;
        }
        state = 0;
      }
    }
    if (slow_spin) for (volatile uint32_t spin = 0; spin < slow_spin; spin++) { }
    if (producer_pushed() >= CORPUS_BYTES && !progressed) {
      if (++idle > 500u) {
        report_line line;
        report_start(&line, "DONE");
        report_key(&line, "frames", frames);
        report_key(&line, "gaps", gaps);
        report_key(&line, "badcrc", badcrc);
        report_key(&line, "overruns", ring_overflows());
        report_key(&line, "pushed", producer_pushed());
        report_key(&line, "popped", popped);
        report_key(&line, "corpus", CORPUS_BYTES);
        report_key(&line, "last", last);
        report_key(&line, "maxisr", producer_max_isr_cycles());
        report_key(&line, "isrs", producer_isr_count());
        report_finish(&line);
        io_finish(0);
      }
    } else {
      idle = 0;
    }
  }
  return 0;
}
`;

const CORPUS_FRAMES = 120;

export function corpusFrameBytes(index: number): Buffer {
  const payload = Buffer.from([(index >> 8) & 0xff, index & 0xff, 0xa5, 0x5a]);
  const body = Buffer.concat([Buffer.from([payload.length]), payload]);
  let checksum = 0;
  for (const byte of body) checksum ^= byte;
  return Buffer.concat([Buffer.from([0x02]), body, Buffer.from([checksum, 0x03])]);
}

export function corpusBytes(): Buffer {
  const frames: Buffer[] = [];
  for (let index = 0; index < CORPUS_FRAMES; index++) frames.push(corpusFrameBytes(index));
  return Buffer.concat(frames);
}

interface FlashOp {
  kind: 'E' | 'P';
  page: number;
  offset: number;
  bytes: Buffer;
}

export interface FirmwareRun {
  stdout: string;
  result: string;
  ops: FlashOp[];
  exitCode: number | null;
}

function parseJournal(text: string): FlashOp[] {
  const ops: FlashOp[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts[0] === 'E') ops.push({ kind: 'E', page: Number(parts[1]), offset: 0, bytes: Buffer.alloc(0) });
    else if (parts[0] === 'P')
      ops.push({
        kind: 'P',
        page: Number(parts[1]),
        offset: Number(parts[2]),
        bytes: Buffer.from(parts[4] ?? '', 'hex'),
      });
  }
  return ops.filter((op) => Number.isInteger(op.page) && op.page >= 0);
}

/** Apply one journal entry with real NOR semantics: erase fills 0xFF, program
 * only clears bits, and a brownout in the middle of an operation applies it to
 * half of its bytes. */
function applyFlashOp(image: Buffer, op: FlashOp, fraction: number): void {
  const base = op.page * FLASH_PAGE_SIZE;
  if (op.kind === 'E') {
    const length = Math.floor(FLASH_PAGE_SIZE * fraction);
    for (let i = 0; i < length; i++) image[base + i] = 0xff;
    return;
  }
  const length = fraction >= 1 ? op.bytes.length : Math.floor(op.bytes.length * fraction);
  for (let i = 0; i < length; i++) image[base + op.offset + i] &= op.bytes[i]!;
}

/** Replay the journal up to `complete` full operations plus a torn operation. */
function replayFlash(previous: Buffer, ops: readonly FlashOp[], complete: number): Buffer {
  const image = Buffer.from(previous);
  for (let index = 0; index < complete && index < ops.length; index++) applyFlashOp(image, ops[index]!, 1);
  if (complete < ops.length) applyFlashOp(image, ops[complete]!, 0.5);
  return image;
}

function buildFirmware(root: string, sources: readonly string[]): { ok: boolean; log: string; elf: string } {
  const toolchain = embeddedToolchain();
  const elf = join(root, 'firmware.elf');
  if (!toolchain.clang || !toolchain.ld || !toolchain.includeDir) {
    return { ok: false, log: EMBEDDED_RUNTIME_BLOCKER, elf };
  }
  const common = [
    '--target=thumbv7m-none-eabi',
    '-mcpu=cortex-m4',
    '-mthumb',
    '-O2',
    '-ffreestanding',
    '-nostdlib',
    '-ffunction-sections',
    '-fdata-sections',
    '-fno-builtin',
    '-fno-common',
    '-isystem',
    toolchain.includeDir,
    '-I',
    join(root, 'src'),
  ];
  const objects: string[] = [];
  for (const source of sources) {
    const object = `${source}.o`;
    const compiled = spawnSync(toolchain.clang, [...common, '-c', join(root, 'src', source), '-o', join(root, object)], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (compiled.status !== 0) {
      return { ok: false, log: `${source}: ${compiled.stderr ?? compiled.stdout ?? 'compile failed'}`, elf };
    }
    objects.push(join(root, object));
  }
  const linked = spawnSync(
    toolchain.ld,
    ['-T', join(root, 'src', 'link.ld'), '--gc-sections', ...objects, '-o', elf],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (linked.status !== 0) return { ok: false, log: `link: ${linked.stderr ?? linked.stdout ?? 'link failed'}`, elf };
  return { ok: true, log: '', elf };
}

function runFirmware(
  root: string,
  options: { command?: string; rate?: number; slow?: number; power?: number; image?: Buffer },
): FirmwareRun {
  let last = bootFirmware(root, options);
  for (let attempt = 1; attempt <= 3 && last.stdout.startsWith('SPAWN-ERROR'); attempt++) {
    last = bootFirmware(root, options);
  }
  return last;
}

function bootFirmware(
  root: string,
  options: { command?: string; rate?: number; slow?: number; power?: number; image?: Buffer },
): FirmwareRun {
  const toolchain = embeddedToolchain();
  if (!toolchain.qemu) return { stdout: EMBEDDED_RUNTIME_BLOCKER, result: '', ops: [], exitCode: null };
  if (options.command !== undefined) writeFileSync(join(root, 'command.txt'), options.command);
  if (options.rate !== undefined) writeFileSync(join(root, 'rate.txt'), String(options.rate));
  if (options.slow !== undefined) writeFileSync(join(root, 'slow.txt'), String(options.slow));
  if (options.power !== undefined) writeFileSync(join(root, 'power.txt'), String(options.power));
  writeFileSync(join(root, 'flash.img'), options.image ?? Buffer.alloc(FLASH_TOTAL, 0xff));
  rmSync(join(root, 'ops.log'), { force: true });
  rmSync(join(root, 'result.txt'), { force: true });
  const run = spawnSync(
    toolchain.qemu,
    [
      '-machine',
      QEMU_MACHINE,
      '-cpu',
      'cortex-m4',
      '-display',
      'none',
      '-semihosting-config',
      'enable=on,target=native',
      '-kernel',
      join(root, 'firmware.elf'),
    ],
    { encoding: 'utf8', timeout: 120_000, cwd: root },
  );
  const spawnError = run.error ? `SPAWN-ERROR ${(run.error as NodeJS.ErrnoException).code ?? run.error.message}\n` : '';
  const stdout = `${spawnError}${run.stdout ?? ''}${run.stderr ?? ''}`;
  const reportPath = join(root, 'result.txt');
  const reported = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const resultMatch = /RESULT ([^\n]+)/u.exec(reported || stdout);
  const journalPath = join(root, 'ops.log');
  const ops = existsSync(journalPath) ? parseJournal(readFileSync(journalPath, 'utf8')) : [];
  return {
    stdout: `${reported}\n${stdout}`,
    result: resultMatch ? resultMatch[1]!.trim() : '',
    ops,
    exitCode: run.status,
  };
}

function numbersIn(result: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const match of result.matchAll(/([a-z0-9]+)=(-?\d+)/giu)) {
    values[match[1]!.toLowerCase()] = Number(match[2]);
  }
  return values;
}

const EMBEDDED_README_1 = `# Configuration store on a two-page flash device

You are changing \`config_store.c\` only. Everything under \`src/\` is owned by the
harness and is rewritten before scoring, so a change there has no effect.

The device has two flash pages of ${FLASH_PAGE_SIZE} bytes, no filesystem, and a
programming model with the physical rules: erasing a page sets it to 0xFF,
programming can only clear bits, and a brownout can stop the device after any
erase or program, leaving that operation half applied.

\`src/flash_port.c\` is the only path to persistent storage:

\`\`\`c
int flash_port_erase(uint32_t page);
int flash_port_program(uint32_t page, uint32_t offset, const void *data, uint32_t length);
void flash_port_read(uint32_t page, uint32_t offset, void *destination, uint32_t length);
\`\`\`

Every call consumes one operation from a power budget the harness sets before the
boot. When the budget is spent the device dies at that call. After a brownout the
harness replays the journal into a fresh image and boots again, exactly as a real
device would come back with whatever reached flash.

\`src/config_store.h\` is the contract you implement. \`config_load\` must return 1
with the newest committed record, 0 when nothing was ever committed, and -1 when
every record present is torn or corrupt. \`config_save\` must commit a record that
survives a brownout at any later erase or program.

The scored properties are: a committed record is loaded after reboot; a brownout
at every operation of a save never loses the previous committed record and never
yields a corrupt one; a partially programmed record never validates; wear is
spread across both pages; and a record written with the legacy schema still loads.

\`bash build.sh\` compiles the image. \`bash run.sh load\` and
\`bash run.sh save 115200 2 0\` boot it with a generous power budget.
`;

const EMBEDDED_README_2 = `# Interrupt producer feeding a fixed-capacity ring

You are changing \`ring.c\` only. Everything under \`src/\` is owned by the harness
and is rewritten before scoring.

The board runs a SysTick producer (a real interrupt at 10 microsecond intervals)
that pushes bytes from a compiled-in burst corpus into your ring, while the main
loop pops bytes and decodes frames of the form

\`\`\`
0x02 <payload length> <payload...> <xor checksum> 0x03
\`\`\`

The ring holds ${RING_CAPACITY} bytes. \`src/ring.h\` is the contract:
\`ring_init\`, \`ring_push\` (interrupt context), \`ring_pop\` (main loop), and
\`ring_overflows\`, which must count every byte rejected because the ring was full.

Two knobs the harness sets before each boot: \`rate.txt\` is how many bytes the
producer pushes per interrupt, and \`slow.txt\` is a busy-wait the consumer runs
between drains. A silent drop is the failure this task is about: the decoder then
sees a broken frame and loses synchronisation, and no counter explains it.

The scored properties are: a steady burst decodes every frame in order; a burst
large enough to wrap the ring many times still decodes every frame; when the
consumer is slowed until the ring overflows, the rejected bytes are counted and
\`pushed - popped == overruns\`; a fresh boot starts from a clean ring; and the
interrupt handler stays inside its cycle budget.

\`bash build.sh\` compiles the image, \`bash run.sh 4 0\` boots it with four bytes
per interrupt and a fast consumer.
`;

function writeBuildScript(destination: string, sources: readonly string[], candidate: string): void {
  const toolchain = embeddedToolchain();
  const clang = toolchain.clang ?? 'clang';
  const ld = toolchain.ld ?? 'ld.lld';
  const include = toolchain.includeDir ?? '/opt/homebrew/opt/llvm/lib/clang/23/include';
  writeFileSync(
    join(destination, 'build.sh'),
    `set -e
FLAGS="--target=thumbv7m-none-eabi -mcpu=cortex-m4 -mthumb -O2 -ffreestanding -nostdlib -ffunction-sections -fdata-sections -fno-builtin -fno-common -isystem ${include} -Isrc"
${sources.map((source) => `"${clang}" $FLAGS -c src/${source} -o ${source}.o`).join('\n')}
"${clang}" $FLAGS -c ${candidate} -o ${candidate}.o
"${ld}" -T src/link.ld --gc-sections ${sources.map((source) => `${source}.o`).join(' ')} ${candidate}.o -o firmware.elf
`,
    { mode: 0o755 },
  );
}

export function embeddedMaterialize(destination: string, scenario: 1 | 2): void {
  const src = join(destination, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'link.ld'), LINKER_SCRIPT);
  writeFileSync(join(src, 'board.h'), EMBEDDED_BOARD_H);
  if (scenario === 1) {
    writeFileSync(join(src, 'startup.c'), STARTUP_FLASH);
    writeFileSync(join(src, 'flash_port.c'), FLASH_PORT_C);
    writeFileSync(join(src, 'config_store.h'), CONFIG_STORE_H);
    writeFileSync(join(src, 'main.c'), EMBEDDED_MAIN_1);
    writeFileSync(join(destination, 'config_store.c'), CONFIG_STORE_STARTER);
    writeFileSync(join(destination, 'README.md'), EMBEDDED_README_1);
    writeBuildScript(destination, ['startup.c', 'flash_port.c', 'main.c'], 'config_store.c');
  } else {
    const corpus = corpusBytes();
    writeFileSync(
      join(src, 'corpus.c'),
      `#include "corpus.h"

static uint8_t corpus[CORPUS_BYTES];

/* One burst corpus, generated on the device with the same rule the harness uses:
 * 0x02 <length> <payload> <xor checksum> 0x03 over a four-byte index payload. */
void corpus_init(void) {
  uint32_t at = 0;
  for (uint32_t index = 0; index < CORPUS_FRAMES; index++) {
    corpus[at++] = 0x02u;
    corpus[at++] = 4u;
    uint8_t checksum = 4u;
    corpus[at++] = (uint8_t)(index >> 8);
    corpus[at++] = (uint8_t)index;
    corpus[at++] = 0xa5u;
    corpus[at++] = 0x5au;
    for (uint32_t i = 2; i < 6; i++) checksum ^= corpus[at - 6 + i];
    corpus[at++] = checksum;
    corpus[at++] = 0x03u;
  }
}

uint8_t corpus_byte(uint32_t offset) { return offset < CORPUS_BYTES ? corpus[offset] : 0u; }
`,
    );
    writeFileSync(
      join(src, 'corpus.h'),
      `#ifndef CORPUS_H\n#define CORPUS_H\n#include <stdint.h>\n#define CORPUS_FRAMES ${CORPUS_FRAMES}u\n#define CORPUS_BYTES ${corpus.length}u\nvoid corpus_init(void);\nuint8_t corpus_byte(uint32_t offset);\n#endif\n`,
    );
    writeFileSync(join(src, 'startup.c'), STARTUP);
    writeFileSync(join(src, 'producer.c'), PRODUCER_C);
    writeFileSync(join(src, 'producer.h'), PRODUCER_H);
    writeFileSync(join(src, 'ring.h'), RING_H);
    writeFileSync(join(src, 'main.c'), EMBEDDED_MAIN_2);
    writeFileSync(join(destination, 'ring.c'), RING_STARTER);
    writeFileSync(join(destination, 'README.md'), EMBEDDED_README_2);
    writeBuildScript(destination, ['startup.c', 'corpus.c', 'producer.c', 'main.c'], 'ring.c');
  }
  writeFileSync(join(destination, 'run.sh'), `set -e\n${join(destination, 'build.sh')}\n`, { mode: 0o755 });
  writeFileSync(join(destination, 'rate.txt'), '4');
  writeFileSync(join(destination, 'slow.txt'), '0');
  writeFileSync(join(destination, 'command.txt'), 'load');
  writeFileSync(join(destination, 'power.txt'), '1000');
}

export interface EmbeddedCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface EmbeddedResult {
  passed: boolean;
  checks: EmbeddedCheck[];
  evidence: string;
}

function restoreHarnessSources(root: string, scenario: 1 | 2): void {
  const staging = `${root}-harness`;
  rmSync(staging, { recursive: true, force: true });
  embeddedMaterialize(staging, scenario);
  const src = join(staging, 'src');
  const { readdirSync, copyFileSync } = require('node:fs') as typeof import('node:fs');
  for (const entry of readdirSync(src)) copyFileSync(join(src, entry), join(root, 'src', entry));
  rmSync(staging, { recursive: true, force: true });
}

function legacyRecord(seq: number, baud: number, mode: number, flags: number): Buffer {
  const record = Buffer.alloc(RECORD_BYTES, 0xff);
  record.writeUInt32LE(0x3147_434b, 0);
  record.writeUInt32LE(1, 4);
  record.writeUInt32LE(seq, 8);
  record.writeUInt32LE(baud, 12);
  record.writeUInt32LE(mode, 16);
  record.writeUInt32LE(flags, 20);
  let crc = 0xffff_ffff;
  for (let index = 0; index < 24; index++) {
    crc ^= record[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb8_8320 & (0 - (crc & 1)));
  }
  record.writeUInt32LE((crc ^ 0xffff_ffff) >>> 0, 24);
  return record;
}

export function runEmbeddedScenario1(root: string): EmbeddedResult {
  const checks: EmbeddedCheck[] = [];
  const evidence: string[] = [];
  if (embeddedRuntimeReadiness().length) return { passed: false, checks: [], evidence: embeddedRuntimeReadiness().join('\n') };

  restoreHarnessSources(root, 1);
  const { copyFileSync } = require('node:fs') as typeof import('node:fs');
  copyFileSync(join(root, 'config_store.c'), join(root, 'src', 'config_store.c'));
  const build = buildFirmware(root, ['startup.c', 'flash_port.c', 'main.c', 'config_store.c']);
  if (!build.ok) {
    return {
      passed: false,
      checks: [{ id: 'contract', passed: false, detail: `firmware build failed: ${build.log.slice(0, 400)}` }],
      evidence: build.log,
    };
  }

  let image = Buffer.alloc(FLASH_TOTAL, 0xff);
  const erases = [0, 0];
  const pagesUsedForProgram = new Set<number>();
  const fresh = runFirmware(root, { command: 'load', power: 1_000_000, image });
  const freshValues = numbersIn(fresh.result);
  checks.push({
    id: 'contract',
    passed: freshValues.status === 0,
    detail: `fresh device load reported ${fresh.result || `(no result; raw ${fresh.stdout.slice(0, 120)})`}; expected status=0`,
  });

  let persistsOk = true;
  let crossing: { ops: FlashOp[]; before: Buffer; seq: number; baud: number } | null = null;
  let firstSaveStatus: number | null = null;
  const baudOf = (seq: number) => 115_200 + seq;
  for (let seq = 1; seq <= COMMITS; seq++) {
    const before = Buffer.from(image);
    const baud = baudOf(seq);
    const save = runFirmware(root, { command: `save ${baud} ${seq % 4} ${seq}`, power: 1_000_000, image });
    const values = numbersIn(save.result);
    if (firstSaveStatus === null) firstSaveStatus = values.status ?? null;
    if (values.status !== 0) {
      persistsOk = false;
      evidence.push(`save ${seq} failed: ${save.result || '(no result)'}`);
      break;
    }
    if (!crossing && save.ops.some((op) => op.kind === 'E')) crossing = { ops: save.ops, before, seq, baud };
    for (const op of save.ops) {
      applyFlashOp(image, op, 1);
      if (op.kind === 'E') erases[op.page]! += 1;
      else pagesUsedForProgram.add(op.page);
    }
    if (seq % 16 === 0 || seq === 1) {
      const loaded = runFirmware(root, { command: 'load', power: 1_000_000, image });
      const loadedValues = numbersIn(loaded.result);
      if (loadedValues.status !== 1 || loadedValues.seq !== seq || loadedValues.baud !== baud) {
        persistsOk = false;
        evidence.push(`load after ${seq}: ${loaded.result || '(no result)'}`);
        break;
      }
    }
  }
  checks.push({
    id: 'persists',
    passed: persistsOk && firstSaveStatus === 0,
    detail: persistsOk
      ? `${COMMITS} commits each loaded back with their own sequence number and fields`
      : 'a commit did not survive a reboot',
  });

  if (crossing) {
    let newCommitted = 0;
    let previousCommitted = 0;
    const broken: string[] = [];
    for (let complete = 0; complete <= crossing.ops.length; complete++) {
      const torn = replayFlash(crossing.before, crossing.ops, complete);
      const loaded = runFirmware(root, { command: 'load', power: 1_000_000, image: torn });
      const values = numbersIn(loaded.result);
      if (values.status === 1 && values.seq === crossing.seq && values.baud === crossing.baud) newCommitted++;
      else if (values.status === 1 && values.seq === crossing.seq - 1 && values.baud === baudOf(crossing.seq - 1))
        previousCommitted++;
      else broken.push(`complete=${complete}: ${loaded.result || '(no result)'}`);
    }
    checks.push({
      id: 'brownout-sweep',
      passed: broken.length === 0 && newCommitted + previousCommitted === crossing.ops.length + 1,
      detail: `erase-crossing save interrupted at each of ${crossing.ops.length + 1} points: new=${newCommitted} previous=${previousCommitted} broken=${broken.length}${broken.length ? ` (${broken[0]})` : ''}`,
    });
    const tornProgram = replayFlash(crossing.before, crossing.ops, crossing.ops.length - 1);
    const tornLoad = runFirmware(root, { command: 'load', power: 1_000_000, image: tornProgram });
    const tornValues = numbersIn(tornLoad.result);
    checks.push({
      id: 'torn-write',
      passed: tornValues.status === 1 && tornValues.seq === crossing.seq - 1 && tornValues.baud === baudOf(crossing.seq - 1),
      detail: `half-programmed record: ${tornLoad.result || '(no result)'} (expected the previous committed record)`,
    });
  } else {
    checks.push({ id: 'brownout-sweep', passed: false, detail: `no page erase happened during ${COMMITS} commits` });
    checks.push({ id: 'torn-write', passed: false, detail: `no page erase happened during ${COMMITS} commits` });
  }

  const wearBalanced = Math.abs(erases[0]! - erases[1]!) <= 1 && erases[0]! + erases[1]! >= 2;
  checks.push({
    id: 'wear-rotation',
    passed: wearBalanced && pagesUsedForProgram.size === FLASH_PAGE_COUNT,
    detail: `erase counts per page ${erases.join('/')} after ${COMMITS} commits, records programmed into ${pagesUsedForProgram.size} page(s)`,
  });

  const legacyImage = Buffer.alloc(FLASH_TOTAL, 0xff);
  legacyRecord(7, 9_600, 3, 0).copy(legacyImage, 0);
  const legacyLoad = runFirmware(root, { command: 'load', power: 1_000_000, image: legacyImage });
  const legacyValues = numbersIn(legacyLoad.result);
  checks.push({
    id: 'legacy-schema',
    passed:
      legacyValues.status === 1 &&
      legacyValues.schema === 1 &&
      legacyValues.seq === 7 &&
      legacyValues.baud === 9_600,
    detail: `legacy schema 1 record: ${legacyLoad.result || '(no result)'}`,
  });

  const passed = checks.length > 0 && checks.every((check) => check.passed);
  return { passed, checks, evidence: evidence.join('\n').slice(-3000) };
}

export function runEmbeddedScenario2(root: string): EmbeddedResult {
  const checks: EmbeddedCheck[] = [];
  const evidence: string[] = [];
  if (embeddedRuntimeReadiness().length) return { passed: false, checks: [], evidence: embeddedRuntimeReadiness().join('\n') };

  restoreHarnessSources(root, 2);
  const { copyFileSync } = require('node:fs') as typeof import('node:fs');
  copyFileSync(join(root, 'ring.c'), join(root, 'src', 'ring.c'));
  const build = buildFirmware(root, ['startup.c', 'corpus.c', 'producer.c', 'main.c', 'ring.c']);
  if (!build.ok) {
    return {
      passed: false,
      checks: [{ id: 'contract', passed: false, detail: `firmware build failed: ${build.log.slice(0, 400)}` }],
      evidence: build.log,
    };
  }

  const expectedBytes = corpusBytes().length;
  const steady = runFirmware(root, { rate: 4, slow: 0 });
  const steadyDone = numbersIn(/DONE ([^\n]+)/u.exec(steady.stdout)?.[1] ?? '');
  const wraps = runFirmware(root, { rate: 8, slow: 0 });
  const wrapsDone = numbersIn(/DONE ([^\n]+)/u.exec(wraps.stdout)?.[1] ?? '');
  const overflow = runFirmware(root, { rate: 64, slow: 800 });
  const overflowDone = numbersIn(/DONE ([^\n]+)/u.exec(overflow.stdout)?.[1] ?? '');
  const restart = runFirmware(root, { rate: 4, slow: 0 });
  const restartDone = numbersIn(/DONE ([^\n]+)/u.exec(restart.stdout)?.[1] ?? '');

  const ranAtAll = Number.isFinite(steadyDone.frames);
  checks.push({
    id: 'contract',
    passed: ranAtAll,
    detail: ranAtAll
      ? `firmware booted and ran to completion with ${steadyDone.frames} frames`
      : `firmware produced no summary: ${steady.stdout.slice(0, 200)}`,
  });
  checks.push({
    id: 'framing-intact',
    passed:
      steadyDone.frames === CORPUS_FRAMES && steadyDone.gaps === 0 && steadyDone.badcrc === 0 && steadyDone.overruns === 0,
    detail: `four bytes per interrupt: frames=${steadyDone.frames ?? 'n/a'}/${CORPUS_FRAMES} gaps=${steadyDone.gaps ?? 'n/a'} badcrc=${steadyDone.badcrc ?? 'n/a'} overruns=${steadyDone.overruns ?? 'n/a'}`,
  });
  checks.push({
    id: 'wrap',
    passed: wrapsDone.frames === CORPUS_FRAMES && wrapsDone.gaps === 0 && wrapsDone.badcrc === 0,
    detail: `eight bytes per interrupt (about ${Math.round(expectedBytes / RING_CAPACITY)} ring wraps): frames=${wrapsDone.frames ?? 'n/a'}/${CORPUS_FRAMES} gaps=${wrapsDone.gaps ?? 'n/a'} badcrc=${wrapsDone.badcrc ?? 'n/a'}`,
  });
  const accounted =
    (overflowDone.overruns ?? 0) > 0 &&
    (overflowDone.pushed ?? -1) - (overflowDone.popped ?? -2) === overflowDone.overruns;
  checks.push({
    id: 'overflow-accounted',
    passed: accounted,
    detail: `slow consumer: overruns=${overflowDone.overruns ?? 'n/a'} pushed=${overflowDone.pushed ?? 'n/a'} popped=${overflowDone.popped ?? 'n/a'} (pushed - popped must equal overruns)`,
  });
  checks.push({
    id: 'restart-clean',
    passed:
      restartDone.frames === CORPUS_FRAMES && restartDone.gaps === 0 && restartDone.overruns === 0,
    detail: `fresh boot after an overflow: frames=${restartDone.frames ?? 'n/a'}/${CORPUS_FRAMES} overruns=${restartDone.overruns ?? 'n/a'}`,
  });
  const isrCycles = Math.max(
    steadyDone.maxisr ?? 0,
    wrapsDone.maxisr ?? 0,
    overflowDone.maxisr ?? 0,
    restartDone.maxisr ?? 0,
  );
  checks.push({
    id: 'isr-bounded',
    passed: isrCycles > 0 && isrCycles <= 400,
    detail: `longest interrupt handler measured at ${isrCycles} cycles (limit 400, push clocked by the cycle counter)`,
  });

  evidence.push(
    `steady: ${steadyDone.frames ?? 'n/a'} frames, ${steadyDone.overruns ?? 'n/a'} overruns, max isr ${steadyDone.maxisr ?? 'n/a'} cycles`,
    `four-per-tick: ${wrapsDone.frames ?? 'n/a'} frames, max isr ${wrapsDone.maxisr ?? 'n/a'} cycles`,
    `slow consumer: ${overflowDone.frames ?? 'n/a'} frames, ${overflowDone.overruns ?? 'n/a'} overruns, ${overflowDone.pushed ?? 'n/a'} pushed, ${overflowDone.popped ?? 'n/a'} popped`,
  );

  const passed = checks.length > 0 && checks.every((check) => check.passed);
  return { passed, checks, evidence: evidence.join('\n').slice(-3000) };
}

function embeddedScore(result: EmbeddedResult): {
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

export const EMBEDDED_RUNTIME_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'embedded-firmware/brownout-flash-journal@1',
    realRuntime: true,
    readinessBlockers: embeddedRuntimeReadiness(),
    matches: (scenario) => scenario.id === EMBEDDED_SCENARIO_1,
    materialize: (destination) => embeddedMaterialize(destination, 1),
  },
  {
    id: 'embedded-firmware/isr-ring-buffer@1',
    realRuntime: true,
    readinessBlockers: embeddedRuntimeReadiness(),
    matches: (scenario) => scenario.id === EMBEDDED_SCENARIO_2,
    materialize: (destination) => embeddedMaterialize(destination, 2),
  },
];

export const EMBEDDED_RUNTIME_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'embedded-firmware/brownout-flash-journal-scorer@1',
    scenarioIds: [EMBEDDED_SCENARIO_1],
    score: async ({ workingDirectory }) => embeddedScore(runEmbeddedScenario1(workingDirectory)),
  },
  {
    id: 'embedded-firmware/isr-ring-buffer-scorer@1',
    scenarioIds: [EMBEDDED_SCENARIO_2],
    score: async ({ workingDirectory }) => embeddedScore(runEmbeddedScenario2(workingDirectory)),
  },
];
