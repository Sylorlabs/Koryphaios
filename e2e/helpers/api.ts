/**
 * E2E API helper — typed wrapper around Playwright's APIRequestContext for
 * making authenticated requests to the Koryphaios backend.
 */

import type { APIRequestContext } from '@playwright/test';

export class ApiClient {
  constructor(
    private request: APIRequestContext,
    private baseUrl: string,
    private bearerToken?: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.bearerToken) h['Authorization'] = this.bearerToken;
    return h;
  }

  async get(path: string) {
    return this.request.get(`${this.baseUrl}${path}`, { headers: this.headers() });
  }

  async post(path: string, body?: unknown) {
    return this.request.post(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      data: body ? JSON.stringify(body) : undefined,
    });
  }

  async put(path: string, body?: unknown) {
    return this.request.put(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      data: body ? JSON.stringify(body) : undefined,
    });
  }

  async delete(path: string) {
    return this.request.delete(`${this.baseUrl}${path}`, { headers: this.headers() });
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.get(path);
    if (!res.ok()) throw new Error(`GET ${path} failed: ${res.status()}`);
    return res.json() as Promise<T>;
  }

  async postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await this.post(path, body);
    if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()}`);
    return res.json() as Promise<T>;
  }

  /** Creates a session and returns the session ID. */
  async createSession(title = 'E2E test session'): Promise<string> {
    const body = await this.postJson<{ data: { id: string } }>('/api/sessions', {
      title,
      // The backend state directory is intentionally isolated under /tmp, but
      // Time Travel must exercise a real Git worktree rather than treating the
      // disposable state directory as the user's project.
      workingDirectory: process.cwd(),
    });
    return body.data.id;
  }

  /** Sends a message to a session and returns the response. */
  async sendMessage(sessionId: string, content: string, model?: string) {
    return this.post('/api/messages', { sessionId, content, model });
  }

  /** Fetches messages for a session. */
  async getMessages(sessionId: string) {
    return this.getJson<{ data: unknown[] }>(`/api/messages/${sessionId}`);
  }

  /** Checks backend health. */
  async health() {
    return this.getJson<{ ok: boolean; data: unknown }>('/api/health');
  }
}
