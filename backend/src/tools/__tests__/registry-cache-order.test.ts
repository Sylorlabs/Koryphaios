import { describe, expect, test } from 'bun:test';
import { ToolRegistry, type Tool } from '../registry';
const schema = { type: 'object', properties: {} };
function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: schema,
    async run(_ctx, call) {
      return { callId: call.id, name, output: name, isError: false, durationMs: 0 };
    },
  };
}
describe('ToolRegistry cache stability', () => {
  test('tool definitions are deterministic regardless of registration order', () => {
    const a = new ToolRegistry();
    a.register(tool('zeta'));
    a.register(tool('alpha'));
    const b = new ToolRegistry();
    b.register(tool('alpha'));
    b.register(tool('zeta'));
    expect(a.getToolDefsForRole('manager').map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(a.getToolDefsForRole('manager')).toEqual(b.getToolDefsForRole('manager'));
  });
});
