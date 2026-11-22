import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, afterEach, test } from 'bun:test';
import {
  EMBEDDED_RUNTIME_MATERIALIZERS,
  EMBEDDED_RUNTIME_SCORERS,
  EMBEDDED_SCENARIO_1,
  EMBEDDED_SCENARIO_2,
  corpusBytes,
  corpusFrameBytes,
  embeddedMaterialize,
  embeddedRuntimeReadiness,
  runEmbeddedScenario1,
  runEmbeddedScenario2,
} from '../../eval/skills/skill-eval-embedded-runtime';

/**
 * Both scenarios are executed on an emulated Cortex-M4, so these tests are the
 * only thing standing between the fixture and a workspace that cannot
 * discriminate. The starter must fail for the reason the scenario names, and a
 * correct implementation must satisfy every check on the same build, the same
 * power budget and the same corpus.
 */

const REFERENCE_STORE = `#include <stddef.h>
#include "board.h"
#include "config_store.h"

#define MAGIC 0x3147434Bu
#define SLOTS (FLASH_PAGE_SIZE / sizeof(stored_record))

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

static int slot_valid(uint32_t page, uint32_t slot, stored_record *out) {
  stored_record record;
  flash_port_read(page, slot * sizeof record, &record, sizeof record);
  if (record.magic != MAGIC) return 0;
  if (record.tail != 0xffffffffu) return 0;
  if (crc32((const uint8_t *)&record, offsetof(stored_record, crc)) != record.crc) return 0;
  if (out) *out = record;
  return 1;
}

int config_load(config_record *out) {
  int found = 0;
  int saw_broken = 0;
  uint32_t best_seq = 0;
  stored_record best;
  for (uint32_t page = 0; page < FLASH_PAGE_COUNT; page++) {
    for (uint32_t slot = 0; slot < SLOTS; slot++) {
      stored_record record;
      flash_port_read(page, slot * sizeof record, &record, sizeof record);
      if (record.magic == 0xffffffffu) continue;
      if (!slot_valid(page, slot, &record)) { saw_broken = 1; continue; }
      if (!found || record.seq > best_seq) { best = record; best_seq = record.seq; found = 1; }
    }
  }
  if (!found) return saw_broken ? -1 : 0;
  out->schema = best.schema;
  out->seq = best.seq;
  out->baud = best.baud;
  out->mode = best.mode;
  out->flags = best.flags;
  return 1;
}

int config_save(const config_record *in) {
  config_record previous;
  uint32_t seq = config_load(&previous) == 1 ? previous.seq + 1 : 1;
  uint32_t active = 0xffffffffu;
  uint32_t next_slot = 0;
  uint32_t best_seq = 0;
  for (uint32_t page = 0; page < FLASH_PAGE_COUNT; page++) {
    uint32_t used = 0;
    for (uint32_t slot = 0; slot < SLOTS; slot++) {
      stored_record record;
      flash_port_read(page, slot * sizeof record, &record, sizeof record);
      if (record.magic == 0xffffffffu) break;
      used = slot + 1;
      if (slot_valid(page, slot, &record) && record.seq >= best_seq) { best_seq = record.seq; active = page; }
    }
    if (page == active) next_slot = used;
  }
  uint32_t target = active == 0xffffffffu ? 0 : active;
  next_slot = active == 0xffffffffu ? 0 : next_slot;
  if (next_slot >= SLOTS) {
    target = active == 0 ? 1 : 0;
    if (flash_port_erase(target) < 0) return -2;
    next_slot = 0;
  }
  stored_record record;
  record.magic = MAGIC;
  record.schema = CONFIG_SCHEMA_CURRENT;
  record.seq = seq;
  record.baud = in->baud;
  record.mode = in->mode;
  record.flags = in->flags;
  record.tail = 0xffffffffu;
  record.crc = crc32((const uint8_t *)&record, offsetof(stored_record, crc));
  if (flash_port_program(target, next_slot * sizeof record, &record, sizeof record) < 0) return -3;
  return 0;
}
`;

const REFERENCE_RING = `#include "board.h"
#include "ring.h"

static volatile uint8_t buffer[RING_CAPACITY];
static volatile uint16_t head;
static volatile uint16_t tail;
static volatile uint32_t overflows;

void ring_init(void) { head = 0; tail = 0; overflows = 0; }

int ring_push(uint8_t byte) {
  uint16_t next = (uint16_t)((head + 1u) % RING_CAPACITY);
  if (next == tail) { overflows++; return 0; }
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

const workspaces: string[] = [];

function workspace(scenario: 1 | 2, source: string | null): string {
  const directory = mkdtempSync(join(tmpdir(), `kory-embedded-${scenario}-`));
  workspaces.push(directory);
  embeddedMaterialize(directory, scenario);
  if (source !== null) writeFileSync(join(directory, scenario === 1 ? 'config_store.c' : 'ring.c'), source);
  return directory;
}

afterEach(() => {
  while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

const readiness = embeddedRuntimeReadiness();
const describeIf = readiness.length ? describe.skip : describe;

describe('embedded firmware corpus', () => {
  test('frames carry a checksum the guest decoder recomputes', () => {
    const frame = corpusFrameBytes(258);
    expect(frame[0]).toBe(0x02);
    expect(frame[1]).toBe(4);
    expect([...frame.subarray(2, 6)]).toEqual([0x01, 0x02, 0xa5, 0x5a]);
    let checksum = 0;
    for (const byte of frame.subarray(1, 6)) checksum ^= byte;
    expect(frame[6]).toBe(checksum);
    expect(frame[7]).toBe(0x03);
    expect(corpusBytes().length).toBe(120 * 8);
  });
});

describeIf('embedded firmware on an emulated Cortex-M4', () => {
  test('the brownout scenario fails a single-slot store and passes a two-page journal', () => {
    const starter = runEmbeddedScenario1(workspace(1, null));
    expect(starter.passed).toBe(false);
    const starterFailures = starter.checks.filter((check) => !check.passed).map((check) => check.id);
    expect(starterFailures).toContain('brownout-sweep');
    expect(starterFailures).toContain('wear-rotation');

    const reference = runEmbeddedScenario1(workspace(1, REFERENCE_STORE));
    expect(reference.checks.map((check) => check.id)).toEqual([
      'contract',
      'persists',
      'brownout-sweep',
      'torn-write',
      'wear-rotation',
      'legacy-schema',
    ]);
    expect(reference.checks.filter((check) => !check.passed)).toEqual([]);
    expect(reference.passed).toBe(true);
  }, 600_000);

  test('the ring scenario fails a silent drop and passes a counted one', () => {
    const starter = runEmbeddedScenario2(workspace(2, null));
    expect(starter.passed).toBe(false);
    const starterFailures = starter.checks.filter((check) => !check.passed).map((check) => check.id);
    expect(starterFailures).toEqual(['overflow-accounted']);
    const overflow = starter.checks.find((check) => check.id === 'overflow-accounted');
    expect(overflow?.detail).toContain('overruns=0');

    const reference = runEmbeddedScenario2(workspace(2, REFERENCE_RING));
    expect(reference.checks.map((check) => check.id)).toEqual([
      'contract',
      'framing-intact',
      'wrap',
      'overflow-accounted',
      'restart-clean',
      'isr-bounded',
    ]);
    expect(reference.checks.filter((check) => !check.passed)).toEqual([]);
    expect(reference.passed).toBe(true);
  }, 600_000);

  test('the scorers are registered for exactly the two scenarios', () => {
    expect(EMBEDDED_RUNTIME_SCORERS.map((scorer) => scorer.scenarioIds).flat().sort()).toEqual(
      [EMBEDDED_SCENARIO_1, EMBEDDED_SCENARIO_2].sort(),
    );
    expect(EMBEDDED_RUNTIME_MATERIALIZERS.map((materializer) => materializer.realRuntime)).toEqual([true, true]);
  });
});
