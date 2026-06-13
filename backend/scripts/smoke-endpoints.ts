#!/usr/bin/env bun
/**
 * API endpoint smoke test — hits a RUNNING Koryphaios backend over HTTP, mints a
 * local session token via /api/auth/session, and exercises the key routes. Reads the
 * live port from .koryphaios/.active-port.json.
 *
 * Usage:  bun run backend/scripts/smoke-endpoints.ts        (auto-detects port)
 *         BASE_URL=http://127.0.0.1:3099 bun run .../smoke-endpoints.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function resolveBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  // walk up to find the repo root .koryphaios/.active-port.json
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.koryphaios', '.active-port.json');
    if (existsSync(p)) {
      try {
        const info = JSON.parse(readFileSync(p, 'utf-8'));
        if (info.url) return String(info.url).replace(/\/$/, '');
      } catch {
        /* fall through */
      }
    }
    dir = join(dir, '..');
  }
  return 'http://127.0.0.1:3001';
}

const BASE = resolveBaseUrl();

interface Check {
  name: string;
  method?: string;
  path: string;
  expectStatus?: number;
  // Optional assertion on the parsed JSON body; return null if ok, else an error string.
  assert?: (body: any) => string | null;
}

let token = '';

const checks: Check[] = [
  { name: 'health (public)', path: '/api/health', assert: (b) => (b?.ok ? null : 'ok!=true') },
  { name: 'project (public)', path: '/api/project' },
  {
    name: 'providers/status (claude present)',
    path: '/api/providers/status',
    assert: (b) => {
      if (!b?.ok) return 'ok!=true';
      const claude = (b.data ?? []).find((p: any) => p.name === 'claude');
      if (!claude) return 'claude provider missing from status';
      if (claude.authMode !== 'auth_only') return `claude authMode=${claude.authMode}`;
      return null;
    },
  },
  {
    name: 'providers/available',
    path: '/api/providers/available',
    assert: (b) =>
      (b?.data ?? []).some((p: any) => p.name === 'claude') ? null : 'claude not in available types',
  },
  {
    name: 'connect Claude Code (auth/start)',
    method: 'POST',
    path: '/api/providers/claude/auth/start',
    assert: (b) =>
      b?.data?.status === 'connected'
        ? null
        : `not connected (run "claude login"?): ${JSON.stringify(b?.data ?? b)}`,
  },
  {
    name: 'claude models appear after connect',
    path: '/api/providers/status',
    assert: (b) => {
      const claude = (b?.data ?? []).find((p: any) => p.name === 'claude');
      if (!claude) return 'claude missing';
      if (!claude.enabled) return 'claude not enabled after connect';
      if (!Array.isArray(claude.allAvailableModels) || claude.allAvailableModels.length < 3)
        return `claude has ${claude.allAvailableModels?.length ?? 0} models (expected >=3)`;
      return null;
    },
  },
  {
    name: 'billing/credits',
    path: '/api/billing/credits',
    assert: (b) => {
      if (!b?.ok) return 'ok!=true';
      if (!('subscriptions' in b)) return 'missing subscriptions field';
      if (!Array.isArray(b.byProvider)) return 'byProvider not array';
      return null;
    },
  },
  { name: 'sessions list', path: '/api/sessions', assert: (b) => (b?.ok ? null : 'ok!=true') },
  { name: 'spend/status', path: '/api/spend/status', assert: (b) => (b?.ok ? null : 'ok!=true') },
  {
    name: 'spend-caps/status',
    path: '/api/spend-caps/status',
    assert: (b) => (b?.ok ? null : 'ok!=true'),
  },
  {
    name: 'spend-caps/sessions/:id (was flagged broken)',
    path: '/api/spend-caps/sessions/test-session',
    assert: (b) => (b?.ok ? null : 'ok!=true'),
  },
  { name: 'mode', path: '/api/mode', assert: (b) => (b?.ok ? null : 'ok!=true') },
  { name: 'memory/stats', path: '/api/memory/stats', assert: (b) => (b?.ok ? null : 'ok!=true') },
  { name: 'agent/settings', path: '/api/agent/settings', assert: (b) => (b?.ok ? null : 'ok!=true') },
  {
    name: 'auth rejects no token (401)',
    path: '/api/providers/status',
    expectStatus: 401,
    method: 'GET_NOAUTH',
  },
];

async function mintToken(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/session`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.1' },
  });
  const body = (await res.json()) as any;
  if (!body?.data?.bearerToken) throw new Error(`Failed to mint token: ${JSON.stringify(body)}`);
  token = body.data.bearerToken;
}

async function run(): Promise<void> {
  console.log(`\nAPI endpoint smoke test → ${BASE}\n${'─'.repeat(60)}`);
  await mintToken();
  console.log('✓ minted local session token\n');

  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    const noAuth = c.method === 'GET_NOAUTH';
    const method = noAuth ? 'GET' : c.method || 'GET';
    const headers: Record<string, string> = { 'x-forwarded-for': '127.0.0.1' };
    if (!noAuth) headers.authorization = token;

    try {
      const res = await fetch(`${BASE}${c.path}`, { method, headers });
      const expectStatus = c.expectStatus ?? 200;
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON */
      }
      let err: string | null = null;
      if (res.status !== expectStatus) err = `status ${res.status} != ${expectStatus}`;
      else if (c.assert) err = c.assert(body);

      if (err) {
        fail++;
        console.log(`✗ ${c.name.padEnd(46)} ${err}`);
      } else {
        pass++;
        console.log(`✓ ${c.name.padEnd(46)} [${res.status}]`);
      }
    } catch (e) {
      fail++;
      console.log(`✗ ${c.name.padEnd(46)} threw: ${(e as Error).message}`);
    }
  }

  // ── Custom (bring-your-own) provider flow ──
  console.log('\nCustom provider flow:');
  const headers = { 'content-type': 'application/json', authorization: token, 'x-forwarded-for': '127.0.0.1' };
  try {
    const add = await fetch(`${BASE}/api/providers/custom`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        label: 'Smoke Test LLM',
        kind: 'openai',
        baseUrl: 'https://smoke.example/v1',
        apiKey: 'sk-smoke',
        models: ['smoke-model-1', 'smoke-model-2'],
      }),
    });
    const addBody: any = await add.json();
    const id = addBody?.data?.id;
    if (addBody?.ok && id) {
      pass++;
      console.log(`✓ ${'add custom provider'.padEnd(46)} [${add.status}] id=${id}`);
    } else {
      fail++;
      console.log(`✗ add custom provider: ${JSON.stringify(addBody)}`);
    }

    // It should appear in status with the right form fields.
    const st = await fetch(`${BASE}/api/providers/status`, { headers });
    const stBody: any = await st.json();
    const custom = (stBody.data ?? []).find((p: any) => p.name === id);
    const fieldsOk = custom && custom.custom === true && custom.requiresBaseUrl === true && custom.supportsApiKey === true;
    const modelsOk = custom && (custom.allAvailableModels ?? []).some((m: any) => m.id === 'smoke-model-1');
    if (fieldsOk && modelsOk) {
      pass++;
      console.log(`✓ ${'custom provider in status w/ fields+models'.padEnd(46)} [${st.status}]`);
    } else {
      fail++;
      console.log(`✗ custom provider status: fields=${fieldsOk} models=${modelsOk} ${JSON.stringify(custom)?.slice(0, 200)}`);
    }

    // Clean up.
    if (id) {
      const del = await fetch(`${BASE}/api/providers/custom/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      const delBody: any = await del.json();
      if (delBody?.ok) {
        pass++;
        console.log(`✓ ${'delete custom provider'.padEnd(46)} [${del.status}]`);
      } else {
        fail++;
        console.log(`✗ delete custom provider: ${JSON.stringify(delBody)}`);
      }
    }
  } catch (e) {
    fail++;
    console.log(`✗ custom provider flow threw: ${(e as Error).message}`);
  }

  console.log(`${'─'.repeat(60)}\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
