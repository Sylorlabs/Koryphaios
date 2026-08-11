import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canUseBunStdioPipes } from '../__tests__/runtime-capabilities';

const temporaryRoots: string[] = [];
// Resolve relative to this test file so the path is correct regardless of CWD.
const modulePath = resolve(import.meta.dir, 'mcp.ts');
const BUN_STDIO_PIPES_AVAILABLE = await canUseBunStdioPipes();

function fixtureRoot(serverSource: string): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mcp-confidentiality-'));
  temporaryRoots.push(root);
  const serverPath = join(root, 'mcp-server', 'src', 'index.ts');
  mkdirSync(dirname(serverPath), { recursive: true });
  writeFileSync(join(root, 'koryphaios.json'), '{}\n');
  writeFileSync(serverPath, serverSource);
  return root;
}

function runTool(root: string, ambientSecret: string) {
  const childCode = `
    import { MCPDetectErrorsTool } from ${JSON.stringify(modulePath)};
    const tool = new MCPDetectErrorsTool();
    const result = await tool.run(
      { sessionId: 'synthetic-session' },
      { id: 'synthetic-call', name: 'detect-errors', input: { source: 'runtime' } },
    );
    console.log(JSON.stringify({ isError: result.isError, output: result.output }));
    await Bun.sleep(100);
  `;
  return spawnSync(process.execPath, ['--no-env-file', '-e', childCode], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      SYNTHETIC_AMBIENT_SECRET: ambientSecret,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('MCP tool subprocess confidentiality and lifecycle', () => {
  test.skipIf(!BUN_STDIO_PIPES_AVAILABLE)(
    'strips ambient secrets and records stdout/stderr only as byte metadata',
    () => {
      const ambientSecret = 'SYNTHETIC_AMBIENT_SECRET_VALUE_218f';
      const stdoutSentinel = 'SYNTHETIC_MCP_STDOUT_PRIVATE_91ab';
      const stderrSentinel = 'SYNTHETIC_MCP_STDERR_PRIVATE_47cd';
      const root = fixtureRoot(`
      import { createInterface } from 'node:readline';
      const ambientPresent = Boolean(process.env.SYNTHETIC_AMBIENT_SECRET);
      console.error(${JSON.stringify(stderrSentinel)});
      const lines = createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') {
          console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
        } else if (request.method === 'tools/call') {
          console.log(${JSON.stringify(stdoutSentinel)});
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [{ type: 'text', text: 'ambientPresent=' + ambientPresent }],
              isError: false,
            },
          }));
          setTimeout(() => process.exit(0), 25);
        }
      });
    `);

      const child = runTool(root, ambientSecret);
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(output).toContain('ambientPresent=false');
      expect(output).not.toContain(ambientSecret);
      expect(output).not.toContain(stdoutSentinel);
      expect(output).not.toContain(stderrSentinel);
      expect(output).toContain('"stream":"stdout"');
      expect(output).toContain('"stream":"stderr"');
      expect(output).toContain('"outputBytes":');
    },
  );

  test.skipIf(!BUN_STDIO_PIPES_AVAILABLE)(
    'rejects a pending request when the MCP child exits',
    () => {
      const root = fixtureRoot(`
      import { createInterface } from 'node:readline';
      const lines = createInterface({ input: process.stdin });
      lines.once('line', () => process.exit(17));
    `);

      const child = runTool(root, 'SYNTHETIC_EXIT_SECRET_66c4');
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(output).toContain('"isError":true');
      expect(output).toContain('MCP server exited with code 17');
      expect(output).not.toContain('SYNTHETIC_EXIT_SECRET_66c4');
    },
  );
});
