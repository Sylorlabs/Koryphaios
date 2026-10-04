import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIsolatedTestEnvironment } from '../../../../scripts/test-backend-isolated';

describe('Codebuff pinned store agent', () => {
  for (const scenario of [
    'config',
    'allow',
    'tool-error',
    'blocked',
    'plan',
    'rejected',
    'throws',
    'error-output',
  ]) {
    it(`keeps the actual SDK run boundary honest: ${scenario}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'codebuff-sdk-test-'));
      try {
        mkdirSync(join(home, 'tmp'));
        mkdirSync(join(home, 'project'));
        const child = Bun.spawn(
          [
            process.execPath,
            '--no-env-file',
            'run',
            join(import.meta.dir, 'codebuff-sdk.fixture.ts'),
            scenario,
          ],
          {
            env: {
              ...createIsolatedTestEnvironment(
                { ...process.env, KORY_RUN_LIVE_PROVIDER_TESTS: '0' },
                home,
              ),
              DATABASE_URL: join(home, 'fixture.sqlite'),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({
          exit,
          stderr: exit === 0 ? '' : stderr,
          stdout: exit === 0 ? '' : stdout,
        }).toEqual({ exit: 0, stderr: '', stdout: '' });
        expect(stdout).toContain(`PASS ${scenario}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it('the installed SDK requires explicit template membership for custom tools', async () => {
    // Execute the real, unexported bundled filter, not a mock that assumes all
    // supplied customToolDefinitions are available. Revalidate on SDK upgrades.
    const sdkDir = dirname(import.meta.resolve('@codebuff/sdk').replace('file://', ''));
    const source = readFileSync(join(sdkDir, 'index.mjs'), 'utf8');
    const start = source.indexOf('async function additionalToolDefinitions(params2) {');
    const end = source.indexOf('\nvar runAgentStep =', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const getDefinitions = new Function(
      'import_lodash15',
      'getMCPToolData',
      `${source.slice(start, end)}; return additionalToolDefinitions;`,
    )({ cloneDeep: structuredClone }, async ({ writeTo }: { writeTo: unknown }) => writeTo);
    const customToolDefinitions = {
      kory_read_note: { description: 'Read a Kory note', inputSchema: { type: 'object' } },
    };
    const fileContext = { customToolDefinitions };
    expect(
      await getDefinitions({
        agentTemplate: { toolNames: ['read_files'], mcpServers: {} },
        fileContext,
      }),
    ).toEqual({});
    expect(
      await getDefinitions({
        agentTemplate: { toolNames: ['read_files', 'kory_read_note'], mcpServers: {} },
        fileContext,
      }),
    ).toEqual(customToolDefinitions);
    // Invocation is also gated, so a prompt telling the base agent to call the
    // unlisted tool cannot make it available as a backdoor.
    const invocationStart = source.indexOf('async function executeCustomToolCall(params2) {');
    const invocationGate = source.slice(invocationStart, invocationStart + 2300);
    expect(invocationGate).toContain('!agentTemplate.toolNames.includes(toolCall.toolName)');
    expect(invocationGate).toContain('is not currently available');
  });
});
