// Integration tests for API endpoints
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const TEST_PORT = 3301;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
let serverProc: Bun.Subprocess | null = null;
let authToken = '';
setDefaultTimeout(30000);

type ReqOpts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: unknown;
};

function request(path: string, opts: ReqOpts = {}) {
  const args = [
    '-sS',
    '--path-as-is',
    '-X',
    opts.method ?? 'GET',
    '-o',
    '-',
    '-w',
    '\n%{http_code}',
    `${BASE_URL}${path}`,
  ];
  const headers = opts.headers ?? {};
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (opts.body !== undefined) {
    args.push(
      '--data-binary',
      typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    );
  }

  const proc = Bun.spawnSync(['curl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : '';
    throw new Error(stderr || `curl exited ${proc.exitCode}`);
  }

  const output = proc.stdout ? new TextDecoder().decode(proc.stdout) : '';
  const idx = output.lastIndexOf('\n');
  const bodyText = idx >= 0 ? output.slice(0, idx) : '';
  const status = Number(idx >= 0 ? output.slice(idx + 1).trim() : '0');
  let json: any = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }

  return { status, bodyText, json };
}

async function waitForServerReady(timeoutMs = 60000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = request('/api/health');
      if (res.status === 200) return;
    } catch {
      // Retry until timeout
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  let stderr = '';
  if (serverProc?.stderr) {
    const stderrText = await new Response(serverProc.stderr).text();
    stderr = stderrText.trim();
  }

  throw new Error(
    `Backend did not become ready on ${BASE_URL} within ${timeoutMs}ms${stderr ? `\n${stderr}` : ''}`,
  );
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { Authorization: authToken, ...extra } : extra;
}

beforeAll(async () => {
  const backendDir = join(dirname(import.meta.dir), 'src', '..');
  serverProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: backendDir,
    env: {
      ...process.env,
      KORYPHAIOS_PORT: String(TEST_PORT),
      SESSION_TOKEN_SECRET:
        process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa',
      JWT_SECRET:
        process.env.JWT_SECRET ??
        'test_secret_for_testing_only_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    stdout: 'ignore',
    stderr: 'pipe', // Capture stderr to debug startup issues
  });
  await waitForServerReady();

  const sessionRes = request('/api/auth/session', { method: 'POST' });
  if (sessionRes.status !== 200 || !sessionRes.json?.data?.bearerToken) {
    throw new Error(`Failed to initialize test auth: ${sessionRes.bodyText}`);
  }
  authToken = sessionRes.json.data.bearerToken;
});

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
});

describe('API Integration Tests', () => {
  describe('GET /api/health', () => {
    test('returns health status', async () => {
      const res = request('/api/health');

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data).toHaveProperty('version');
    });
  });

  describe('Sessions API', () => {
    let sessionId: string;

    test('POST /api/sessions creates a new session', async () => {
      const res = request('/api/sessions', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: { title: 'Test Session' },
      });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data).toHaveProperty('id');
      expect(res.json?.data?.title).toBe('Test Session');

      sessionId = res.json.data.id;
    });

    test('GET /api/sessions lists all sessions', async () => {
      const res = request('/api/sessions', { headers: authHeaders() });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
      expect(res.json.data.length).toBeGreaterThan(0);
    });

    test('GET /api/sessions/:id returns session details', async () => {
      const res = request(`/api/sessions/${sessionId}`, { headers: authHeaders() });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data?.id).toBe(sessionId);
    });

    test('PATCH /api/sessions/:id updates session title', async () => {
      const newTitle = 'Updated Test Session';
      const res = request(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: { title: newTitle },
      });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(res.json?.data?.title).toBe(newTitle);
    });

    test('GET /api/messages/:sessionId returns array', async () => {
      const res = request(`/api/messages/${sessionId}`, { headers: authHeaders() });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
    });

    test('DELETE /api/sessions/:id deletes session', async () => {
      const res = request(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);

      const getRes = request(`/api/sessions/${sessionId}`, { headers: authHeaders() });
      expect(getRes.status).toBe(404);
    });
  });

  describe('Providers API', () => {
    test('GET /api/providers returns provider status', async () => {
      const res = request('/api/providers', { headers: authHeaders() });

      expect(res.status).toBe(200);
      expect(res.json?.ok).toBe(true);
      expect(Array.isArray(res.json?.data)).toBe(true);
    });
  });

  describe('CORS Headers', () => {
    test('handles preflight OPTIONS request', async () => {
      const res = request('/api/sessions', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(204);
    });
  });
});
