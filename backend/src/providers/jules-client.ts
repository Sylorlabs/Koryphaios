// Jules REST API client (v1alpha) — API-only, no CLI.
// https://developers.google.com/jules/api

const JULES_API_BASE = 'https://jules.googleapis.com/v1alpha';

export type JulesSessionState =
  | 'QUEUED'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'AWAITING_USER_FEEDBACK'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | string;

export interface JulesSource {
  name: string;
  id?: string;
  githubRepo?: { owner: string; repo: string };
}

export interface JulesSession {
  name?: string;
  id?: string;
  title?: string;
  prompt?: string;
  state?: JulesSessionState;
  url?: string;
  createTime?: string;
  updateTime?: string;
  outputs?: Array<{
    pullRequest?: { url?: string; title?: string; description?: string };
  }>;
  sourceContext?: {
    source?: string;
    githubRepoContext?: { startingBranch?: string };
  };
}

export interface JulesActivity {
  name?: string;
  id?: string;
  createTime?: string;
  originator?: 'agent' | 'user' | string;
  planGenerated?: {
    plan?: {
      id?: string;
      steps?: Array<{ id?: string; title?: string; index?: number }>;
    };
  };
  planApproved?: { planId?: string };
  progressUpdated?: { title?: string; description?: string };
  sessionCompleted?: Record<string, never>;
  artifacts?: Array<{
    bashOutput?: { command?: string; output?: string; exitCode?: number };
    changeSet?: {
      source?: string;
      gitPatch?: {
        unidiffPatch?: string;
        baseCommitId?: string;
        suggestedCommitMessage?: string;
      };
    };
    media?: { data?: string; mimeType?: string };
  }>;
}

export interface JulesClientOptions {
  apiKey: string;
  signal?: AbortSignal;
}

export class JulesClient {
  constructor(private readonly options: JulesClientOptions) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      'X-Goog-Api-Key': this.options.apiKey,
      'User-Agent': 'Koryphaios/1.0',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async request<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(`${JULES_API_BASE}${path}`);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const { query: _q, ...rest } = init ?? {};
    const res = await fetch(url.toString(), {
      ...rest,
      headers: { ...this.headers(rest.method === 'POST' || rest.method === 'PATCH'), ...(rest.headers as Record<string, string> | undefined) },
      signal: this.options.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jules API ${res.status}: ${body.slice(0, 400)}`);
    }
    if (res.status === 204) return {} as T;
    const text = await res.text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  }

  async listSources(pageSize = 50): Promise<JulesSource[]> {
    const out: JulesSource[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<{ sources?: JulesSource[]; nextPageToken?: string }>(
        '/sources',
        { method: 'GET', query: { pageSize, pageToken } },
      );
      out.push(...(data.sources ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken && out.length < 200);
    return out;
  }

  async createSession(body: {
    prompt: string;
    title?: string;
    sourceContext?: {
      source: string;
      githubRepoContext?: { startingBranch?: string };
    };
    requirePlanApproval?: boolean;
    automationMode?: string;
  }): Promise<JulesSession> {
    return this.request<JulesSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getSession(sessionId: string): Promise<JulesSession> {
    return this.request<JulesSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
  }

  async sendMessage(sessionId: string, prompt: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  async approvePlan(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}:approvePlan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async listActivities(
    sessionId: string,
    opts?: { pageSize?: number; createTime?: string },
  ): Promise<JulesActivity[]> {
    const data = await this.request<{ activities?: JulesActivity[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/activities`,
      {
        method: 'GET',
        query: { pageSize: opts?.pageSize ?? 50, createTime: opts?.createTime },
      },
    );
    return data.activities ?? [];
  }
}

export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = trimmed.match(/https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

export async function resolveGitHubRepoFromDir(
  workingDirectory: string,
): Promise<{ owner: string; repo: string; branch: string } | null> {
  try {
    const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
      cwd: workingDirectory,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const remote = (await new Response(proc.stdout).text()).trim();
    const exit = await proc.exited;
    if (exit !== 0 || !remote) return null;
    const parsed = parseGitHubRemote(remote);
    if (!parsed) return null;

    const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workingDirectory,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const branch = (await new Response(branchProc.stdout).text()).trim() || 'main';
    await branchProc.exited;
    return { ...parsed, branch };
  } catch {
    return null;
  }
}

export function matchJulesSource(
  sources: JulesSource[],
  owner: string,
  repo: string,
): JulesSource | undefined {
  const needle = `${owner}/${repo}`.toLowerCase();
  return sources.find((s) => {
    const gh = s.githubRepo;
    if (gh) return `${gh.owner}/${gh.repo}`.toLowerCase() === needle;
    const id = (s.id ?? s.name ?? '').toLowerCase();
    return id.includes(owner.toLowerCase()) && id.includes(repo.toLowerCase());
  });
}