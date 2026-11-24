import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isUnix } from '../runtime/platform';
import { onComputerUseStop, stopComputerUse } from './control';
import { revokeComputerAuthority } from './authority';

const MAX_FRAME = 24 * 1024 * 1024;

/** One warm native process retains real accessibility references between requests.
 * The host lock serializes callers. Native Stop is unsolicited and revokes host
 * authority, not merely the current request. EOF/abort releases input natively.
 */
export class NativeComputerController {
  private child?: ChildProcessWithoutNullStreams;
  private frame = '';
  private pending?: {
    id: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  private idle?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;

  constructor(
    private readonly launch: { command: string; args: string[]; cwd: string },
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.unsubscribe = onComputerUseStop(() => this.stop());
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    this.frame = '';
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      detached: isUnix(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      this.frame += chunk;
      if (Buffer.byteLength(this.frame) > MAX_FRAME) {
        this.pending?.reject(new Error('Native controller exceeded frame limit'));
        this.stop();
        return;
      }
      let end: number;
      while ((end = this.frame.indexOf('\n')) !== -1) {
        const line = this.frame.slice(0, end);
        this.frame = this.frame.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value.event === 'stopped') {
            revokeComputerAuthority();
            stopComputerUse('User stopped native computer control');
          } else if (this.pending && value.id === this.pending.id) {
            this.pending.resolve(value);
          }
        } catch {
          this.pending?.reject(new Error('Invalid native controller JSON'));
          this.stop();
        }
      }
    });
    // Native diagnostics can contain application text; do not forward into logs.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => this.pending?.reject(new Error('Native controller failed to start')));
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = undefined;
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(new Error('Native controller exited'));
    });
    return child;
  }

  async request(request: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.pending) throw new Error('Native controller busy');
    clearTimeout(this.idle);
    const child = this.start();
    const id = randomUUID();
    let abort = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject };
        abort = () => {
          reject(new Error('Computer operation aborted'));
          this.stop();
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          reject(new Error('Native computer operation timed out'));
          this.stop();
        }, 20_000);
        if (signal?.aborted) {
          abort();
          return;
        }
        child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      this.pending = undefined;
      this.idle = setTimeout(() => this.stop(), 60_000);
      this.idle.unref();
    }
  }

  stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.pending?.reject(new Error('Computer controller stopped'));
    // First let the native controller release held input and its indicator.
    child.stdin.end(JSON.stringify({ kind: 'stop' }) + '\n');
    const timer = setTimeout(() => {
      try {
        if (isUnix() && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch {
        /* Already exited. */
      }
    }, 250);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  dispose(): void {
    this.stop();
    this.unsubscribe();
  }
}
