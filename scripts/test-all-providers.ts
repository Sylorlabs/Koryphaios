/**
 * Comprehensive provider reachability + verify test (v3).
 *
 * Imports PROVIDER_CONFIGS and OPENCODE_DEFAULT_BASE_URL directly from the
 * backend — no duplicated provider lists. Tests the exact verify URL the
 * backend would hit for every provider and categorizes results.
 *
 * Run: bun run scripts/test-all-providers.ts
 */

import { execSync } from 'node:child_process';
import { PROVIDER_CONFIGS } from '../backend/src/providers/provider-configs';
import { OPENCODE_DEFAULT_BASE_URL } from '../backend/src/providers/constants';
import { PROVIDER_BASE_URLS, getVerifyUrl } from '../backend/src/providers/api-endpoints';

type PCfg = typeof PROVIDER_CONFIGS[number];

const CLI_BINARY_MAP: Record<string, string> = {
  claude: 'claude', codex: 'codex', grok: 'grok', antigravity: 'agy',
  cursor: 'cursor-agent', devin: 'devin', cline: 'cline',
};

function hasBin(bin: string): boolean {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

function envKeyPresent(cfg: PCfg): string | null {
  for (const k of cfg.envKeys) if (process.env[k]) return k;
  if (cfg.envAuthTokenKey && process.env[cfg.envAuthTokenKey]) return cfg.envAuthTokenKey;
  return null;
}

/** Replicate backend getVerifyUrl + the explicit cases in registry.verifyConnection. */
function resolveVerifyUrl(cfg: PCfg): { url: string; method: string; body?: string; extraHeaders?: Record<string,string> } {
  const name = cfg.name;
  // Explicit cases from registry.verifyConnection switch:
  if (name === 'openai') return { url: 'https://api.openai.com/v1/models', method: 'GET' };
  if (name === 'openrouter') return { url: 'https://openrouter.ai/api/v1/models', method: 'GET' };
  if (name === 'mistral') return { url: 'https://api.mistral.ai/v1/models', method: 'GET' };
  if (name === 'groq') return { url: 'https://api.groq.com/openai/v1/models', method: 'GET' };
  if (name === 'xai') return { url: 'https://api.x.ai/v1/models', method: 'GET' };
  if (name === 'copilot') return { url: 'https://api.githubcopilot.com/models', method: 'GET' };
  if (name === 'jules') return { url: 'https://jules.googleapis.com/v1alpha/sources?pageSize=1', method: 'GET' };
  if (name === 'ollama') return { url: 'http://localhost:11434/api/tags', method: 'GET' };
  if (name === 'llamacpp') return { url: 'http://127.0.0.1:8080/v1/models', method: 'GET' };
  if (name === 'lmstudio') return { url: 'http://localhost:1234/v1/models', method: 'GET' };
  if (name === 'zai') return { url: 'https://api.z.ai/api/paas/v4/chat/completions', method: 'POST', body: JSON.stringify({ model: 'glm-4.5', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }) };
  if (name === 'opencodezen') return { url: 'https://opencode.ai/zen/v1/models', method: 'GET' };
  if (name === 'opencodego') return { url: 'https://opencode.ai/zen/go/v1/models', method: 'GET' };

  // Use the backend's getVerifyUrl for all others — it knows the correct path.
  const backendUrl = getVerifyUrl(name as any);
  if (backendUrl) return { url: backendUrl, method: 'GET' };

  // Fall back to OPENCODE_DEFAULT_BASE_URL, then cfg.baseUrl
  const base = OPENCODE_DEFAULT_BASE_URL[name] ?? cfg.baseUrl;
  if (!base) return { url: '', method: 'GET' };

  if (name === 'anthropic') return { url: `${base.replace(/\/?$/, '')}/models`, method: 'GET', extraHeaders: { 'anthropic-version': '2026-01-01' } };

  // Default OpenAI-compatible: <base>/models
  return { url: `${base.replace(/\/?$/, '')}/models`, method: 'GET' };
}

async function probe(url: string, init?: RequestInit, timeoutMs = 7000): Promise<{ status?: number; ok: boolean; error?: string; body?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'Koryphaios/1.0');
    if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer koryphaios-reachability-probe');
    const res = await fetch(url, { method: init?.method ?? 'GET', ...init, headers, signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, body: text.slice(0, 160) };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('abort') || msg.includes('timeout')) return { ok: false, error: 'timeout' };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function classify(r: { status?: number; ok: boolean; error?: string }): { alive: boolean; verdict: string } {
  if (r.ok) return { alive: true, verdict: 'OK (200)' };
  const s = r.status;
  if (s === 401 || s === 403) return { alive: true, verdict: `ALIVE (HTTP ${s} — auth required, URL correct)` };
  if (s === 400 || s === 422) return { alive: true, verdict: `ALIVE (HTTP ${s} — endpoint exists)` };
  if (s === 404) return { alive: false, verdict: 'FIX (HTTP 404 — wrong path)' };
  if (s && s >= 500) return { alive: true, verdict: `ALIVE but unhealthy (HTTP ${s})` };
  if (r.error === 'timeout') return { alive: false, verdict: 'FIX (timeout — unreachable)' };
  if (r.error?.includes('certificate')) return { alive: false, verdict: `FIX (TLS: ${r.error.slice(0,50)})` };
  if (r.error?.includes('fetch failed') || r.error?.includes('ENOTFOUND') || r.error?.includes('ECONNREFUSED') || r.error?.includes('Unable to connect') || r.error?.includes('socket connection was closed')) {
    return { alive: false, verdict: `FIX (unreachable: ${(r.error??'').slice(0,50)})` };
  }
  return { alive: false, verdict: `FIX (${(r.error ?? '').slice(0, 50)})` };
}

(async () => {
  const results: Array<{ name: string; category: 'OK'|'CLI'|'LOCAL'|'ENV'|'FIX'|'NOURL'; verdict: string; detail: string }> = [];

  for (const cfg of PROVIDER_CONFIGS) {
    const envKey = envKeyPresent(cfg);

    if (CLI_BINARY_MAP[cfg.name]) {
      const bin = CLI_BINARY_MAP[cfg.name];
      const installed = hasBin(bin);
      results.push({ name: cfg.name, category: 'CLI', verdict: installed ? 'CLI INSTALLED' : 'CLI NOT ON PATH', detail: `binary: ${bin}` });
      continue;
    }

    if (cfg.authMode === 'env_auth') {
      const hasAws = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
      const hasVertex = !!process.env.GOOGLE_VERTEX_AI_API_KEY;
      const ready = cfg.name === 'bedrock' ? hasAws : hasVertex;
      results.push({ name: cfg.name, category: 'ENV', verdict: ready ? 'ENV READY' : 'ENV NOT SET', detail: cfg.name === 'bedrock' ? 'needs AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY' : 'needs GOOGLE_VERTEX_AI_API_KEY' });
      continue;
    }

    if (cfg.name === 'local') {
      results.push({ name: cfg.name, category: 'LOCAL', verdict: 'NEEDS USER BASE URL', detail: 'no default endpoint; user-supplied' });
      continue;
    }

    if (cfg.authMode === 'base_url_only') {
      const { url } = resolveVerifyUrl(cfg);
      if (!url) {
        results.push({ name: cfg.name, category: 'LOCAL', verdict: 'NEEDS USER BASE URL', detail: 'no default endpoint; user-supplied' });
        continue;
      }
      const r = await probe(url);
      const c = classify(r);
      // base_url_only providers are local servers — not running is expected, not a bug.
      const isLocalUnreachable = !c.alive;
      results.push({ name: cfg.name, category: isLocalUnreachable ? 'LOCAL' : 'OK', verdict: isLocalUnreachable ? 'LOCAL SERVER NOT RUNNING (expected)' : c.verdict, detail: `url: ${url} status=${r.status ?? r.error}` });
      continue;
    }

    const { url, method, body, extraHeaders } = resolveVerifyUrl(cfg);
    if (!url) {
      results.push({ name: cfg.name, category: 'NOURL', verdict: 'NO BASE URL (needs user-supplied endpoint)', detail: 'auth_only/cli/env without default endpoint' });
      continue;
    }
    const init: RequestInit = { method };
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (body) init.body = body;
    init.headers = headers;
    const r = await probe(url, init);
    const c = classify(r);
    const envNote = envKey ? `env=${envKey} set` : 'no env key';
    results.push({ name: cfg.name, category: c.alive ? 'OK' : 'FIX', verdict: c.verdict, detail: `url: ${url} status=${r.status ?? r.error} | ${envNote}` });
  }

  const byCat = (cat: string) => results.filter((r) => r.category === cat);
  console.log(`\n=== PROVIDER REACHABILITY TEST v3 (${results.length} providers) ===\n`);
  for (const r of results) {
    const mark = r.category === 'OK' || r.category === 'CLI' ? 'OK ' : (r.category === 'LOCAL' || r.category === 'ENV' || r.category === 'NOURL' ? '-- ' : 'XX ');
    console.log(`${mark} ${r.name.padEnd(16)} [${r.category.padEnd(5)}] ${r.verdict}`);
    console.log(`     ${r.detail}`);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${results.length}`);
  console.log(`OK (reachable): ${byCat('OK').length}`);
  console.log(`CLI (installed): ${byCat('CLI').length}`);
  console.log(`LOCAL (server not running, expected): ${byCat('LOCAL').length}`);
  console.log(`ENV (env not set, expected): ${byCat('ENV').length}`);
  console.log(`NOURL (needs user endpoint): ${byCat('NOURL').length}`);
  console.log(`FIX (404/unreachable/TLS — needs code fix): ${byCat('FIX').length}`);
  console.log(`\n--- PROVIDERS NEEDING A FIX ---`);
  for (const r of byCat('FIX')) console.log(`  - ${r.name.padEnd(16)} ${r.verdict}  |  ${r.detail}`);
})();
