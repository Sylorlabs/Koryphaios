import { describe, expect, it } from 'bun:test';
import { serializeCodexMcpProfile } from '../cli-bridges';
import { codexJsonEvents } from '../codex-cli';

const KORY_SERVER = {
  name: 'kory',
  command: '/bin/bun',
  args: ['/srv/kory-mcp-bridge.ts', '--provider', 'codex'],
  env: {
    KORY_BACKEND_URL: 'http://127.0.0.1:3011',
    KORY_BRIDGE_AUTH_FILE: '/tmp/grant-123.json',
  },
  transport: 'stdio' as const,
};

describe('serializeCodexMcpProfile', () => {
  it('renders a kory profile codex accepts', () => {
    const toml = serializeCodexMcpProfile([KORY_SERVER]);
    expect(toml).toContain('[mcp_servers.kory]');
    expect(toml).toContain('command = "/bin/bun"');
    expect(toml).toContain('args = ["/srv/kory-mcp-bridge.ts", "--provider", "codex"]');
    expect(toml).toContain('[mcp_servers.kory.env]');
    expect(toml).toContain('KORY_BACKEND_URL = "http://127.0.0.1:3011"');
    expect(toml).toContain('KORY_BRIDGE_AUTH_FILE = "/tmp/grant-123.json"');
  });

  it('escapes TOML-hostile characters in commands, args, and env', () => {
    const toml = serializeCodexMcpProfile([
      {
        name: 'kory',
        command: 'C:\\tools\\run "x".exe',
        args: ['a"b', 'c\\d'],
        env: { Q: 'say "hi"\nbye' },
        transport: 'stdio',
      },
    ]);
    expect(toml).toContain('command = "C:\\\\tools\\\\run \\"x\\".exe"');
    expect(toml).toContain('args = ["a\\"b", "c\\\\d"]');
    expect(toml).toContain('Q = "say \\"hi\\"\\nbye"');
  });

  it('fails closed on bad names and non-stdio transports', () => {
    expect(() => serializeCodexMcpProfile([{ ...KORY_SERVER, name: 'evil name!' }])).toThrow();
    expect(() =>
      serializeCodexMcpProfile([{ ...KORY_SERVER, transport: 'http', url: 'http://x' }]),
    ).toThrow();
  });
});

describe('codexJsonEvents MCP items (display-only, never re-executed)', () => {
  it('surfaces an mcp_tool_call as a single tool_executed event', () => {
    const { events, completed } = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server_name: 'kory',
          tool_name: 'kory__read',
          arguments: { path: '/tmp/x' },
          result: 'file contents',
        },
      },
      ['kory__read'],
    );
    expect(completed).toBe(false);
    expect(events).toEqual([
      {
        type: 'tool_executed',
        toolName: 'mcp__kory__kory__read',
        toolInput: JSON.stringify({ path: '/tmp/x' }),
        toolOutput: 'file contents',
        isError: false,
      },
    ]);
    // Crucially: no tool_use_* — the manager must not execute it a second time.
    expect(events.some((e) => e.type.startsWith('tool_use'))).toBe(false);
  });

  it('tolerates alternate MCP item shapes and error results', () => {
    const { events } = codexJsonEvents(
      {
        type: 'item.completed',
        item: {
          type: 'mcp_tool_use',
          server: 'kory',
          tool: 'write',
          input: { path: '/tmp/x' },
          error: 'denied by policy',
        },
      },
      [],
    );
    expect(events).toEqual([
      {
        type: 'tool_executed',
        toolName: 'mcp__kory__write',
        toolInput: JSON.stringify({ path: '/tmp/x' }),
        toolOutput: 'denied by policy',
        isError: true,
      },
    ]);
  });

  it('leaves non-MCP items untouched', () => {
    const { events } = codexJsonEvents(
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      },
      [],
    );
    expect(events).toEqual([{ type: 'content_delta', content: 'hello' }]);
  });
});
