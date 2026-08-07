import { mkdirSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { serverLog } from '../logger';
import { getKoryCodexHome } from './auth-utils';
import { whichBinary } from './cli-detection';

type JsonRpcResponse = {
  id?: number;
  result?: any;
  error?: { message?: string };
  method?: string;
  params?: unknown;
};

export type CodexAccount = {
  type: 'chatgpt' | 'apiKey' | 'personalAccessToken' | string;
  email?: string | null;
  planType?: string | null;
};

export type CodexManagedAuthStatus = {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
};

export type CodexAccountUsage = {
  summary?: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    currentStreakDays?: number | null;
  };
  dailyUsageBuckets?: Array<{ startDate?: string; tokens?: number }> | null;
};

export type CodexRateLimits = {
  rateLimits?: {
    planType?: string | null;
    primary?: { usedPercent?: number; windowMinutes?: number; resetsAt?: number } | null;
    secondary?: { usedPercent?: number; windowMinutes?: number; resetsAt?: number } | null;
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  } | null;
};

type LoginCompletion = {
  loginId: string | null;
  success: boolean;
  error: string | null;
};

const IDLE_SHUTDOWN_MS = 2 * 60_000;

/**
 * Local control-plane client for the official Codex app-server.
 *
 * The app-server owns ChatGPT OAuth, its callback listener, token persistence,
 * refreshes, and all upstream headers. Koryphaios only sends local JSON-RPC.
 */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private started: Promise<void> | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly notifications = new EventEmitter();
  private readonly pending = new Map<number, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private idleShutdown: ReturnType<typeof setTimeout> | null = null;
  private loginWaiters = 0;

  constructor(private readonly codexHome = getKoryCodexHome()) {}

  async account(refreshToken = false): Promise<CodexManagedAuthStatus> {
    const result = await this.request('account/read', { refreshToken });
    return {
      account: result?.account ?? null,
      requiresOpenaiAuth: result?.requiresOpenaiAuth === true,
    };
  }

  /** Read the official CLI's account-wide usage surface without creating a turn. */
  async usage(): Promise<CodexAccountUsage> {
    return await this.request('account/usage/read', {});
  }

  /** Read the official CLI's live quota/credit snapshot without spending a credit. */
  async rateLimits(): Promise<CodexRateLimits> {
    return await this.request('account/rateLimits/read', {});
  }

  async startChatgptLogin(): Promise<{ loginId: string; authUrl: string }> {
    const result = await this.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });
    if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') {
      throw new Error('Codex did not return a ChatGPT sign-in URL');
    }
    return { loginId: result.loginId, authUrl: result.authUrl };
  }

  /** Start the official device-code flow. The UI owns displaying its code and URL. */
  async startChatgptDeviceCodeLogin(): Promise<{
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }> {
    const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (
      result?.type !== 'chatgptDeviceCode' ||
      typeof result.loginId !== 'string' ||
      typeof result.verificationUrl !== 'string' ||
      typeof result.userCode !== 'string'
    ) {
      throw new Error('Codex did not return a ChatGPT device code');
    }
    return {
      loginId: result.loginId,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
    };
  }

  /** Wait for the app-server notification that closes a specific login attempt. */
  async waitForLoginCompletion(loginId: string, timeoutMs = 15 * 60_000): Promise<LoginCompletion> {
    await this.ensureStarted();
    this.loginWaiters++;
    this.clearIdleShutdown();
    return await new Promise<LoginCompletion>((resolve, reject) => {
      const finish = (completion?: LoginCompletion, error?: Error) => {
        clearTimeout(timeout);
        this.notifications.off('account/login/completed', onCompletion);
        this.loginWaiters = Math.max(0, this.loginWaiters - 1);
        this.scheduleIdleShutdown();
        if (error) reject(error);
        else resolve(completion!);
      };
      const onCompletion = (params: unknown) => {
        const completion = params as Partial<LoginCompletion> | null;
        if (completion?.loginId !== loginId) return;
        finish({
          loginId,
          success: completion.success === true,
          error: typeof completion.error === 'string' ? completion.error : null,
        });
      };
      const timeout = setTimeout(() => {
        finish(undefined, new Error('ChatGPT sign-in timed out before it was completed'));
      }, timeoutMs);
      timeout.unref?.();
      this.notifications.on('account/login/completed', onCompletion);
    });
  }

  async logout(): Promise<void> {
    await this.request('account/logout', {});
  }

  close(): void {
    this.clearIdleShutdown();
    const child = this.child;
    this.child = null;
    this.started = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }

  async listModels(): Promise<any[]> {
    const result = await this.request('model/list', { limit: 100, includeHidden: false });
    return Array.isArray(result?.data)
      ? result.data.filter((model: { hidden?: boolean }) => !model?.hidden)
      : [];
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return this.started;
    const binary = whichBinary('codex');
    if (!binary) throw new Error('Codex CLI (codex) was not found on PATH');

    this.started = new Promise<void>((resolve, reject) => {
      const codexHome = this.codexHome;
      try {
        mkdirSync(codexHome, { recursive: true });
      } catch (error) {
        this.started = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const child = spawn(binary, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()));
      child.once('error', (error) => this.fail(error));
      child.once('exit', (code) => {
        const error = new Error((stderr.trim() || `Codex app-server exited with status ${code}`).slice(0, 500));
        this.fail(error);
      });
      this.request('initialize', {
        clientInfo: { name: 'Koryphaios', version: '1.0' },
        capabilities: null,
      }).then(() => {
        this.notify('initialized', {});
        resolve();
      }).catch((error) => {
        this.started = null;
        reject(error);
      });
    });
    return this.started;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    if (method !== 'initialize') await this.ensureStarted();
    const child = this.child;
    if (!child?.stdin.writable) throw new Error('Codex app-server is unavailable');
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.scheduleIdleShutdown();
        reject(new Error(`Codex app-server timed out while handling ${method}`));
      }, 30_000);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (result) => {
          this.scheduleIdleShutdown();
          resolve(result);
        },
        reject: (error) => {
          this.scheduleIdleShutdown();
          reject(error);
        },
        timeout,
      });
      this.clearIdleShutdown();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private clearIdleShutdown(): void {
    if (this.idleShutdown) clearTimeout(this.idleShutdown);
    this.idleShutdown = null;
  }

  private scheduleIdleShutdown(): void {
    if (!this.child || this.pending.size > 0 || this.loginWaiters > 0) return;
    this.clearIdleShutdown();
    this.idleShutdown = setTimeout(() => this.close(), IDLE_SHUTDOWN_MS);
    this.idleShutdown.unref?.();
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.method === 'string') {
          this.notifications.emit(message.method, message.params);
          continue;
        }
        if (typeof message.id !== 'number') continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
        else pending.resolve(message.result);
      } catch (err: unknown) {
        // The protocol is JSONL; ignore non-protocol diagnostics.
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Codex app-server: non-protocol JSONL line skipped');
      }
    }
  }

  private fail(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.child = null;
    this.started = null;
  }
}

let managedServer: CodexAppServer | null = null;

export function getManagedCodexAppServer(): CodexAppServer {
  managedServer ??= new CodexAppServer();
  return managedServer;
}
