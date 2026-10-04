import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildServer } from '../providers/kory-mcp-bridge';
import { validatedToolImages, withoutToolImages } from '../tools/tool-images';
import { createComputerUseTools } from './tools';
import { stopComputerUse } from './control';
import { ToolRegistry } from '../tools/registry';
import { DEFAULT_AGENT_SETTINGS } from '../agent-settings';
import { resolveToolPermissionPolicy } from '../tools/permission-policy';
import { defaultComputerUseSettings } from '@koryphaios/shared';

const image = { mimeType: 'image/png', data: 'aGVsbG8=' };
describe('computer use integration boundaries', () => {
  it('transports image content over the real MCP protocol without text base64', async () => {
    const server = buildServer(
      [{ name: 'kory__computer_observe', description: 'Observe', inputSchema: { type: 'object' } }],
      async () => ({ content: 'Window captured', isError: false, images: [image] }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'computer-images', version: '1' });
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const result = await client.callTool({ name: 'kory__computer_observe', arguments: {} });
      expect(result.content).toEqual([
        { type: 'text', text: 'Window captured' },
        { type: 'image', ...image },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('bounds image types and excludes images from tool text/audit data', () => {
    expect(
      validatedToolImages([
        image,
        { mimeType: 'text/html', data: image.data },
        { ...image, data: '<script>' },
      ]),
    ).toEqual([image]);
    expect(
      withoutToolImages({
        callId: 'x',
        name: 'computer_observe',
        output: 'ok',
        images: [image],
        isError: false,
        durationMs: 1,
      }),
    ).not.toHaveProperty('images');
  });
  it('keeps generic Ask approvals inside the stoppable computer boundary', async () => {
    const computerUse = defaultComputerUseSettings();
    computerUse.enabled = true;
    let prompts = 0;
    let executed = 0;
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const registry = new ToolRegistry();
    createComputerUseTools({
      loadSettings: () => ({ ...DEFAULT_AGENT_SETTINGS, computerUse }),
      adapter: {
        status: async () => ({
          platform: 'test',
          available: true,
          capabilities: ['discover'],
          limitations: [],
        }),
        execute: async () => {
          executed++;
          return { targets: [] };
        },
      },
    }).forEach((tool) => registry.register(tool));
    const result = registry.execute(
      {
        sessionId: 'stop-test',
        workingDirectory: '/unused',
        callerRole: 'manager',
        permissionPolicy: resolveToolPermissionPolicy({
          ...DEFAULT_AGENT_SETTINGS,
          toolPermissionsByTier: { guarded: { allow: [], block: [], ask: ['computer_list_apps'] } },
        }),
        waitForUserInput: async () => {
          prompts++;
          ready();
          return new Promise<string>(() => {});
        },
      },
      { id: 'stop-test', name: 'computer_list_apps', input: {} },
    );
    await waiting;
    stopComputerUse();
    expect((await result).isError).toBe(true);
    expect(prompts).toBe(1);
    expect(executed).toBe(0);
  });
  it('does not let generic YOLO/allowlist bypass disabled computer permissions', async () => {
    let nativeActions = 0;
    const tools = createComputerUseTools({
      loadSettings: () => ({
        ...DEFAULT_AGENT_SETTINGS,
        computerUse: defaultComputerUseSettings(),
      }),
      adapter: {
        status: async () => ({
          platform: 'test',
          available: true,
          capabilities: ['discover'],
          limitations: [],
        }),
        execute: async () => {
          nativeActions++;
          return { targets: [] };
        },
      },
    });
    const registry = new ToolRegistry();
    tools.forEach((tool) => registry.register(tool));
    const result = await registry.execute(
      {
        sessionId: 'test',
        workingDirectory: '/unused',
        callerRole: 'manager',
        permissionPolicy: resolveToolPermissionPolicy({
          ...DEFAULT_AGENT_SETTINGS,
          permissionMode: 'yolo',
          toolAllowlist: ['computer_list_apps'],
        }),
      },
      { id: 'x', name: 'computer_list_apps', input: {} },
    );
    expect(result.isError).toBe(true);
    expect(nativeActions).toBe(0);
  });
});
