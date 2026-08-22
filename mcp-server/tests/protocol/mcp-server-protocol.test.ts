/**
 * v2 MCP protocol tests for the ErrorDebuggingMCPServer.
 *
 * Drives the server through a real v2 Client over two transports:
 *   - createMcpHandler + StreamableHTTPClientTransport  →  2026-07-28 era
 *   - InMemoryTransport.createLinkedPair                →  2025-era fallback
 *
 * No mocks, no direct internal-API calls — every assertion goes through the
 * MCP wire protocol the way a real CLI host (Devin, Claude, Codex) would.
 */


import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorDebuggingMCPServer } from '@/server/mcp-server.js';
import type { ServerConfig } from '@/types/index.js';

// ─── Shared fixtures ───────────────────────────────────────────────────────

function makeConfig(): ServerConfig {
  return {
    server: { name: 'protocol-test-server', version: '1.0.0', logLevel: 'error' },
    detection: {
      enabled: true,
      realTime: false,
      sources: {
        console: true,
        runtime: true,
        build: false,
        test: false,
        linter: false,
        staticAnalysis: false,
      },
      filters: { categories: [], severities: [], excludeFiles: [], excludePatterns: [] },
      polling: { interval: 5000, maxRetries: 1 },
      bufferSize: 100,
      maxErrorsPerSession: 1000,
    },
    analysis: {
      enabled: false,
      aiEnhanced: false,
      confidenceThreshold: 0.7,
      maxAnalysisTime: 5000,
      enablePatternMatching: false,
      enableSimilaritySearch: false,
      enableRootCauseAnalysis: false,
      enableImpactPrediction: false,
      customPatterns: [],
      historicalDataRetention: 1,
    },
    debugging: {
      enabled: false,
      languages: {},
      defaultTimeout: 5000,
      maxConcurrentSessions: 1,
      enableHotReload: false,
      enableRemoteDebugging: false,
      breakpoints: { maxPerSession: 10, enableConditional: false, enableLogPoints: false },
      variableInspection: { maxDepth: 3, maxStringLength: 100, enableLazyLoading: false },
    },
    performance: {
      enabled: false,
      profiling: {
        enabled: false,
        sampleRate: 10,
        maxDuration: 5000,
        includeMemory: false,
        includeCpu: false,
      },
      monitoring: {
        enabled: false,
        interval: 10000,
        thresholds: { memory: 100 * 1024 * 1024, cpu: 80, responseTime: 1000 },
      },
      optimization: {
        enableSuggestions: false,
        enableAutomaticOptimization: false,
        aggressiveness: 'conservative',
      },
    },
    integrations: {
      buildSystems: { webpack: false, vite: false, rollup: false, parcel: false, esbuild: false },
      testRunners: {
        jest: false,
        vitest: false,
        mocha: false,
        pytest: false,
        goTest: false,
        cargoTest: false,
      },
      linters: {
        eslint: false,
        tslint: false,
        pylint: false,
        flake8: false,
        golint: false,
        clippy: false,
      },
      versionControl: { git: false, enableCommitHooks: false, enableBranchAnalysis: false },
      containers: { docker: false, kubernetes: false, enableContainerDebugging: false },
      ides: { vscode: false, cursor: false, windsurf: false, augmentCode: false },
    },
    security: {
      enableSecurityScanning: false,
      vulnerabilityDatabases: [],
      enableDependencyScanning: false,
      enableCodeScanning: false,
      reportingLevel: 'high-critical',
      autoFixVulnerabilities: false,
      excludePatterns: [],
    },
  };
}

/**
 * Build a server instance and register core components so the tool/resource/
 * prompt registries are populated.  We call the async init path but never
 * `start()` — `buildServer()` is the factory under test.
 */
async function makeServer(): Promise<ErrorDebuggingMCPServer> {
  const server = new ErrorDebuggingMCPServer(makeConfig());
  await server.registerCoreComponents();
  return server;
}

// ─── 2026-07-28 era (createMcpHandler + StreamableHTTP) ───────────────────

describe('MCP 2026-07-28 protocol (createMcpHandler + StreamableHTTPClientTransport)', () => {
  let server: ErrorDebuggingMCPServer;
  let handler: McpHttpHandler;
  let client: Client;

  beforeEach(async () => {
    server = await makeServer();
    handler = createMcpHandler(() => server.buildServer());
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    client = new Client(
      { name: 'protocol-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    );
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await handler.close();
  });

  it('negotiates the 2026-07-28 protocol revision', async () => {
    const version = client.getNegotiatedProtocolVersion();
    expect(version).toBe('2026-07-28');
  });

  it('responds to tools/list with the detect-errors tool', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    expect(names).toContain('detect-errors');
  });

  it('responds to resources/list', async () => {
    const result = await client.listResources();
    expect(Array.isArray(result.resources)).toBe(true);
  });

  it('responds to prompts/list', async () => {
    const result = await client.listPrompts();
    expect(Array.isArray(result.prompts)).toBe(true);
  });

  it('calls a tool and receives a content result', async () => {
    const result = await client.callTool({
      name: 'detect-errors',
      arguments: { source: 'console', language: 'javascript' },
    });
    // The tool may return isError=true because the managers aren't fully
    // wired (start() wasn't called), but the protocol envelope is what we're
    // testing — content must be a non-empty array of content blocks.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe('text');
  });

  it('throws a ProtocolError for an unknown tool', async () => {
    await expect(client.callTool({ name: 'nonexistent-tool', arguments: {} })).rejects.toThrow(
      /Tool nonexistent-tool not found/
    );
  });
});

// ─── 2025-era fallback (InMemoryTransport) ────────────────────────────────

describe('MCP 2025-era fallback (InMemoryTransport)', () => {
  let server: ErrorDebuggingMCPServer;
  let client: Client;

  beforeEach(async () => {
    server = await makeServer();
    const mcpServer = server.buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'legacy-test-client', version: '1.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it('negotiates a 2025-era protocol revision', async () => {
    const version = client.getNegotiatedProtocolVersion();
    // InMemoryTransport is 2025-era only; expect the legacy revision.
    expect(version).toMatch(/^2025-/);
  });

  it('lists tools over the legacy transport', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    expect(names).toContain('detect-errors');
  });

  it('calls a tool over the legacy transport', async () => {
    const result = await client.callTool({
      name: 'detect-errors',
      arguments: { source: 'console' },
    });
    // Protocol envelope test — content must be a non-empty array.
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });
});
