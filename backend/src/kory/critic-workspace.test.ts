import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCriticWorkspace } from './critic-workspace';
import { ToolRegistry, type ToolContext } from '../tools/registry';
import { BashTool } from '../tools/bash';
import { DEFAULT_AGENT_SETTINGS } from '../agent-settings';
import { resolveToolPermissionPolicy, resolveSandboxOptions } from '../tools/permission-policy';
import { osSandboxEnabled } from '../security/os-sandbox';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('verification commands cannot mutate producer files through copied dependency links', async () => {
  const source = mkdtempSync(join(tmpdir(), 'critic-source-'));
  roots.push(source);
  mkdirSync(join(source, 'packages'));
  mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, 'packages', 'dependency.js'), 'original');
  symlinkSync('../packages/dependency.js', join(source, 'node_modules', 'dependency.js'));
  const copy = await createCriticWorkspace(source);
  roots.push(copy);
  writeFileSync(join(copy, 'node_modules', 'dependency.js'), 'experiment');
  expect(readFileSync(join(source, 'packages', 'dependency.js'), 'utf8')).toBe('original');
  expect(readFileSync(join(copy, 'node_modules', 'dependency.js'), 'utf8')).toBe('experiment');
});

test.skipIf(!osSandboxEnabled())(
  'approved Critic shell commands run in the copy and cannot overwrite the producer',
  async () => {
    const source = mkdtempSync(join(tmpdir(), 'critic-terminal-'));
    roots.push(source);
    writeFileSync(join(source, 'protected.txt'), 'producer');
    const copy = await createCriticWorkspace(source);
    roots.push(copy);
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const ctx: ToolContext = {
      sessionId: 'critic-terminal',
      callerRole: 'critic',
      workingDirectory: copy,
      allowedPaths: [copy],
      requiredWorkspaceRoot: copy,
      reviewWorkspaceRoot: copy,
      permissionPolicy: resolveToolPermissionPolicy({
        ...DEFAULT_AGENT_SETTINGS,
        permissionMode: 'yolo',
      }),
      sandboxOptions: {
        ...resolveSandboxOptions(DEFAULT_AGENT_SETTINGS, true, 'always'),
        commandWhitelist: false,
        metacharacters: false,
      },
      requestToolApproval: async () => true,
      approvedToolCallIds: new Set(),
    };
    const local = await registry.execute(ctx, {
      id: 'local',
      name: 'bash',
      input: { command: 'printf tested > proof.txt' },
    });
    expect(local.isError).toBe(false);
    expect(readFileSync(join(copy, 'proof.txt'), 'utf8')).toBe('tested');
    const escaped = await registry.execute(ctx, {
      id: 'escape',
      name: 'bash',
      input: { command: `printf changed > "${join(source, 'protected.txt')}"` },
    });
    expect(escaped.isError).toBe(true);
    expect(readFileSync(join(source, 'protected.txt'), 'utf8')).toBe('producer');
  },
);

import { captureReviewChangeSet } from './critic-workspace';

async function git(dir: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`);
}

test('captures the producer change set: tracked diff plus untracked list', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'critic-diff-'));
  roots.push(repo);
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'critic@test']);
  await git(repo, ['config', 'user.name', 'Critic Test']);
  writeFileSync(join(repo, 'tracked.ts'), 'const value = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'base']);

  writeFileSync(join(repo, 'tracked.ts'), 'const value = 2;\n');
  writeFileSync(join(repo, 'untracked.ts'), 'new file\n');

  const changeSet = await captureReviewChangeSet(repo);
  expect(changeSet.ok).toBe(true);
  if (!changeSet.ok) return;
  expect(changeSet.patch).toContain('diff --git');
  expect(changeSet.patch).toContain('const value = 2;');
  expect(changeSet.patch).toContain('Untracked files:');
  expect(changeSet.patch).toContain('untracked.ts');
});

test('non-repository source reports a failed capture instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-diff-norepo-'));
  roots.push(dir);
  writeFileSync(join(dir, 'plain.txt'), 'no repo here\n');
  const changeSet = await captureReviewChangeSet(dir);
  expect(changeSet.ok).toBe(false);
  if (changeSet.ok) return;
  expect(changeSet.reason.length).toBeGreaterThan(0);
});
