// A fake child process that plays a recorded transcript in place of a CLI.
//
// It implements exactly the surface the CLI adapters use: `stdout` and `stderr`
// Readables, a `stdin` Writable, `exitCode`, `kill()`, and the 'exit' / 'close' /
// 'error' events. Everything above the process (argv construction, stdin prompt,
// JSON parsing, event normalization) runs unchanged.
//
// Frames are emitted as fast as the consumer reads: a frame is pushed only when
// the stream asks for more (Readable `_read`), and never on wall-clock time, unless
// `realtime` is set. Scheduling uses setImmediate, which is a macrotask, not a timer.

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { stdinLineMatches, type Transcript, type TranscriptFrame } from './transcript';

export interface ReplayOptions {
  /** Honor the transcript's `t` offsets with real timers. Off by default: tests must not depend on time. */
  realtime?: boolean;
}

export class ReplayChildProcess extends EventEmitter {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** Resolves with the exit code once 'exit' has been emitted. */
  readonly exited: Promise<number | null>;
  /** Every complete stdin line the adapter wrote, in order. */
  readonly stdinLines: string[] = [];
  /** Raw stdin bytes exactly as written (prompts may be multi-line without a trailing newline). */
  private rawStdin = '';
  /** Set when the transcript could not be satisfied (for example a stdin mismatch). */
  failure: string | null = null;

  private readonly frames: TranscriptFrame[];
  private readonly realtime: boolean;
  private index = 0;
  private lastId: unknown = undefined;
  private stdinBuffer = '';
  private scheduled = false;
  private waitingForRead = false;
  private finished = false;
  private resolveExited!: (code: number | null) => void;
  private readonly startedAt = Date.now();

  constructor(transcript: Transcript, options: ReplayOptions = {}) {
    super();
    this.frames = transcript.frames;
    this.realtime = options.realtime === true;
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));

    this.stdout = new Readable({
      read: () => this.resume(),
    });
    this.stderr = new Readable({
      read: () => this.resume(),
    });
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.rawStdin += text;
        this.stdinBuffer += text;
        this.splitStdinLines(false);
        callback();
        this.schedule();
      },
      final: (callback) => {
        this.splitStdinLines(true);
        callback();
        this.schedule();
      },
    });
    // Replay never has a real pipe to fail. Swallow stream errors so a destroyed
    // stream cannot crash the test process.
    for (const stream of [this.stdout, this.stderr, this.stdin]) stream.on('error', () => {});

    this.schedule();
  }

  /** Stop the replay. Like a real SIGTERM, the process exits with a null code. */
  /** Everything the adapter wrote to stdin so far, exactly as written. */
  stdinText(): string {
    return this.rawStdin;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.finished) return false;
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    this.finish(null);
    return true;
  }

  private schedule(): void {
    if (this.scheduled || this.finished) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.step();
    });
  }

  private resume(): void {
    if (!this.waitingForRead) return;
    this.waitingForRead = false;
    this.schedule();
  }

  private splitStdinLines(flush: boolean): void {
    const parts = this.stdinBuffer.split('\n');
    this.stdinBuffer = parts.pop() ?? '';
    for (const part of parts) this.acceptStdinLine(part);
    if (flush && this.stdinBuffer.length > 0) {
      const rest = this.stdinBuffer;
      this.stdinBuffer = '';
      this.acceptStdinLine(rest);
    }
  }

  private acceptStdinLine(line: string): void {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length === 0) return;
    this.stdinLines.push(trimmed);
    this.pendingStdin.push(trimmed);
  }

  private readonly pendingStdin: string[] = [];

  private step(): void {
    while (!this.finished) {
      if (this.index >= this.frames.length) {
        this.finish(0);
        return;
      }
      const frame = this.frames[this.index];
      if (this.realtime && frame.t > this.elapsed()) {
        setTimeout(() => this.schedule(), frame.t - this.elapsed());
        return;
      }
      if (frame.stream === 'stdin-expect') {
        if (this.pendingStdin.length === 0) return; // wait for the adapter to write
        const line = this.pendingStdin.shift()!;
        if (!stdinLineMatches(frame.match, line)) {
          this.fail(
            `replay: expected stdin matching ${JSON.stringify(frame.match)} but got ${JSON.stringify(line.slice(0, 200))}`,
          );
          return;
        }
        this.lastId = extractId(line);
        this.index++;
        continue;
      }
      if (frame.stream === 'exit') {
        this.index++;
        this.finish(frame.code);
        return;
      }
      const target = frame.stream === 'stdout' ? this.stdout : this.stderr;
      const data = substituteIds(frame.data, this.lastId);
      this.index++;
      if (!target.push(data)) {
        this.waitingForRead = true;
        return;
      }
    }
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }

  private fail(message: string): void {
    this.failure = message;
    this.stderr.push(`${message}\n`);
    this.finish(3);
  }

  private finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.stdout.push(null);
    this.stderr.push(null);
    // Emit exit and close only after any stream a consumer is reading has ended,
    // so no buffered stdout is lost. Streams nobody reads never end, so do not wait for them.
    const drained = Promise.all([drainedOrUnread(this.stdout), drainedOrUnread(this.stderr)]);
    void drained.then(() =>
      setImmediate(() => {
        this.emit('exit', code, this.signalCode);
        this.emit('close', code, this.signalCode);
        this.resolveExited(code);
      }),
    );
  }
}

function drainedOrUnread(stream: Readable): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  const consumed = stream.readableFlowing === true || stream.listenerCount('readable') > 0;
  if (!consumed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once('end', () => resolve());
    stream.once('close', () => resolve());
  });
}

/** `{{id}}` in a frame becomes the JSON form of the last matched stdin request's id. */
function substituteIds(data: string, lastId: unknown): string {
  if (!data.includes('{{id}}')) return data;
  return data.split('{{id}}').join(JSON.stringify(lastId ?? null));
}

function extractId(line: string): unknown {
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    return parsed.id;
  } catch {
    return undefined;
  }
}

/** Start a replay of `transcript` as a child process. */
export function startReplay(transcript: Transcript, options?: ReplayOptions): ReplayChildProcess {
  return new ReplayChildProcess(transcript, options);
}

export interface ReplaySpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: ReplayChildProcess;
  /** Everything the adapter wrote to stdin, including partial lines. */
  stdin(): string;
}

/** What a spawn route returns for one command: a transcript to play, or
 *  `null` for "no recording for this command", which exits with status 127. */
export type ReplayRoute = (command: string, args: readonly string[]) => Transcript | null;

export interface ReplaySpawn {
  /** Drop-in for node's `spawn`. Cast to `typeof spawn` at the injection point. */
  (command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  /** Every spawn the adapter made through this seam, in order. */
  readonly calls: ReplaySpawnCall[];
}

/** Build the spawn seam the adapters accept. Each call is routed to a transcript. */
export function createReplaySpawn(route: ReplayRoute, options?: ReplayOptions): ReplaySpawn {
  const calls: ReplaySpawnCall[] = [];
  const spawnFn = (
    command: string,
    args: readonly string[] = [],
    spawnOptions: SpawnOptions = {},
  ) => {
    const transcript = route(command, args);
    const child = transcript
      ? startReplay(transcript, options)
      : startReplay({
          header: {
            provider: 'unrouted',
            cliVersion: 'none',
            recordedAt: '',
            argv: [command, ...args],
          },
          frames: [
            {
              t: 0,
              stream: 'stderr',
              data: `replay: no transcript routed for ${command} ${args.join(' ')}\n`,
            },
            { t: 0, stream: 'exit', code: 127 },
          ],
        });
    calls.push({
      command,
      args: [...args],
      options: spawnOptions,
      child,
      stdin: () => child.stdinText(),
    });
    return child as unknown as ChildProcess;
  };
  return Object.assign(spawnFn, { calls }) as ReplaySpawn;
}
