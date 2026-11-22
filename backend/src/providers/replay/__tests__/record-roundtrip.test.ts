// Round trip: a session played by the replay, captured by the recorder, must
// produce a transcript that replays to the same stdout. The driver answers each
// expected request only after its response arrives, as the real adapter does,
// so the recorder's latest-request id tracking is exercised the way it is in
// production. Event-driven, no timers.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { createRecordingSpawn } from '../record';
import { createReplaySpawn, startReplay, type ReplayChildProcess } from '../replay-process';
import { loadTranscript, type Transcript, type TranscriptFrame } from '../transcript';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'opencode-synthetic-turn.jsonl');

/** Write each expected request in order, waiting for its response before the next. */
async function driveAcpSession(child: ReplayChildProcess, expects: Array<{ method: string; params?: unknown }>) {
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (output += chunk));
  const waitFor = (needle: string) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (output.includes(needle)) {
          child.stdout.off('data', check);
          resolve();
        }
      };
      child.stdout.on('data', check);
      check();
    });
  for (const [index, request] of expects.entries()) {
    const id = `req-${index + 1}`;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params: request.params ?? {} })}\n`);
    await waitFor(`"${id}"`);
  }
  await child.exited;
  return output;
}

describe('record then replay', () => {
  test('a recorded ACP session replays to the same stdout and the same request sequence', async () => {
    const fixture = loadTranscript(FIXTURE);
    const expects = fixture.frames
      .filter((frame): frame is Extract<TranscriptFrame, { stream: 'stdin-expect' }> => frame.stream === 'stdin-expect')
      .map((frame) => ({ method: (frame.match as { method: string }).method, params: (frame.match as { params?: unknown }).params }));

    // The "real" CLI in this test is the fixture itself. The recorder sits between the
    // adapter and that CLI, exactly as record-cli-transcript.ts does against a live CLI.
    const cli = createReplaySpawn(() => fixture);
    const recorded: Transcript[] = [];
    const recording = createRecordingSpawn(cli as unknown as typeof spawn, {
      provider: 'opencode',
      cliVersion: 'roundtrip',
      matches: () => true,
      onRecorded: (transcript) => recorded.push(transcript),
    });
    const child = recording('opencode', ['acp'], {}) as unknown as ReplayChildProcess;
    const recordedOutput = await driveAcpSession(child, expects);

    expect(recorded).toHaveLength(1);
    const transcript = recorded[0];
    expect(transcript.header.synthetic).toBe(false);
    expect(transcript.frames.filter((f) => f.stream === 'stdin-expect').map((f) => (f.match as { method: string }).method)).toEqual(
      expects.map((e) => e.method),
    );
    // Recorded stdout stores the request id as {{id}}, never the literal random id.
    const recordedStdout = transcript.frames.map((f) => (f.stream === 'stdout' ? f.data : '')).join('');
    expect(recordedStdout).toContain('{{id}}');
    expect(recordedStdout).not.toContain('"req-');
    expect(recordedOutput).toContain('"req-1"');

    // The recording is itself a valid replay source: play it back and drive it the same way.
    const replayed = await driveAcpSession(startReplay(transcript), expects);
    expect(replayed).toBe(recordedOutput);
  });
});
