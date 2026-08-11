import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('Kory MCP bridge module boundary', () => {
  it('imports tool metadata without starting a stdio server', () => {
    const bridgePath = resolve(import.meta.dir, '..', 'kory-mcp-bridge.ts');
    const script = [
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});`,
      `process.stdout.write(JSON.stringify({ tools: bridge.KORY_TOOLS.length, manager: bridge.toolsForRole('manager').length, unknown: bridge.toolsForRole('auditor').length }));`,
    ].join('\n');

    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: resolve(import.meta.dir, '..', '..', '..', '..'),
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, KORY_LOCAL_AUTH: '' },
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ tools: 48, manager: 48, unknown: 0 });
  });
});
