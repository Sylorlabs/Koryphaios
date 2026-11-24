// Live OpenCode provider verification (KORY_RUN_LIVE_PROVIDER_TESTS=1 KORY_LIVE_OPENCODE=1).
//
// These tests are deliberately excluded from CI: they drive the real `opencode`
// CLI on this machine (free models only) and a faithful in-process stand-in for
// the Kory backend, which is enough to prove the whole chain — ACP handshake,
// kory MCP bridge wiring, grant verification, tool execution through the bridge,
// and usage receipts.
//
//   1. catalog: the live authenticated catalog loads with real context limits.
//   2. turn: a full manager turn streams content and a complete event.
//   3. bridge: a turn whose prompt demands the kory MCP probe tool actually
//      reaches the backend through the session-scoped signed bridge.

import { describe, it, expect, setDefaultTimeout, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_PRESETS } from '@koryphaios/shared';
import { createKoryBridgeGrantLease, verifySignedBridgeRequest } from '../bridge-grant';
import { OpenCodeCliProvider } from '../opencode-cli';
import type { ProviderConfig } from '@koryphaios/shared';
import type { ProviderEvent, StreamRequest } from '../types';

setDefaultTimeout(180_000);

const live =
  process.env.KORY_RUN_LIVE_PROVIDER_TESTS === '1' && process.env.KORY_LIVE_OPENCODE === '1'
    ? it
    : it.skip;

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    name: 'opencode',
    disabled: false,
    selectedModels: [],
    authToken: 'cli:opencode:live-test',
    ...over,
  }) as ProviderConfig;

const baseRequest = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'opencode/pulse-alpha-free',
  messages: [{ role: 'user', content: 'Reply with exactly the word ok.' }],
  systemPrompt: '',
  sessionId: 'opencode-live-' + Date.now(),
  harnessRole: 'manager',
  workingDirectory: mkdtempSync(join(tmpdir(), 'kory-opencode-live-')),
  signal: new AbortController().signal,
  ...over,
});

const collect = async (provider: OpenCodeCliProvider, request: StreamRequest) => {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse(request)) {
    events.push(event);
  }
  return events;
};

afterEach(() => {
  delete process.env.KORY_MCP_BRIDGE_SCRIPT;
  delete process.env.KORY_MCP_BRIDGE_COMMAND;
});

describe('OpenCode CLI — live catalog', () => {
  live('loads the authenticated catalog with real context limits', async () => {
    const provider = new OpenCodeCliProvider(config());
    await provider.refreshModels(true);
    const models = provider.listModels();
    expect(models.length).toBeGreaterThan(50);
    const withContext = models.filter((m) => m.contextVerified && m.contextWindow > 0);
    // The authenticated catalog reports limit.context for free and paid models alike.
    expect(withContext.length).toBeGreaterThan(models.length * 0.9);
    const pulse = models.find((m) => m.id === 'opencode/pulse-alpha-free');
    expect(pulse).toBeDefined();
    expect(pulse!.contextWindow).toBeGreaterThan(100_000);
    expect(pulse!.reasoningLevels?.length ?? 0).toBeGreaterThan(0);
    expect(provider.getModelDiscoveryError()).toBeUndefined();
  });
});

describe('OpenCode CLI — live turn', () => {
  live('streams a response and completes', async () => {
    const provider = new OpenCodeCliProvider(config());
    const request = baseRequest();
    const events = await collect(provider, request);
    const errors = events.filter((e) => e.type === 'error');
    const complete = events.find((e) => e.type === 'complete');
    const content = events
      .filter((e) => e.type === 'content_delta')
      .map((e) => e.content)
      .join('');
    expect(errors).toEqual([]);
    expect(complete).toBeDefined();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});

describe('OpenCode CLI — sandboxed turn', () => {
  live('serves a bridged turn inside the OS sandbox', async () => {
    const sessionId = 'opencode-live-sandbox-' + Date.now();
    const lease = createKoryBridgeGrantLease(sessionId, 'manager');
    const executedCalls: string[] = [];

    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        if (req.method === 'POST' && req.url === '/api/v1/mcp-bridge/catalog') {
          const verified = verifySignedBridgeRequest(
            headers,
            'mcp',
            'POST',
            '/api/v1/mcp-bridge/catalog',
            parsed,
          );
          if (!verified) {
            res.writeHead(401).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              tools: [
                {
                  name: 'kory__probe_ping',
                  description: 'Returns the string pong. Call this tool when asked to ping.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === 'POST' && req.url === '/api/v1/mcp-bridge/execute') {
          const verified = verifySignedBridgeRequest(
            headers,
            'mcp',
            'POST',
            '/api/v1/mcp-bridge/execute',
            parsed,
          );
          if (!verified) {
            res.writeHead(401).end();
            return;
          }
          executedCalls.push(String(parsed.toolName));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ output: 'pong', isError: false }));
          return;
        }
        res.writeHead(404).end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const previousBackendUrl = process.env.KORY_BACKEND_URL;
    process.env.KORY_BACKEND_URL = `http://127.0.0.1:${port}`;

    const provider = new OpenCodeCliProvider(config());
    const request = baseRequest({
      sessionId,
      sandbox: SANDBOX_PRESETS.readonly,
      workingDirectory: mkdtempSync(join(tmpdir(), 'kory-opencode-live-sandbox-')),
      messages: [
        {
          role: 'user',
          content:
            'Call the kory__probe_ping tool exactly once (no arguments) and reply with one line containing whatever it returns.',
        },
      ],
      tools: [
        {
          name: 'kory__probe_ping',
          description: 'Returns the string pong. Call this tool when asked to ping.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    try {
      const events = await collect(provider, request);
      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toEqual([]);
      expect(executedCalls).toContain('probe_ping');
    } finally {
      if (previousBackendUrl === undefined) delete process.env.KORY_BACKEND_URL;
      else process.env.KORY_BACKEND_URL = previousBackendUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      lease.cleanup();
      rmSync(request.workingDirectory!, { recursive: true, force: true });
    }
  });
});

describe('OpenCode CLI — kory MCP bridge end to end', () => {
  live('a manager turn calls the bridged probe tool through the signed grant', async () => {
    const sessionId = 'opencode-live-bridge-' + Date.now();
    const lease = createKoryBridgeGrantLease(sessionId, 'manager');
    const executedCalls: Array<{ toolName: string; input: unknown }> = [];

    // Faithful stand-in for the Kory backend: it verifies the bridge's HMAC
    // signature against the same in-process grant registry the bridge uses.
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        if (req.method === 'POST' && req.url === '/api/v1/mcp-bridge/catalog') {
          const verified = verifySignedBridgeRequest(
            headers,
            'mcp',
            'POST',
            '/api/v1/mcp-bridge/catalog',
            parsed,
          );
          if (!verified) {
            res.writeHead(401).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              tools: [
                {
                  name: 'kory__probe_ping',
                  description: 'Returns the string pong. Call this tool when asked to ping.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === 'POST' && req.url === '/api/v1/mcp-bridge/execute') {
          const verified = verifySignedBridgeRequest(
            headers,
            'mcp',
            'POST',
            '/api/v1/mcp-bridge/execute',
            parsed,
          );
          if (!verified) {
            res.writeHead(401).end();
            return;
          }
          executedCalls.push({ toolName: String(parsed.toolName), input: parsed.input });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ output: 'pong', isError: false }));
          return;
        }
        res.writeHead(404).end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const previousBackendUrl = process.env.KORY_BACKEND_URL;
    process.env.KORY_BACKEND_URL = `http://127.0.0.1:${port}`;

    const provider = new OpenCodeCliProvider(config());
    const request = baseRequest({
      sessionId,
      workingDirectory: mkdtempSync(join(tmpdir(), 'kory-opencode-bridge-')),
      messages: [
        {
          role: 'user',
          content:
            'Use the kory__probe_ping tool exactly once right now (it takes no arguments), then reply with exactly one line containing whatever it returns.',
        },
      ],
      tools: [
        {
          name: 'kory__probe_ping',
          description: 'Returns the string pong. Call this tool when asked to ping.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    try {
      const events = await collect(provider, request);
      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toEqual([]);
      // The proof: the backend saw the tool call, authorized by the signed grant.
      expect(executedCalls.map((call) => call.toolName)).toContain('probe_ping');
    } finally {
      if (previousBackendUrl === undefined) delete process.env.KORY_BACKEND_URL;
      else process.env.KORY_BACKEND_URL = previousBackendUrl;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      lease.cleanup();
      rmSync(request.workingDirectory!, { recursive: true, force: true });
    }
  });
});
