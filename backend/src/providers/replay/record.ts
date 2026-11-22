// Recording wrapper: runs a real CLI through the adapter's spawn seam and captures
// the frames it emits as a transcript. Used by backend/scripts/record-cli-transcript.ts.
//
// Only spawns that `matches` selects are recorded. Every other spawn (model
// probes, version checks) passes through to the real spawn untouched.

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Transcript, TranscriptFrame } from './transcript';

export interface RecordingOptions {
  provider: string;
  cliVersion: string;
  /** Which spawns to record. The turn process is the only one that should match. */
  matches: (command: string, args: readonly string[]) => boolean;
  /** Called once per recorded process, when it has exited. */
  onRecorded: (transcript: Transcript) => void;
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Wrap a real spawn so matching processes are recorded as they run. */
export function createRecordingSpawn(realSpawn: SpawnFn, options: RecordingOptions): SpawnFn {
  const now = options.now ?? Date.now;
  return (command, args, spawnOptions) => {
    const child = realSpawn(command, args, spawnOptions);
    if (!options.matches(command, args)) return child;

    const startedAt = now();
    const recordedAt = new Date(startedAt).toISOString();
    const frames: TranscriptFrame[] = [];
    const elapsed = () => Math.max(0, now() - startedAt);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    // ACP request ids are random per request. The latest request id is replaced by
    // `{{id}}` in recorded stdout, so replay can answer whatever id the adapter picks.
    let lastRequestId: unknown;
    const withIdToken = (data: string) =>
      lastRequestId === undefined || lastRequestId === null
        ? data
        : data.split(JSON.stringify(lastRequestId)).join('{{id}}');
    child.stdout?.on('data', (chunk: Buffer) => {
      frames.push({ t: elapsed(), stream: 'stdout', data: withIdToken(stdoutDecoder.write(chunk)) });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      frames.push({ t: elapsed(), stream: 'stderr', data: stderrDecoder.write(chunk) });
    });

    // Record only JSON-RPC requests the adapter writes (lines with a `method`).
    // Raw prompt text is not recorded: it is the input, not part of the protocol.
    const stdin = child.stdin;
    if (stdin) {
      const originalWrite = stdin.write.bind(stdin) as (...args: unknown[]) => boolean;
      (stdin as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
        const chunk = args[0];
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        for (const line of text.split('\n')) {
          const request = requestOf(line);
          if (!request) continue;
          frames.push({ t: elapsed(), stream: 'stdin-expect', match: { method: request.method } });
          lastRequestId = request.id;
        }
        return originalWrite(...args);
      };
    }

    child.once('close', (code: number | null) => {
      const tail = stdoutDecoder.end();
      if (tail) frames.push({ t: elapsed(), stream: 'stdout', data: tail });
      const errTail = stderrDecoder.end();
      if (errTail) frames.push({ t: elapsed(), stream: 'stderr', data: errTail });
      frames.push({ t: elapsed(), stream: 'exit', code: code ?? 0 });
      options.onRecorded({
        header: {
          provider: options.provider,
          cliVersion: options.cliVersion,
          recordedAt,
          argv: [command, ...args],
          synthetic: false,
        },
        frames,
      });
    });
    return child;
  };
}

function requestOf(line: string): { method: string; id: unknown } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { method?: unknown; id?: unknown };
    return typeof parsed.method === 'string' ? { method: parsed.method, id: parsed.id } : undefined;
  } catch {
    return undefined;
  }
}
