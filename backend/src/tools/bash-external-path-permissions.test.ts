import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BashTool } from './bash';
import { DEFAULT_AGENT_SETTINGS } from '../agent-settings';
import { resolveToolPermissionPolicy } from './permission-policy';

const roots: string[] = [];

function root(label: string): string {
  const path = join(tmpdir(), `kory-bash-external-${label}-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function context(
  workingDirectory: string,
  mode: 'yolo' | 'guarded',
  waitForUserInput?: (question: string, options: string[]) => Promise<string>,
) {
  return {
    sessionId: crypto.randomUUID(),
    callerRole: 'manager' as const,
    workingDirectory,
    // Manager ownership is a normal workspace root; it is not the worker-only
    // non-bypassable grant tested by workspace-write-confinement.test.ts.
    requiredWorkspaceRoot: workingDirectory,
    isSandboxed: false,
    permissionPolicy: resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: mode,
    }),
    waitForUserInput,
  };
}

test('YOLO manager Bash can use an outside working directory', async () => {
  const project = root('project');
  const outside = root('outside');
  const result = await new BashTool().run(
    context(project, 'yolo'),
    { id: 'yolo-outside', name: 'bash', input: { command: 'pwd', workingDirectory: outside } },
  );

  expect(result.isError).toBe(false);
  expect(result.output).toContain(outside);
});

test('Guarded manager Bash asks before using an outside working directory', async () => {
  const project = root('project');
  const outside = root('outside');
  let prompts = 0;
  const result = await new BashTool().run(
    context(project, 'guarded', async () => {
      prompts++;
      return 'Allow once';
    }),
    { id: 'guarded-outside', name: 'bash', input: { command: 'pwd', workingDirectory: outside } },
  );

  expect(prompts).toBe(1);
  expect(result.isError).toBe(false);
  expect(result.output).toContain(outside);
});

test('Guarded manager Bash does not run after outside access is rejected', async () => {
  const project = root('project');
  const outside = root('outside');
  let ran = false;
  const result = await new BashTool().run(
    context(project, 'guarded', async () => 'Reject'),
    {
      id: 'guarded-outside-rejected',
      name: 'bash',
      input: { command: `touch ${join(outside, 'should-not-exist')}`, workingDirectory: outside },
    },
  );
  ran = result.output.includes('should-not-exist');

  expect(result.isError).toBe(true);
  expect(ran).toBe(false);
});
