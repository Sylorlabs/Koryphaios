import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKEND_STATE_SKILL_EVAL_MATERIALIZERS,
  BACKEND_STATE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-backend-state-fixtures';
import { readFixtureText, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const repairedFraming = `export class FrameDecoder {
  private buffered = new Uint8Array();
  constructor(readonly maxFrame: number) {}
  push(chunk: Uint8Array): Uint8Array[] {
    const combined = new Uint8Array(this.buffered.length + chunk.length);
    combined.set(this.buffered);
    combined.set(chunk, this.buffered.length);
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (combined.length - offset >= 4) {
      const length = new DataView(combined.buffer, combined.byteOffset + offset).getUint32(0);
      if (length > this.maxFrame) throw new Error('FRAME_TOO_LARGE');
      if (combined.length - offset < length + 4) break;
      frames.push(combined.slice(offset + 4, offset + 4 + length));
      offset += 4 + length;
    }
    this.buffered = combined.slice(offset);
    return frames;
  }
  bufferedBytes(): number { return this.buffered.length; }
}
export class OutboundQueue {
  queued = 0;
  constructor(readonly maxBytes: number) {}
  enqueue(bytes: number): boolean {
    if (!Number.isInteger(bytes) || bytes < 0 || this.queued + bytes > this.maxBytes) return false;
    this.queued += bytes;
    return true;
  }
  drain(bytes: number) { this.queued = Math.max(0, this.queued - Math.max(0, bytes)); }
  close() { this.queued = 0; }
}
`;

const framingRegressions = `import { expect, test } from 'bun:test';
import { FrameDecoder, OutboundQueue } from '../src/framing';
const frame = (value: string) => {
  const payload = new TextEncoder().encode(value);
  const result = new Uint8Array(payload.length + 4);
  new DataView(result.buffer).setUint32(0, payload.length);
  result.set(payload, 4);
  return result;
};
test('fragmented frames preserve incomplete suffix and coalesced frames decode all', () => {
  const decoder = new FrameDecoder(12);
  const a = frame('a');
  const b = frame('bb');
  expect(decoder.push(a.slice(0, 3))).toEqual([]);
  expect(decoder.bufferedBytes()).toBe(3);
  expect(decoder.push(a.slice(3)).map(v => new TextDecoder().decode(v))).toEqual(['a']);
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  expect(decoder.push(both).map(v => new TextDecoder().decode(v))).toEqual(['a', 'bb']);
});
test('oversized frame header is rejected before accumulation', () => {
  const decoder = new FrameDecoder(4);
  expect(() => decoder.push(new Uint8Array([0, 0, 1, 0]))).toThrow(/too|large/i);
  expect(decoder.bufferedBytes()).toBeLessThanOrEqual(8);
});
test('slow reader backpressure rejects overflow and disconnect timeout cleans the queue', () => {
  const queue = new OutboundQueue(8);
  expect(queue.enqueue(5)).toBe(true);
  expect(queue.enqueue(4)).toBe(false);
  expect(queue.queued).toBe(5);
  queue.drain(3);
  expect(queue.enqueue(4)).toBe(true);
  queue.close();
  expect(queue.queued).toBe(0);
});
`;

describe('network framing regression evidence', () => {
  test('accepts a repaired transport with tests that detect original framing and backpressure defects', async () => {
    const scenarioId = 'network-service-backend-full-task-1-individual';
    const root = mkdtempSync(join(tmpdir(), 'kory-network-framing-regression-'));
    roots.push(root);
    const materializer = BACKEND_STATE_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches({ id: scenarioId } as never),
    )!;
    const scorer = BACKEND_STATE_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenarioId),
    )!;
    await materializer.materialize(root, { id: scenarioId } as never);
    writeFixtureFile(root, 'src/framing.ts', repairedFraming);
    writeFixtureFile(root, 'tests/framing.test.ts', framingRegressions);
    writeFixtureFile(
      root,
      '.kory-eval/network-framing.json',
      `${JSON.stringify({
        transport: 'length-prefix TCP frames',
        bounds: 'input frame maximum and outbound byte queue backpressure',
        cleanup: 'disconnect and half-close timeout release buffered outbound bytes',
      })}\n`,
    );
    const input = { workingDirectory: root } as never;
    const accepted = await scorer.score(input);
    expect(accepted.passed, accepted.evidence.join('\n')).toBe(true);
    expect(accepted.evidence).toContain('candidate tests reject the original defect: yes');
    expect(scorer.id).toEndWith('@2');
    expect(readFixtureText(root, 'src/framing.ts')).toBe(repairedFraming);

    writeFixtureFile(
      root,
      'tests/framing.test.ts',
      `import { expect, test } from 'bun:test';\ntest('fragmented coalesced oversized slow reader backpressure disconnect half-close timeout', () => expect(true).toBe(true));\n`,
    );
    const keywordOnly = await scorer.score(input);
    expect(keywordOnly.passed).toBe(false);
    expect(keywordOnly.evidence).toContain('candidate tests reject the original defect: no');
    expect(readFixtureText(root, 'src/framing.ts')).toBe(repairedFraming);
  });
});
