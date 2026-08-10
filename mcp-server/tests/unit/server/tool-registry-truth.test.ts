import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '@/server/tool-registry.js';

describe('ToolRegistry capability truth', () => {
  it('fails closed for an unimplemented debugger tool instead of fabricating success', async () => {
    const registry = new ToolRegistry();

    await registry.registerTool({
      name: 'set-breakpoint',
      description: 'Unimplemented debugger integration',
      inputSchema: { type: 'object', properties: {} },
    });

    const result = await registry.callTool('set-breakpoint', {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No default handler available');
  });
});
