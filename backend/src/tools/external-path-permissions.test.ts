import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry, type ToolContext } from './registry';
import {
  ReadFileTool,
  WriteFileTool,
  GlobTool,
  GrepTool,
  DiffTool,
  MoveFileTool,
  BatchEditTool,
} from './files';
import { ViewImageTool } from './image';
import { resolveToolPermissionPolicy } from './permission-policy';
import { DEFAULT_AGENT_SETTINGS } from '../agent-settings';
import { canonicalizePath } from '../runtime/platform';

let root = '';
let outside = '';
let registry: ToolRegistry;

const policy = (mode: 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom', interactionMode: 'act' | 'plan' = 'act') =>
  resolveToolPermissionPolicy({ ...DEFAULT_AGENT_SETTINGS, permissionMode: mode }, interactionMode);

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'external-path-test',
    workingDirectory: root,
    permissionPolicy: policy('yolo'),
    allowedPaths: [root],
    ...overrides,
  };
}

function call(name: string, input: Record<string, unknown>) {
  return { id: crypto.randomUUID(), name, input };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-external-root-'));
  outside = mkdtempSync(join(tmpdir(), 'kory-external-outside-'));
  mkdirSync(join(outside, 'nested'));
  writeFileSync(join(outside, 'secret.txt'), 'outside evidence\n');
  writeFileSync(join(outside, 'nested', 'match.ts'), 'needle\n');
  registry = new ToolRegistry();
  for (const tool of [
    new ReadFileTool(),
    new WriteFileTool(),
    new GlobTool(),
    new GrepTool(),
    new DiffTool(),
    new MoveFileTool(),
    new BatchEditTool(),
    new ViewImageTool(),
  ])
    registry.register(tool);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('YOLO permits a call-bound outside read/search/glob/image path without a prompt', async () => {
  const approve = mock(async () => 'Allow once');
  const ctx = context({ permissionPolicy: policy('yolo'), waitForUserInput: approve });
  expect(
    (await registry.execute(ctx, call('read_file', { path: join(outside, 'secret.txt') }))).isError,
  ).toBe(false);
  expect(
    (await registry.execute(ctx, call('grep', { pattern: 'needle', path: outside }))).isError,
  ).toBe(false);
  expect(
    (await registry.execute(ctx, call('glob', { pattern: '**/*.ts', path: outside }))).isError,
  ).toBe(false);
  writeFileSync(join(outside, 'diagram.png'), 'not really decoded by view_image');
  expect(
    (await registry.execute(ctx, call('view_image', { path: join(outside, 'diagram.png') })))
      .isError,
  ).toBe(false);
  expect(approve).not.toHaveBeenCalled();
});

test('outside diff, batch edit, and move use one invocation grant in YOLO', async () => {
  const ctx = context({ permissionPolicy: policy('yolo') });
  const first = join(outside, 'first.txt');
  const second = join(outside, 'second.txt');
  const moved = join(outside, 'moved.txt');
  writeFileSync(first, 'before\n');
  writeFileSync(second, 'after\n');
  expect(
    (await registry.execute(ctx, call('diff', { path_a: first, path_b: second }))).isError,
  ).toBe(false);
  expect(
    (
      await registry.execute(
        ctx,
        call('batch_edit', {
          files: [{ path: first, edits: [{ old_str: 'before', new_str: 'edited' }] }],
        }),
      )
    ).isError,
  ).toBe(false);
  expect(
    (await registry.execute(ctx, call('move_file', { source: first, destination: moved }))).isError,
  ).toBe(false);
  expect(readFileSync(moved, 'utf8')).toBe('edited\n');
});

test.each(['guarded', 'edits', 'ask', 'custom'] as const)(
  '%s requires a human outside-path approval, not manager review',
  async (mode) => {
    const human = mock(async () => 'Allow once');
    const managerReview = mock(async () => true);
    const ctx = context({
      permissionPolicy: policy(mode),
      waitForUserInput: human,
      requestToolApproval: managerReview,
    });
    const result = await registry.execute(
      ctx,
      call('read_file', { path: join(outside, 'secret.txt') }),
    );
    expect(result.isError).toBe(false);
    expect(human).toHaveBeenCalledTimes(1);
    expect(managerReview).not.toHaveBeenCalled();
  },
);

test('an outside write is approved once but cannot broaden a worker/review write grant', async () => {
  const human = mock(async () => 'Allow once');
  const target = join(outside, 'created.txt');
  const result = await registry.execute(
    context({
      callerRole: 'worker',
      reviewWorkspaceRoot: canonicalizePath(root),
      requiredWorkspaceRoot: canonicalizePath(root),
      permissionPolicy: policy('yolo'),
      waitForUserInput: human,
    }),
    call('write_file', { path: target, content: 'must not escape' }),
  );
  expect(result.isError).toBe(true);
  expect(existsSync(target)).toBe(false);
  expect(human).not.toHaveBeenCalled();
});

test('Plan still denies an outside write before any human approval', async () => {
  const human = mock(async () => 'Allow once');
  const result = await registry.execute(
    context({ permissionPolicy: policy('guarded', 'plan'), waitForUserInput: human }),
    call('write_file', { path: join(outside, 'plan-denied.txt'), content: 'blocked' }),
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain('Planning mode blocked write-capable tool');
  expect(human).not.toHaveBeenCalled();
  expect(existsSync(join(outside, 'plan-denied.txt'))).toBe(false);
});

test('revalidates canonical symlink targets after human approval', async () => {
  const alias = join(root, 'external-link.txt');
  const second = mkdtempSync(join(tmpdir(), 'kory-external-second-'));
  writeFileSync(join(second, 'replacement.txt'), 'changed target\n');
  symlinkSync(join(outside, 'secret.txt'), alias);
  const human = mock(async () => {
    rmSync(alias);
    symlinkSync(join(second, 'replacement.txt'), alias);
    return 'Allow once';
  });
  try {
    const result = await registry.execute(
      context({ permissionPolicy: policy('guarded'), waitForUserInput: human }),
      call('read_file', { path: alias }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Tool execution failed safely');
  } finally {
    rmSync(second, { recursive: true, force: true });
  }
});

test('an outside grant is not persisted in the caller context', async () => {
  const ctx = context({ permissionPolicy: policy('yolo') });
  const target = join(outside, 'secret.txt');
  expect((await registry.execute(ctx, call('read_file', { path: target }))).isError).toBe(false);
  expect(ctx.allowedPaths).toEqual([root]);
  expect(ctx.requiredWorkspaceRoot).toBeUndefined();
  expect(readFileSync(target, 'utf8')).toContain('outside evidence');
});
