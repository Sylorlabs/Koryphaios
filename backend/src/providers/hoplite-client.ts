// Hoplite REST API client — async coding agent control plane.
// https://hoplite.sh — API base https://api.hoplite.sh
//
// Hoplite is NOT an LLM inference API: tasks run either in Hoplite cloud
// sandboxes against the project's GitHub repos, or on a local Codex/Claude
// agent bound to one of the caller's machines (`executionTarget`), and in both
// cases produce threads and pull requests. Keys are organization-scoped (they
// begin with `hop_`) and are created in app.hoplite.sh organization settings.
// Every request authenticates with the `X-Api-Key` header (`Authorization:
// Bearer` is also accepted by the service, but X-Api-Key takes precedence when
// both are present), and every response carries an `x-request-id` header that is
// surfaced in thrown errors so users can quote it back to Hoplite support. The
// raw key is never logged.

import { serverLog } from '../logger';

const HOPLITE_API_BASE = 'https://api.hoplite.sh';

/** ThreadStatus enum from the published OpenAPI document. */
export type HopliteThreadStatus =
  'queued' | 'running' | 'waiting' | 'blocked' | 'ready' | 'failed' | 'archived' | string;

export interface HopliteProject {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface HoplitePullRequest {
  number?: number;
  url?: string;
  repoFullName?: string;
  state?: string;
  headRef?: string;
  draft?: boolean;
  [key: string]: unknown;
}

export interface HopliteThread {
  id?: string;
  projectId?: string;
  title?: string;
  status?: HopliteThreadStatus;
  pullRequests?: HoplitePullRequest[];
  [key: string]: unknown;
}

export interface HopliteMessage {
  id?: string;
  threadId?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool' | string;
  kind?: 'chat' | 'thinking' | 'tool' | 'status' | string;
  content?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface HopliteGithubInstallation {
  id?: string;
  [key: string]: unknown;
}

export interface HopliteRepository {
  id?: string;
  repoFullName?: string;
  [key: string]: unknown;
}

export interface HopliteBranch {
  name?: string;
  [key: string]: unknown;
}

export interface HopliteRepoRef {
  repoFullName: string;
  branch?: string;
}

/** `speed` enum from the published schema — Hoplite's fast tier. */
export type HopliteSpeed = 'standard' | 'fast';

/** `reasoning.mode` enum from the published schema. */
export type HopliteReasoningMode =
  'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A thread can run on a Hoplite cloud sandbox (omit `executionTarget`) or on an
 * agent bound to one of the caller's own machines. The local form is what makes
 * Hoplite a hybrid provider rather than a cloud-only one.
 */
export interface HopliteLocalAgentExecutionTarget {
  bindingId: string;
  hostId: string;
  kind: 'local';
  model?: string | null;
  provider: 'codex' | 'claude';
  workspaceMode: 'direct' | 'worktree';
}

export type HopliteExecutionTarget = HopliteLocalAgentExecutionTarget;

/** The pull request a thread was opened from, so later runs can address it. */
export interface HopliteSourcePullRequest {
  number: number;
  repositoryId: string;
}

/**
 * POST /api/threads body. The published schema is additionalProperties:false,
 * so only these documented fields are ever sent. Every field beyond
 * `projectId`/`prompt` is optional; omitting one keeps the project's or
 * organization's live default.
 */
export interface HopliteCreateThreadRequest {
  projectId: string;
  prompt: string;
  executionTarget?: HopliteExecutionTarget;
  title?: string;
  model?: string;
  sourcePullRequest?: HopliteSourcePullRequest;
  autoFix?: boolean;
  autoMerge?: boolean;
  speed?: HopliteSpeed;
  reasoning?: { mode: HopliteReasoningMode };
  metadata?: Record<string, unknown>;
  repos?: HopliteRepoRef[];
  initialMessageId?: string;
  initialAttachmentTickets?: string[];
  clientOperationId?: string;
}

export interface HopliteClientOptions {
  apiKey: string;
  signal?: AbortSignal;
}

export interface HopliteHealth {
  ok?: boolean;
  service?: string;
  version?: string;
}

interface HopliteErrorBody {
  ok?: boolean;
  error?: string;
}

/** Carries the structured pieces callers (and tests) need without re-parsing. */
class HopliteApiError extends Error {
  constructor(
    readonly status: number,
    code: string,
    requestId: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    const withRequest = requestId ? ` [x-request-id: ${requestId}]` : '';
    super(`Hoplite API ${status}: ${code}${withRequest}`);
    this.name = 'HopliteApiError';
  }
}

/** Extract the documented payload key from an `{ ok: true, ...payload }` envelope. */
function unwrap<T>(payload: Record<string, unknown>, key: string): T {
  const value = payload[key];
  if (value !== undefined) return value as T;
  // Single-resource endpoints may return the entity without an envelope key;
  // keep the raw payload so callers still get usable data.
  return payload as T;
}

export class HopliteClient {
  constructor(private readonly options: HopliteClientOptions) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      'X-Api-Key': this.options.apiKey,
      'User-Agent': 'Koryphaios/1.0',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async requestOnce<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(`${HOPLITE_API_BASE}${path}`);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const { query: _q, ...rest } = init ?? {};
    const res = await fetch(url.toString(), {
      ...rest,
      headers: {
        ...this.headers(rest.method === 'POST'),
        ...(rest.headers as Record<string, string> | undefined),
      },
      signal: this.options.signal,
    });
    if (res.ok) {
      const text = await res.text();
      if (!text.trim()) return {} as T;
      return JSON.parse(text) as T;
    }

    const bodyText = await res.text().catch(() => '');
    let code = '';
    try {
      const parsed = JSON.parse(bodyText) as HopliteErrorBody;
      if (typeof parsed.error === 'string') code = parsed.error;
    } catch {
      // Non-JSON error body — fall back to a raw snippet.
    }
    if (!code) code = bodyText.slice(0, 200);
    const retryAfter = res.headers.get('retry-after');
    throw new HopliteApiError(
      res.status,
      code,
      res.headers.get('x-request-id'),
      retryAfter === null ? null : Number(retryAfter),
    );
  }

  /**
   * Request with a single rate-limit retry. Hoplite allows 600 requests per
   * rolling 60s and communicates the wait in a 429's Retry-After header; one
   * bounded retry absorbs bursts without turning a transient spike into a
   * caller-visible failure. A second 429 surfaces as a clear error.
   */
  private async request<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    try {
      return await this.requestOnce<T>(path, init);
    } catch (err: unknown) {
      if (!(err instanceof HopliteApiError) || err.status !== 429) throw err;
      const waitSeconds = Math.min(Math.max(err.retryAfterSeconds ?? 0, 0), 60);
      serverLog.debug({ waitSeconds }, 'Hoplite API rate-limited (429); retrying once');
      if (waitSeconds > 0) await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      try {
        return await this.requestOnce<T>(path, init);
      } catch (retryErr: unknown) {
        if (retryErr instanceof HopliteApiError && retryErr.status === 429) {
          throw new Error(
            `Hoplite API rate limit exceeded (429; 600 requests per rolling 60s). Wait ${waitSeconds}s and retry. ${retryErr.message}`,
          );
        }
        throw retryErr;
      }
    }
  }

  /** Unauthenticated liveness probe — also the cheapest connectivity check. */
  async health(): Promise<HopliteHealth> {
    return this.requestOnce<HopliteHealth>('/health', { method: 'GET' });
  }

  async listProjects(): Promise<HopliteProject[]> {
    const data = await this.request<Record<string, unknown>>('/api/projects', { method: 'GET' });
    return unwrap<HopliteProject[]>(data, 'projects');
  }

  async getProject(projectId: string): Promise<HopliteProject> {
    const data = await this.request<Record<string, unknown>>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      { method: 'GET' },
    );
    return unwrap<HopliteProject>(data, 'project');
  }

  async listGithubInstallations(): Promise<HopliteGithubInstallation[]> {
    const data = await this.request<Record<string, unknown>>(
      '/api/source-control/github/installations',
      { method: 'GET' },
    );
    return unwrap<HopliteGithubInstallation[]>(data, 'installations');
  }

  async listRepositories(): Promise<HopliteRepository[]> {
    const data = await this.request<Record<string, unknown>>(
      '/api/source-control/github/repositories',
      { method: 'GET' },
    );
    return unwrap<HopliteRepository[]>(data, 'repositories');
  }

  async listBranches(repoId: string): Promise<HopliteBranch[]> {
    const data = await this.request<Record<string, unknown>>(
      `/api/source-control/github/repositories/${encodeURIComponent(repoId)}/branches`,
      { method: 'GET' },
    );
    return unwrap<HopliteBranch[]>(data, 'branches');
  }

  async inspectRepository(repoId: string): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>(
      `/api/source-control/github/repositories/${encodeURIComponent(repoId)}/inspect`,
      { method: 'GET' },
    );
    return unwrap<Record<string, unknown>>(data, 'inspect');
  }

  async listThreads(): Promise<HopliteThread[]> {
    const data = await this.request<Record<string, unknown>>('/api/threads', { method: 'GET' });
    return unwrap<HopliteThread[]>(data, 'threads');
  }

  async createThread(body: HopliteCreateThreadRequest): Promise<HopliteThread> {
    const data = await this.request<Record<string, unknown>>('/api/threads', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return unwrap<HopliteThread>(data, 'thread');
  }

  async getThread(threadId: string): Promise<HopliteThread> {
    const data = await this.request<Record<string, unknown>>(
      `/api/threads/${encodeURIComponent(threadId)}`,
      { method: 'GET' },
    );
    return unwrap<HopliteThread>(data, 'thread');
  }

  async listMessages(threadId: string): Promise<HopliteMessage[]> {
    const data = await this.request<Record<string, unknown>>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      { method: 'GET' },
    );
    return unwrap<HopliteMessage[]>(data, 'messages');
  }
}
