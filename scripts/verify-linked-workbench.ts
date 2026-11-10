#!/usr/bin/env bun
// Live, read-only target execution check. No authentication material is logged.
const base = 'http://127.0.0.1:3001';
let bearer = '';
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(base + path, { method,
    headers: { ...(bearer ? { authorization: bearer } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(`${path}: ${value.error ?? `HTTP ${response.status}`}${value.correlationId ? ` (${value.correlationId})` : ''}`);
  return value.data;
}
try {
  bearer = (await api('/api/auth/session', 'POST')).bearerToken;
  const status = await api('/api/devices');
  if (status.workbenchVersion !== 1) throw new Error('Restart the desktop backend to load target-provider staging.');
  const target = status.peers.find((peer: any) => peer.os === 'Linux' && peer.kind === 'desktop' && peer.online);
  if (!target) throw new Error('No online linked Linux desktop.');
  const rpc = async (operation: string, input: Record<string, unknown> = {}) => {
    try { return await api(`/api/devices/${target.id}/rpc`, 'POST', { operation, input }); }
    catch (error) { throw new Error(`${operation}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const providers = await api('/api/providers/status');
  const requested = process.argv[2] ?? 'antigravity';
  const provider = providers.find((item: any) => item.name === requested && item.adapterAvailable);
  if (!provider) throw new Error('The requested desktop provider is unavailable.');
  const models = provider.allAvailableModels.filter((model: any) => provider.models.includes(model.id));
  const model = models.find((item: any) => /flash|mini|haiku/i.test(item.id)) ?? models[0];
  if (!model) throw new Error('The selected provider has no enabled model.');
  const workspaces = await rpc('workspaces');
  const workspace = workspaces.find((item: any) => item.displayPath === '/var/lib/koryphaios/workspace') ?? workspaces[0];
  if (!workspace) throw new Error('No shared target workspace.');
  const chat = await rpc('create_chat', { workspaceId: workspace.id, title: `Remote execution check · ${requested}` });
  await rpc('open_chat', { sessionId: chat.id });
  const overrides = await rpc('workbench', { sessionId: chat.id, path: `/api/sessions/${chat.id}`,
    method: 'PATCH', body: { agentOverrides: { agentExecutionMode: 'single', criticGateEnabled: false } } });
  if (overrides.status !== 200) throw new Error('Could not scope the read-only verification turn.');
  for (const path of ['/api/git/status', `/api/agent/threads/${chat.id}`, `/api/processes?sessionId=${chat.id}`]) {
    const control = await rpc('workbench', { sessionId: chat.id, path });
    if (control.status !== 200) throw new Error(`Target workbench control failed: ${path} (HTTP ${control.status}).`);
  }
  const submitted = await rpc('prompt', { sessionId: chat.id, useLocalProviders: true,
    model: `${provider.name}:${model.id}`,
    content: 'This is a bounded, read-only device-routing verification. Use the Koryphaios terminal tool to run `/usr/bin/uname -s` and `pwd` on this machine. Report the exact outputs in your final response. Do not edit files, start services, delegate work, or request a plan. Complete this verification now.' });
  if (!submitted.accepted) throw new Error('Target turn was not accepted.');
  console.log(JSON.stringify({ sessionId: chat.id, target: target.name, provider: requested, model: model.id, accepted: true }));
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const snapshot = await rpc('snapshot', { sessionId: chat.id });
    if (snapshot.question) {
      console.log(JSON.stringify({ sessionId: chat.id, waitingForUser: true, question: snapshot.question.question, options: snapshot.question.options }));
      break;
    }
    if (snapshot.run?.status === 'terminal') {
      const answer = snapshot.messages.filter((message: any) => message.role === 'assistant').at(-1)?.content ?? '';
      const linux = /\bLinux\b/.test(answer);
      console.log(JSON.stringify({ sessionId: chat.id, phase: snapshot.run.phase, reason: snapshot.run.terminalReason, linuxConfirmed: linux, answer }));
      if (snapshot.run.phase !== 'done' || !linux) process.exitCode = 1;
      break;
    }
  }
} finally { if (bearer) await api('/api/auth/session', 'DELETE').catch(() => undefined); }
