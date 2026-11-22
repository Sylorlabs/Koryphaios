#!/usr/bin/env bun
/** CLI client for Kory's existing authenticated session/turn ledger, not a second agent loop. */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class KoryAgentClient {
  private bearer = '';
  constructor(readonly base: string, private fetcher: typeof fetch = fetch) {
    const u = new URL(base);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('Use a loopback HTTP origin');
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const r = await this.fetcher(this.base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(40_000),
      headers: { ...(this.bearer ? { authorization: this.bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
    return j;
  }
  async connect() {
    const h = await this.request('/api/health');
    if (h.data?.id !== 'koryphaios') throw new Error('Not a Koryphaios backend');
    const auth = await this.request('/api/auth/session', 'POST');
    this.bearer = auth.data?.bearerToken;
    if (typeof this.bearer !== 'string' || !this.bearer.startsWith('Bearer ')) throw new Error('Local authentication failed');
  }
  async close() { if (this.bearer) { try { await this.request('/api/auth/session', 'DELETE'); } finally { this.bearer = ''; } } }
  async start(workspace: string, title: string, prompt: string, model: string) {
    const { data: s } = await this.request('/api/sessions', 'POST', { workingDirectory: resolve(workspace), title });
    await this.request(`/api/sessions/${s.id}`, 'PATCH', { agentOverrides: { permissionMode: 'yolo', agentExecutionMode: 'single', criticGateEnabled: false, criticMode: 'off' } });
    try {
      const turn = await this.send(s.id, prompt, model);
      return { sessionId: s.id, ...turn };
    } catch (error) { throw new Error(`Session ${s.id} was created but admission failed: ${String(error)}`); }
  }
  async send(sessionId: string, prompt: string, model: string) {
    return (await this.request('/api/messages', 'POST', { sessionId, content: prompt, model, reasoningLevel: 'none', clientMessageId: `cli_${crypto.randomUUID().replaceAll('-', '')}` })).data;
  }
  /** Cancel-and-continue handoff, so an unattended turn blocked on ask_user can be answered. */
  async steer(sessionId: string) {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, 'POST', { purpose: 'steer' });
  }
  async state(sessionId: string) {
    const j = await this.request('/api/sessions');
    const session = j.data.find((s: any) => s.id === sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return { sessionId, run: j.runStates?.find((r: any) => r.sessionId === sessionId) ?? null, session };
  }
}
function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
export async function main(argv = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' }, workspace: { type: 'string' }, title: { type: 'string' },
    'prompt-file': { type: 'string' }, model: { type: 'string', default: 'logfare:deepseek-v4.1-flash-1017' },
    receipt: { type: 'string' }, 'session-id': { type: 'string' },
  } });
  const action = positionals[0];
  if (!['launch', 'send', 'status', 'messages', 'steer'].includes(action ?? '')) throw new Error('Usage: bun scripts/kory-agent.ts launch --workspace PATH --prompt-file FILE [--title TITLE --model PROVIDER:MODEL --receipt FILE] | status|messages --session-id ID | send --session-id ID --prompt-file FILE');
  if (action === 'launch' && (!values.workspace || !values['prompt-file'])) throw new Error('launch needs --workspace and --prompt-file');
  if (action !== 'launch' && !values['session-id']) throw new Error('Supply --session-id');
  if (action === 'send' && !values['prompt-file']) throw new Error('send needs --prompt-file');
  const client = new KoryAgentClient(values.url!);
  try {
    await client.connect();
    let result: unknown;
    if (action === 'launch') result = await client.start(values.workspace!, values.title ?? 'CLI agent', readFileSync(values['prompt-file']!, 'utf8'), values.model!);
    else if (action === 'send') result = await client.send(values['session-id']!, readFileSync(values['prompt-file']!, 'utf8'), values.model!);
    else if (action === 'status') result = await client.state(values['session-id']!);
    else if (action === 'steer') result = await client.steer(values['session-id']!);
    else result = (await client.request(`/api/messages/${encodeURIComponent(values['session-id']!)}?limit=200`)).data;
    if (values.receipt) atomicJson(resolve(values.receipt), result);
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.close(); }
}
if (import.meta.main) main().catch(e => { console.error(String(e)); process.exitCode = 1; });
