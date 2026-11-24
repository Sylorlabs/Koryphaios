// One PTY-backed shell. Owns the Bun.Terminal, the scrollback ring buffer and
// the per-terminal output sequence. It knows nothing about routing or
// permissions: the service decides who may reach it, and `publish` is the only
// way output leaves.

import type { TerminalInfo, TerminalScope, TerminalScrollback } from '@koryphaios/shared';
import type { WSMessage } from '@koryphaios/shared';
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  TERMINAL_SCROLLBACK_BYTES,
} from '@koryphaios/shared';
import { terminalLog } from '../logger';

/** Byte-capped FIFO of PTY output chunks. Evicts whole chunks from the front. */
export class ScrollbackRing {
  private chunks: Array<{ seq: number; bytes: Uint8Array }> = [];
  private size = 0;
  private evicted = false;

  constructor(private readonly capacity: number = TERMINAL_SCROLLBACK_BYTES) {}

  append(seq: number, bytes: Uint8Array): void {
    const kept =
      bytes.byteLength > this.capacity ? bytes.subarray(bytes.byteLength - this.capacity) : bytes;
    this.chunks.push({ seq, bytes: kept });
    this.size += kept.byteLength;
    while (this.size > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.bytes.byteLength;
      this.evicted = true;
    }
  }

  /** Concatenated retained bytes plus the sequence range they cover. */
  snapshot(lastSeq: number): {
    bytes: Uint8Array;
    fromSeq: number;
    throughSeq: number;
    truncated: boolean;
  } {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk.bytes, offset);
      offset += chunk.bytes.byteLength;
    }
    const first = this.chunks[0];
    return {
      bytes: out,
      fromSeq: first ? first.seq : lastSeq + 1,
      throughSeq: lastSeq,
      truncated: this.evicted,
    };
  }
}

export interface TerminalSessionOptions {
  id: string;
  sessionId: string;
  scope: TerminalScope;
  name: string;
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  /** Live delivery to the owning chat. Called in output order. */
  publish: (message: WSMessage) => void;
  now?: () => number;
}

export function clampCols(value: number): number {
  return Math.min(Math.max(Math.floor(value), TERMINAL_MIN_COLS), TERMINAL_MAX_COLS);
}

export function clampRows(value: number): number {
  return Math.min(Math.max(Math.floor(value), TERMINAL_MIN_ROWS), TERMINAL_MAX_ROWS);
}

/** The environment a user shell starts with: the backend's own environment
 *  plus terminal capability hints. Nothing is stripped; this is the user's shell. */
export function terminalEnvironment(
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

export class TerminalSession {
  readonly id: string;
  readonly sessionId: string;
  readonly scope: TerminalScope;
  readonly name: string;
  readonly cwd: string;
  readonly shell: string;
  readonly createdAt: number;

  private cols: number;
  private rows: number;
  private status: 'running' | 'exited' = 'running';
  private exitCode: number | null = null;
  private signal: string | null = null;
  private exitedAt: number | null = null;
  private seq = 0;
  private readonly ring = new ScrollbackRing();
  private readonly publish: (message: WSMessage) => void;
  private readonly now: () => number;
  private terminal: {
    write(data: string | Uint8Array): number;
    resize(cols: number, rows: number): void;
    close(): void;
  } | null = null;
  private proc: {
    kill(signal?: number | NodeJS.Signals): void;
    exited: Promise<number>;
    signalCode?: string | null;
  } | null = null;

  constructor(options: TerminalSessionOptions) {
    this.id = options.id;
    this.sessionId = options.sessionId;
    this.scope = options.scope;
    this.name = options.name;
    this.cwd = options.cwd;
    this.shell = [options.command, ...options.args].join(' ');
    this.cols = clampCols(options.cols);
    this.rows = clampRows(options.rows);
    this.publish = options.publish;
    this.now = options.now ?? Date.now;
    this.createdAt = this.now();

    // Bun.Terminal gives the child a real PTY (ConPTY on Windows). `data`
    // receives raw bytes; they are never decoded here, so UTF-8 sequences
    // split across reads reach the client intact.
    const proc = Bun.spawn([options.command, ...options.args], {
      cwd: options.cwd,
      env: terminalEnvironment(options.env),
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_term: unknown, bytes: Uint8Array) => this.onData(bytes),
      },
    } as unknown as Parameters<typeof Bun.spawn>[1]) as unknown as {
      terminal: TerminalSession['terminal'];
      kill(signal?: number | NodeJS.Signals): void;
      exited: Promise<number>;
      signalCode?: string | null;
    };
    this.proc = proc;
    this.terminal = proc.terminal;
    proc.exited.then(
      (code) => this.onExit(code, proc.signalCode ?? null),
      (error) => {
        terminalLog.warn({ terminalId: this.id, error: String(error) }, 'Terminal process failed');
        this.onExit(null, null);
      },
    );
    terminalLog.info(
      { terminalId: this.id, sessionId: this.sessionId, scope: this.scope },
      'Terminal started',
    );
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }

  get lastSeq(): number {
    return this.seq;
  }

  private onData(bytes: Uint8Array): void {
    if (this.status !== 'running') return;
    this.seq += 1;
    // Copy: the runtime may reuse the buffer after the callback returns.
    const chunk = new Uint8Array(bytes);
    this.ring.append(this.seq, chunk);
    this.publish({
      type: 'terminal.output',
      sessionId: this.sessionId,
      timestamp: this.now(),
      payload: { terminalId: this.id, seq: this.seq, data: Buffer.from(chunk).toString('base64') },
    });
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.status === 'exited') return;
    this.status = 'exited';
    this.exitCode = code;
    this.signal = signal;
    this.exitedAt = this.now();
    try {
      this.terminal?.close();
    } catch {
      /* already closed */
    }
    this.terminal = null;
    this.publish({
      type: 'terminal.exit',
      sessionId: this.sessionId,
      timestamp: this.now(),
      payload: { terminalId: this.id, exitCode: code, signal },
    });
    terminalLog.info({ terminalId: this.id, exitCode: code, signal }, 'Terminal exited');
  }

  /** Writes keystrokes to the PTY. Returns false once the shell has exited. */
  write(data: string): boolean {
    if (this.status !== 'running' || !this.terminal) return false;
    this.terminal.write(data);
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (this.status !== 'running' || !this.terminal) return false;
    this.cols = clampCols(cols);
    this.rows = clampRows(rows);
    this.terminal.resize(this.cols, this.rows);
    return true;
  }

  /** Sends a signal to the shell. Exit is reported through the exit event. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.status !== 'running') return;
    this.proc?.kill(signal);
  }

  /** Forced teardown used when the owning chat is deleted or the backend stops. */
  dispose(): void {
    if (this.status === 'running') {
      try {
        this.proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try {
      this.terminal?.close();
    } catch {
      /* already closed */
    }
    this.terminal = null;
  }

  scrollback(): TerminalScrollback {
    const snap = this.ring.snapshot(this.seq);
    return {
      terminalId: this.id,
      fromSeq: snap.fromSeq,
      throughSeq: snap.throughSeq,
      data: Buffer.from(snap.bytes).toString('base64'),
      truncated: snap.truncated,
    };
  }

  /** Retained output as plain bytes, for agent reads. */
  retainedBytes(): Uint8Array {
    return this.ring.snapshot(this.seq).bytes;
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      sessionId: this.sessionId,
      scope: this.scope,
      name: this.name,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt,
      lastSeq: this.seq,
    };
  }
}
