#!/usr/bin/env bun
/**
 * Explicit opt-in live test: a real LLM provider drives a real tool-calling
 * loop against a real MCP server through Koryphaios' actual ToolRegistry.
 *
 * The proof is deliberately not "the tool exists". The fixture MCP server holds
 * a secret that is never sent to the model, so the final answer can only be
 * correct if the provider really emitted a tool call, Koryphaios really
 * dispatched it over MCP, and the real result really came back into the model.
 *
 *   KORY_RUN_LIVE_PROVIDER_TESTS=1 \
 *   OPENCODE_ZEN_API_KEY=... \
 *   bun --no-env-file scripts/probe-mcp-agent-live.ts
 *
 * Optional: also drive a real hosted MCP server from the official registry.
 *   ... probe-mcp-agent-live.ts --remote https://api.fetcher.cloud/mcp render_page
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.KORY_RUN_LIVE_PROVIDER_TESTS !== '1') {
  console.error(
    'Set KORY_RUN_LIVE_PROVIDER_TESTS=1 to authorize real provider calls against a real MCP server.',
  );
  process.exit(2);
}

const SECRET = '4271';
const root = mkdtempSync(join(tmpdir(), 'kory-mcp-agent-live-'));
process.env.DATABASE_URL = join(root, 'probe.db');
process.env.KORYPHAIOS_DATA_DIR = join(root, 'data');
process.env.PROJECT_ROOT = root;

const { OpenAIProvider } = await import('../backend/src/providers/openai');
const { MCPClient } = await import('../backend/src/mcp/client');
const { ToolRegistry } = await import('../backend/src/tools/registry');
const { statSync } = await import('node:fs');
const { registerMCPToolsInRegistry } = await import('../backend/src/mcp/tool-bridge');
const { mapSearchResult } = await import('../backend/src/routes/v1/mcp-registry');

const API_KEY = process.env.OPENCODE_ZEN_API_KEY?.trim();
if (!API_KEY) {
  console.error('OPENCODE_ZEN_API_KEY is required.');
  process.exit(2);
}

const MODEL = process.env.KORY_MCP_PROBE_MODEL ?? 'space-bunny-free';
const BASE_URL = 'https://opencode.ai/zen/v1';

// ─── A local stdio MCP server that guards a secret ──────────────────────────

const FIXTURE_SERVER = String.raw`
let input = '';
process.stdin.setEncoding('utf8');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let nl;
  while ((nl = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, nl);
    input = input.slice(nl + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }

    if (req.method === 'server/discover') {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
    } else if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { capabilities: { tools: {} } } });
    } else if (req.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [{
            name: 'lookup_release_code',
            description: 'Look up the internal release code for a given product codename. You MUST call this tool to answer questions about release codes; the value is never present in your context.',
            inputSchema: {
              type: 'object',
              properties: { codename: { type: 'string', description: 'Product codename, e.g. "falcon"' } },
              required: ['codename'],
            },
          }],
        },
      });
    } else if (req.method === 'tools/call') {
      const args = (req.params && req.params.arguments) || {};
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{
            type: 'text',
            text: 'release code for ' + args.codename + ' is ' + ${JSON.stringify(SECRET)} + ' (source: internal release registry)',
          }],
        },
      });
    }
  }
});
setInterval(() => {}, 1000).unref();
`;

// ─── Provider tool-call loop ────────────────────────────────────────────────

interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

async function runTurn(
  provider: InstanceType<typeof OpenAIProvider>,
  registry: ToolRegistry,
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
  sessionId: string,
  expectSecret: string | null,
  /** Accumulates tool calls across every pass, so a follow-up pass that makes
   *  no further calls does not erase the ones that already ran. */
  allToolCalls: CompletedToolCall[] = [],
): Promise<{ text: string; toolCalls: CompletedToolCall[] }> {
  let content = '';
  const pending = new Map<string, { name: string; input: string }>();
  const completed: CompletedToolCall[] = [];
  const seen = new Set<string>();
  let sawError: string | undefined;

  for await (const event of provider.streamResponse({
    model: MODEL,
    systemPrompt,
    messages: messages as never,
    tools: registry.getToolDefsForRole('manager'),
    sessionId,
    workingDirectory: root,
    harnessRole: 'manager',
    maxTokens: 900,
  })) {
    if (event.type === 'content_delta') content += event.content ?? '';
    else if (event.type === 'tool_use_start') {
      if (!event.toolCallId || !event.toolName) throw new Error('tool_use_start missing identity');
      if (seen.has(event.toolCallId)) throw new Error('duplicate tool call id');
      seen.add(event.toolCallId);
      pending.set(event.toolCallId, { name: event.toolName, input: '' });
    } else if (event.type === 'tool_use_delta') {
      const tc = pending.get(event.toolCallId ?? '');
      if (!tc) throw new Error('tool_use_delta with no active call');
      tc.input += event.toolInput ?? '';
    } else if (event.type === 'tool_use_stop') {
      const tc = pending.get(event.toolCallId ?? '');
      if (!tc) throw new Error('tool_use_stop for unknown call');
      pending.delete(event.toolCallId!);
      completed.push({ id: event.toolCallId!, name: tc.name, input: JSON.parse(tc.input || '{}') });
    } else if (event.type === 'error') {
      sawError = event.error;
    }
  }

  if (pending.size > 0) throw new Error('stream ended with incomplete tool calls');
  if (sawError) throw new Error(`provider error: ${sawError}`);

  if (completed.length === 0) {
    if (expectSecret && content.includes(expectSecret)) {
      throw new Error(
        'model produced the secret without calling any tool — fixture is compromised',
      );
    }
    return { text: content, toolCalls: allToolCalls };
  }

  // Execute through the real ToolRegistry and feed results back.
  messages.push({
    role: 'assistant',
    content,
    tool_calls: completed.map((c) => ({ id: c.id, name: c.name, input: c.input })),
  });

  for (const call of completed) {
    const result = await registry.execute(
      {
        sessionId,
        agentId: 'mcp-live-probe',
        callerRole: 'manager',
        workingDirectory: root,
        settingsRoot: root,
        allowedPaths: [root],
        validateToolInput: true,
      },
      { id: call.id, name: call.name, input: call.input },
    );
    console.log(
      `      tool ${call.name}(${JSON.stringify(call.input)}) -> ${
        result.isError ? 'ERROR' : 'ok'
      }: ${result.output.slice(0, 90)}`,
    );
    if (result.isError) throw new Error(`MCP tool execution failed: ${result.output}`);
    messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: call.id });
    allToolCalls.push(call);
  }

  // Second pass: the model must now answer using the tool result.
  return runTurn(provider, registry, messages, systemPrompt, sessionId, null, allToolCalls);
}

// ─── Scenario 1: local stdio MCP server ─────────────────────────────────────

console.log(`\n=== Scenario 1: agent -> local stdio MCP server (${MODEL}) ===`);

const registry = new ToolRegistry();
const localClient = await (async () => {
  const client = new MCPClient({
    name: 'release_registry',
    transport: 'stdio',
    command: process.execPath,
    args: ['--no-env-file', '-e', FIXTURE_SERVER],
  });
  await client.connect();
  return client;
})();

const registered = await registerMCPToolsInRegistry(registry, localClient);
console.log(`  connected, registered ${registered} MCP tool(s)`);
console.log(
  `  advertised to model: ${registry
    .getToolDefsForRole('manager')
    .map((t) => t.name)
    .join(', ')}`,
);

const provider = new OpenAIProvider(
  { name: 'opencodezen', apiKey: API_KEY, disabled: false },
  'opencodezen',
  BASE_URL,
);

const messages: Array<Record<string, unknown>> = [
  {
    role: 'user',
    content: 'What is the internal release code for the product codename "falcon"? Use the tool.',
  },
];

const outcome = await runTurn(
  provider,
  registry,
  messages,
  'You are a release engineer. Always use the provided tool to look up release codes.',
  'mcp-live-stdio',
  SECRET,
);

const mcpCalled = outcome.toolCalls.some(
  (c) => c.name === 'mcp_release_registry_lookup_release_code',
);
const answered = outcome.text.includes(SECRET);

console.log(`\n  MCP tool called by the live agent: ${mcpCalled ? 'YES' : 'NO'}`);
console.log(`  agent's final answer contains the tool-only value: ${answered ? 'YES' : 'NO'}`);
console.log(`  agent answer: ${outcome.text.trim().slice(0, 200)}`);

await localClient.shutdown();

// ─── Scenario 2: a real hosted server from the official registry ────────────

const remoteIndex = process.argv.indexOf('--remote');
if (remoteIndex !== -1 && process.argv[remoteIndex + 1]) {
  const url = process.argv[remoteIndex + 1];
  const expectedTool = process.argv[remoteIndex + 2] ?? null;

  console.log(`\n=== Scenario 2: agent -> real registry server ${url} ===`);

  // Prove the Settings browse flow can reach this server unchanged.
  const res = await fetch(
    `https://registry.modelcontextprotocol.io/v0.1/servers?limit=100&version=latest`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
  );
  const listing = (await res.json()) as { servers?: Array<{ server: never }> };
  const mapped = (listing.servers ?? [])
    .map((item) => mapSearchResult(item as never))
    .find((m) => m?.url === url);
  console.log(
    `  registry mapping: ${mapped ? `${mapped.name} [${mapped.transport}]` : 'not in first 100 (probing URL directly)'}`,
  );

  const remoteRegistry = new ToolRegistry();
  const remoteClient = new MCPClient({ name: 'remote_probe', transport: 'sse', url });
  await remoteClient.connect();
  const remoteTools = await registerMCPToolsInRegistry(remoteRegistry, remoteClient);
  console.log(`  connected, registered ${remoteTools} MCP tool(s) from the hosted server`);
  console.log(
    `  advertised to model: ${remoteRegistry
      .getToolDefsForRole('manager')
      .map((t) => t.name)
      .join(', ')}`,
  );

  if (expectedTool) {
    const remoteMessages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content: `Call the ${expectedTool} tool on the connected server with sensible arguments, then tell me what came back.`,
      },
    ];
    const remoteOutcome = await runTurn(
      provider,
      remoteRegistry,
      remoteMessages,
      'You are an integration tester. Call the connected MCP tool, then report its raw result.',
      'mcp-live-remote',
      null,
    );
    const called = remoteOutcome.toolCalls.filter((c) => c.name.startsWith('mcp_remote_probe_'));
    console.log(`\n  live agent called ${called.length} hosted MCP tool(s)`);
    console.log(`  agent answer: ${remoteOutcome.text.trim().slice(0, 200)}`);
    await remoteClient.shutdown();
  }
}

// ─── Scenario 3: an OAuth-protected MCP server, driven by the live agent ───
//
// Stands up a fake hosted MCP server that demands a real OAuth 2.1 grant, runs
// Koryphaios' actual discovery/DCR/PKCE/callback/token-store path against it,
// then has space-bunny-free call a tool on the now-authorized server.

const OAUTH_SECRET = 'eu-west-2';
console.log('\n=== Scenario 3: agent -> OAuth-protected MCP server ===');

const { startFakeOAuthMcp } = await import('../backend/src/mcp/testing/fake-oauth-mcp');
const { beginAuthorization, completeAuthorization, ensureAccessToken, disconnect } =
  await import('../backend/src/mcp/oauth-service');
const { getMcpOAuthGrant } = await import('../backend/src/mcp/oauth-secrets');

const oauthFake = await startFakeOAuthMcp({ toolValue: OAUTH_SECRET, toolName: 'region' });
const resolver = () => ensureAccessToken(root, 'oauth_workspace');
const makeClient = () =>
  new MCPClient({ name: 'oauth_workspace', transport: 'sse', url: oauthFake.url }, resolver);

// 1. Before authorizing, the server must reject us and say so clearly.
const before = makeClient();
try {
  await before.connect();
  console.log('  UNEXPECTED: connected without authorization');
} catch (err) {
  console.log(`  before authorize -> ${(err as Error).message}`);
}
console.log(`  needsAuthorization flag: ${before.needsAuthorization}`);
await before.shutdown();

// 2. Run the real flow: start -> "browser" -> loopback callback -> exchange.
const started = await beginAuthorization({
  projectRoot: root,
  serverName: 'oauth_workspace',
  resourceUrl: oauthFake.url,
});
console.log(
  `  consent screen: ${started.authorizationHost} (scopes: ${started.scopes.join(', ')})`,
);
const consentPage = await (await fetch(started.authorizationUrl, { redirect: 'manual' })).text();
const callbackUrl = /Continue at (http:\/\/127\.0\.0\.1:\d+\/callback\?[^<"]+)/.exec(
  consentPage,
)?.[1];
if (!callbackUrl) throw new Error('authorization endpoint did not yield a loopback redirect');
await fetch(callbackUrl, { redirect: 'manual' });
const grant = await completeAuthorization({ projectRoot: root, serverName: 'oauth_workspace' });
console.log(`  authorized: scope=${grant.scope ?? '-'} refreshable=${grant.refreshable}`);
const stored = getMcpOAuthGrant(root, 'oauth_workspace');
console.log(
  `  token stored at .koryphaios/mcp-oauth.json mode=${(statSync(join(root, '.koryphaios', 'mcp-oauth.json')).mode & 0o777).toString(8)} (owner-only)`,
);

// 3. The same server must now connect and serve tools.
const after = makeClient();
await after.connect();
const oauthRegistry = new ToolRegistry();
const oauthRegistered = await registerMCPToolsInRegistry(oauthRegistry, after);
console.log(
  `  after authorize -> connected, ${oauthRegistered} tool(s), needsAuthorization=${after.needsAuthorization}`,
);

// 4. Hand it to the live agent. It cannot know OAUTH_SECRET without the tool.
const oauthOutcome = await runTurn(
  provider,
  oauthRegistry,
  [
    {
      role: 'user',
      content:
        'Which deployment region does the connected workspace report? Use the tool to find out.',
    },
  ],
  'You are an integration tester. Always call the connected tool to answer.',
  'mcp-live-oauth',
  null,
  [],
);
const oauthCalled = oauthOutcome.toolCalls.filter((c) => c.name.startsWith('mcp_oauth_workspace_'));
const oauthAnswered = oauthOutcome.text.includes(OAUTH_SECRET);
console.log(`\n  live agent called ${oauthCalled.length} OAuth-protected MCP tool(s)`);
for (const call of oauthCalled) console.log(`    ${call.name}(${JSON.stringify(call.input)})`);
console.log(`  agent's answer contains the tool-only value: ${oauthAnswered ? 'YES' : 'NO'}`);
console.log(`  agent answer: ${oauthOutcome.text.trim().slice(0, 160)}`);

// 5. Disconnect must revoke and stop working.
await disconnect({ projectRoot: root, serverName: 'oauth_workspace' });
const revoked = makeClient();
let rejectedAfterDisconnect = false;
try {
  await revoked.connect();
} catch {
  rejectedAfterDisconnect = true;
}
await revoked.shutdown();
await after.shutdown();
await oauthFake.stop();
console.log(`  after disconnect -> server rejects again: ${rejectedAfterDisconnect}`);
console.log(`  grant removed from disk: ${getMcpOAuthGrant(root, 'oauth_workspace') === null}`);

rmSync(root, { recursive: true, force: true });

const scenario1Pass = mcpCalled && answered;
const scenario3Pass = oauthCalled.length > 0 && oauthAnswered && rejectedAfterDisconnect;
console.log(`\n${scenario1Pass ? 'PASS' : 'FAIL'}: agent used the MCP tool and used its result`);
console.log(`${scenario3Pass ? 'PASS' : 'FAIL'}: agent used an OAuth-authorized MCP server`);
process.exit(scenario1Pass && scenario3Pass ? 0 : 1);
