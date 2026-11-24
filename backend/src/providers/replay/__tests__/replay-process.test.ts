// Unit coverage for the replay transport itself: frame ordering, stdin gating,
// mismatch failure, id substitution, kill, and transcript validation. Everything
// is event-driven. No timers or sleeps.

import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { startReplay } from '../replay-process';
import {
  jsonSubsetMatches,
  parseTranscript,
  TranscriptFormatError,
  type Transcript,
} from '../transcript';

const header = {
  provider: 'test',
  cliVersion: 'test',
  recordedAt: '2026-01-01T00:00:00.000Z',
  argv: ['test'],
};

function transcript(frames: Transcript['frames']): Transcript {
  return { header, frames };
}

describe('replay process', () => {
  test('holds stdout behind a stdin-expect frame until the adapter writes the matching request', async () => {
    const child = startReplay(
      transcript([
        { t: 0, stream: 'stdout', data: 'A' },
        { t: 0, stream: 'stdin-expect', match: { method: 'ping' } },
        { t: 0, stream: 'stdout', data: 'B' },
        { t: 0, stream: 'exit', code: 0 },
      ]),
    );
    child.stdout.setEncoding('utf8');
    const seen: string[] = [];
    child.stdout.on('data', (chunk: string) => seen.push(chunk));

    await once(child.stdout, 'data');
    expect(seen.join('')).toBe('A');

    child.stdin.write('{"jsonrpc":"2.0","method":"ping"}\n');
    expect(await child.exited).toBe(0);
    expect(seen.join('')).toBe('AB');
  });

  test('fails with exit 3 when the adapter writes a request the transcript did not expect', async () => {
    const child = startReplay(
      transcript([
        { t: 0, stream: 'stdin-expect', match: { method: 'initialize' } },
        { t: 0, stream: 'stdout', data: 'never\n' },
      ]),
    );
    child.stdin.write('{"jsonrpc":"2.0","id":"1","method":"session/new"}\n');

    expect(await child.exited).toBe(3);
    expect(child.failure).toContain('expected stdin matching');
    expect(child.failure).toContain('session/new');
  });

  test('substitutes {{id}} with the id of the matched request, keeping its JSON type', async () => {
    const child = startReplay(
      transcript([
        { t: 0, stream: 'stdin-expect', match: { method: 'initialize' } },
        { t: 0, stream: 'stdout', data: '{"jsonrpc":"2.0","id":{{id}},"result":{}}\n' },
        { t: 0, stream: 'exit', code: 0 },
      ]),
    );
    child.stdout.setEncoding('utf8');
    const seen: string[] = [];
    child.stdout.on('data', (chunk: string) => seen.push(chunk));
    child.stdin.write('{"jsonrpc":"2.0","id":"req-7","method":"initialize"}\n');
    expect(await child.exited).toBe(0);
    expect(JSON.parse(seen.join(''))).toEqual({ jsonrpc: '2.0', id: 'req-7', result: {} });
  });

  test('kill ends the replay with a null exit code and the signal', async () => {
    const child = startReplay(
      transcript([{ t: 0, stream: 'stdin-expect', match: 'never-written' }]),
    );
    const exit = once(child, 'exit');
    expect(child.kill('SIGTERM')).toBe(true);
    expect(await exit).toEqual([null, 'SIGTERM']);
    expect(child.kill()).toBe(false);
  });

  test('stdin-expect string matches are substrings of the raw line', async () => {
    const child = startReplay(
      transcript([
        { t: 0, stream: 'stdin-expect', match: 'List the files' },
        { t: 0, stream: 'exit', code: 0 },
      ]),
    );
    child.stdin.end('Please List the files in src/\n');
    expect(await child.exited).toBe(0);
  });
});

describe('transcript format', () => {
  const good = [
    JSON.stringify(header),
    JSON.stringify({ t: 0, stream: 'stdout', data: 'hi\n' }),
    JSON.stringify({ t: 4, stream: 'stdin-expect', match: { method: 'x' } }),
    JSON.stringify({ t: 9, stream: 'exit', code: 0 }),
  ].join('\n');

  test('parses a valid transcript', () => {
    const parsed = parseTranscript(good);
    expect(parsed.header.provider).toBe('test');
    expect(parsed.frames.map((frame) => frame.stream)).toEqual(['stdout', 'stdin-expect', 'exit']);
  });

  test('rejects a missing header, unknown streams, bad codes and decreasing time', () => {
    expect(() => parseTranscript(JSON.stringify({ t: 0, stream: 'exit', code: 0 }))).toThrow(
      TranscriptFormatError,
    );
    expect(() =>
      parseTranscript(`${JSON.stringify(header)}\n{"t":0,"stream":"tty","data":""}`),
    ).toThrow(/stream must be/);
    expect(() =>
      parseTranscript(`${JSON.stringify(header)}\n{"t":0,"stream":"exit","code":"0"}`),
    ).toThrow(/integer code/);
    expect(() =>
      parseTranscript(
        `${JSON.stringify(header)}\n{"t":5,"stream":"stdout","data":""}\n{"t":2,"stream":"stdout","data":""}`,
      ),
    ).toThrow(/must not decrease/);
  });

  test('JSON subset matching is recursive and arrays match element-wise', () => {
    expect(jsonSubsetMatches({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
    expect(jsonSubsetMatches({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(jsonSubsetMatches({ a: 1 }, { a: '1' })).toBe(false);
  });
});
