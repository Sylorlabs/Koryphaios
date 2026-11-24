import { test, expect } from 'bun:test';
import { KoryAgentClient } from './kory-agent';
test('rejects remote targets and credential-bearing origins', () => {
  for (const u of [
    'https://example.com',
    'http://example.com',
    'http://user:pass@localhost:3000',
    'http://localhost:3000/api',
    'http://localhost:3000/?token=x',
  ])
    expect(() => new KoryAgentClient(u)).toThrow();
});
test('uses authenticated durable turn path, explicit provider, and revokes auth', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fake = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    let data: unknown = {};
    if (String(url).endsWith('/api/health')) data = { id: 'koryphaios' };
    else if (String(url).endsWith('/api/auth/session') && init.method === 'POST')
      data = { bearerToken: 'Bearer test' };
    else if (String(url).endsWith('/api/sessions') && init.method === 'POST') data = { id: 'ours' };
    else if (String(url).endsWith('/api/messages')) data = { runId: 'run', messageId: 'message' };
    return Response.json({ ok: true, data });
  }) as typeof fetch;
  const c = new KoryAgentClient('http://127.0.0.1:3000', fake);
  await c.connect();
  const result = await c.start('/tmp/ours', 'title', 'prompt', 'logfare:deepseek-v4.1-flash-1017');
  await c.close();
  expect(result).toEqual({ sessionId: 'ours', runId: 'run', messageId: 'message' });
  const m = calls.find((c) => c.url.endsWith('/api/messages'))!;
  expect(JSON.parse(m.init.body).model).toBe('logfare:deepseek-v4.1-flash-1017');
  expect(JSON.parse(m.init.body).clientMessageId).toMatch(/^cli_[a-f0-9]{32}$/);
  expect(m.init.headers.authorization).toBe('Bearer test');
  expect(calls.at(-1)!.init.method).toBe('DELETE');
  expect(calls.every((c) => c.init.redirect === 'error')).toBe(true);
});
test('rejects API errors rather than calling them completion', async () => {
  const c = new KoryAgentClient('http://localhost:3000', (async () =>
    Response.json({ ok: false, error: 'denied' }, { status: 403 })) as typeof fetch);
  await expect(c.request('/api/health')).rejects.toThrow('denied');
});
