import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionWorkspace } from '../kory/session-workspace';
import { osSandboxEnabled, spawnSandboxed } from '../security/os-sandbox';
import { BashTool } from './bash';
import {
  BatchEditTool,
  DeleteFileTool,
  EditFileTool,
  MoveFileTool,
  PatchTool,
  ReadFileTool,
  WriteFileTool,
} from './files';
import { ToolRegistry, type ToolContext } from './registry';

const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'kory-write-grant-')));
const source = join(fixture, 'source');
let checkout: string;
let sibling: string;
const registry = new ToolRegistry();
for (const tool of [
  new BashTool(),
  new WriteFileTool(),
  new ReadFileTool(),
  new EditFileTool(),
  new BatchEditTool(),
  new MoveFileTool(),
  new DeleteFileTool(),
  new PatchTool(),
])
  registry.register(tool);
const off = {
  isSandboxed: false,
  pathConfinement: false,
  commandWhitelist: false,
  metacharacters: false,
  network: false,
  containerTools: false,
  degraded: true,
};
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'write-grant-test',
    workingDirectory: checkout,
    isSandboxed: false,
    sandboxOptions: off,
    allowedPaths: ['/'],
    permissionPolicy: {
      mode: 'yolo',
      autoRunTools: true,
      autoApplySafeFixes: true,
      confirmRiskyActions: false,
      autonomyLimitsEnabled: false,
      approvalThresholdFiles: 100,
      approvalThresholdLines: 10000,
      toolAllowlist: [],
      toolBlocklist: [],
      toolAsklist: [],
    },
    ...overrides,
  };
}
function execute(
  name: string,
  input: Record<string, unknown>,
  overrides: Partial<ToolContext> = {},
) {
  return registry.execute(context(overrides), { id: crypto.randomUUID(), name, input });
}
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function probeSandbox(): Promise<boolean> {
  if (!osSandboxEnabled()) return false;
  try {
    const { proc, cleanup } = spawnSandboxed(['/bin/echo', 'probe'], {
      allowedRoots: [fixture],
      cwd: fixture,
      blockNetwork: false,
      blockSubprocesses: false,
    });
    const code = await new Promise<number>((resolve) => {
      proc.once('error', () => resolve(1));
      proc.once('exit', (code) => resolve(code ?? 1));
    });
    cleanup();
    return code === 0;
  } catch {
    return false;
  }
}
const operational = await probeSandbox();

beforeAll(async () => {
  mkdirSync(source);
  writeFileSync(join(source, 'baseline.txt'), 'original\n');
  git(source, 'init');
  git(source, 'add', '.');
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'baseline',
  );
  checkout = (await createSessionWorkspace(source, { storageRoot: join(fixture, 'chats') })).path;
  sibling = (await createSessionWorkspace(source, { storageRoot: join(fixture, 'chats') })).path;
  mkdirSync(join(checkout, 'worker'));
  symlinkSync(source, join(checkout, 'escape'));
  symlinkSync(source, join(checkout, '%65scape'));
  symlinkSync(join(source, 'missing'), join(checkout, 'dangling'));
}, 30_000);
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe('owned chat mandatory write boundary', () => {
  test('derives canonical narrower worker authority, ignoring supplied roots and sandbox-off preferences', async () => {
    registry.register({
      name: 'inspect_context',
      description: '',
      inputSchema: {},
      async run(ctx, call) {
        return {
          callId: call.id,
          name: call.name,
          output: ctx.requiredWorkspaceRoot ?? '',
          isError: false,
          durationMs: 0,
        };
      },
    });
    const worker = join(checkout, 'worker');
    const result = await execute(
      'inspect_context',
      { requiredWorkspaceRoot: '/' },
      {
        workingDirectory: worker,
      },
    );
    expect(result.output).toBe(realpathSync(worker));
    const redirectedGrant = await execute(
      'inspect_context',
      {},
      {
        workingDirectory: worker,
        requiredWorkspaceRoot: source,
      },
    );
    expect(redirectedGrant.isError).toBe(true);
    const outsideWorker = await execute(
      'write_file',
      { path: join(checkout, 'worker-escape'), content: 'bad' },
      { workingDirectory: worker },
    );
    expect(outsideWorker.isError).toBe(true);
    expect(existsSync(join(checkout, 'worker-escape'))).toBe(false);
  });

  test('a lexical owned cwd redirected to the source never becomes an unconfined context', async () => {
    const result = await execute(
      'write_file',
      { path: 'escaped-from-cwd', content: 'bad' },
      {
        workingDirectory: join(checkout, 'escape'),
      },
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(source, 'escaped-from-cwd'))).toBe(false);
  });

  test('allows local writes but blocks source, sibling, symlink ancestors and dangling links', async () => {
    const local = await execute('write_file', { path: 'new/deep/file', content: 'local' });
    expect(local.isError).toBe(false);
    expect(readFileSync(join(checkout, 'new/deep/file'), 'utf8')).toBe('local');
    for (const path of [
      join(source, 'bad'),
      join(sibling, 'bad'),
      'escape/new/deep/file',
      '%65scape/new/file',
      'dangling/new/file',
    ]) {
      const result = await execute('write_file', {
        path,
        content: 'bad',
        requiredWorkspaceRoot: '/',
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('mandatory workspace boundary');
    }
    expect(existsSync(join(source, 'new'))).toBe(false);
    expect(existsSync(join(source, 'bad'))).toBe(false);
    expect(existsSync(join(sibling, 'bad'))).toBe(false);
  });

  test('checks every mutating tool, including batch members and both move endpoints', async () => {
    const target = join(source, 'baseline.txt');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['edit_file', { path: target, old_str: 'original', new_str: 'bad' }],
      ['delete_file', { path: target }],
      ['patch', { path: target, operations: [] }],
      [
        'batch_edit',
        { files: [{ path: target, edits: [{ old_str: 'original', new_str: 'bad' }] }] },
      ],
      ['move_file', { source: target, destination: join(checkout, 'stolen') }],
      ['move_file', { source: join(checkout, 'baseline.txt'), destination: target }],
    ];
    for (const [name, input] of calls) expect((await execute(name, input)).isError).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  test('rechecks symlinks after asynchronous approval/preflight hooks', async () => {
    const changing = join(checkout, 'changing');
    mkdirSync(changing);
    const result = await execute(
      'write_file',
      { path: 'changing/preflight-escape', content: 'bad' },
      {
        preflightFileChange: async () => {
          rmSync(changing, { recursive: true });
          symlinkSync(source, changing);
          return { allowed: true };
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(source, 'preflight-escape'))).toBe(false);
  });

  test('does not turn write confinement into a blanket outside-read ban', async () => {
    const result = await execute('read_file', { path: join(source, 'baseline.txt') });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('original');
  });

  test('retains approval requirements even within the mandatory grant', async () => {
    const ctx = context();
    ctx.permissionPolicy = { ...ctx.permissionPolicy!, toolAsklist: ['write_file'] };
    const result = await registry.execute(ctx, {
      id: 'approval',
      name: 'write_file',
      input: { path: 'approval-file', content: 'bad' },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('no human approval channel');
    expect(existsSync(join(checkout, 'approval-file'))).toBe(false);
  });

  test('sandbox-off and YOLO fail closed when the OS engine is disabled', async () => {
    const previous = process.env.KORYPHAIOS_OS_SANDBOX;
    process.env.KORYPHAIOS_OS_SANDBOX = '0';
    try {
      const result = await execute('bash', { command: 'touch must-not-run' });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('kernel path confinement is unavailable');
      expect(existsSync(join(checkout, 'must-not-run'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
      else process.env.KORYPHAIOS_OS_SANDBOX = previous;
    }
  });

  test('rejects escaped and symlinked cwd even when pathConfinement is false', async () => {
    for (const workingDirectory of [source, sibling, join(checkout, 'escape')]) {
      const result = await execute('bash', { command: 'touch bad-cwd', workingDirectory });
      expect(result.isError).toBe(true);
      expect(result.output).toContain('working directory is outside');
    }
    expect(existsSync(join(source, 'bad-cwd'))).toBe(false);
  });

  test('a previously mandatory context cannot downgrade when ownership disappears', async () => {
    const result = await execute(
      'bash',
      { command: 'touch ownership-lost' },
      {
        workingDirectory: source,
        requiredWorkspaceRoot: checkout,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Cannot establish the mandatory workspace boundary');
    expect(existsSync(join(source, 'ownership-lost'))).toBe(false);
  });

  test('cannot escape through the unsandboxed background supervisor', async () => {
    const result = await execute('bash', { command: 'touch background', isBackground: true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Sandboxed background processes are unavailable');
  });

  test.skipIf(!operational)(
    'OS layer cannot broaden a mandatory root using allowedRoots or symlink cwd',
    () => {
      for (const cwd of [source, join(checkout, 'escape')]) {
        expect(() =>
          spawnSandboxed(['/bin/echo', 'must-not-run'], {
            requiredWorkspaceRoot: checkout,
            allowedRoots: ['/'],
            cwd,
            blockNetwork: false,
            blockSubprocesses: false,
          }),
        ).toThrow('not inside any allowed root');
      }
    },
  );

  test.skipIf(!operational)(
    'an owned checkout inside the data directory stays usable without exposing neighboring state',
    async () => {
      const previous = process.env.KORYPHAIOS_DATA_DIR;
      process.env.KORYPHAIOS_DATA_DIR = fixture;
      try {
        const result = await execute('bash', { command: 'git status --short' });
        expect(result.isError, result.output).toBe(false);
        if (process.platform === 'darwin') {
          const neighboringState = await execute('bash', {
            command: `cat ${quote(join(source, 'baseline.txt'))}`,
          });
          expect(neighboringState.isError).toBe(true);
        }
      } finally {
        if (previous === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
        else process.env.KORYPHAIOS_DATA_DIR = previous;
      }
    },
  );

  // Git canonicalizes and creates every leading component of a path it touches.
  // Denying reads on the whole data directory therefore broke `rev-parse
  // --is-inside-work-tree` and `worktree add` for a checkout the chat owns,
  // which silently disabled worktree-isolated delegation. Reaching the checkout
  // must work; neighboring state and credentials must stay unreadable.
  test.skipIf(!operational)(
    'resolving repository identity and adding worktrees works from a checkout under the data directory',
    async () => {
      const previous = process.env.KORYPHAIOS_DATA_DIR;
      process.env.KORYPHAIOS_DATA_DIR = fixture;
      try {
        const inside = await execute('bash', { command: 'git rev-parse --is-inside-work-tree' });
        expect(inside.isError, inside.output).toBe(false);
        expect(inside.output).toContain('true');
        const worktree = await execute('bash', {
          command: 'git worktree add --detach .trees/delegated HEAD',
        });
        expect(worktree.isError, worktree.output).toBe(false);
        expect(existsSync(join(checkout, '.trees', 'delegated', 'baseline.txt'))).toBe(true);
        if (process.platform === 'darwin') {
          const siblingState = await execute('bash', {
            command: `cat ${quote(join(sibling, 'baseline.txt'))}`,
          });
          expect(siblingState.isError).toBe(true);
          expect(siblingState.output).not.toContain('original');
        }
      } finally {
        if (previous === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
        else process.env.KORYPHAIOS_DATA_DIR = previous;
      }
    },
  );

  test.skipIf(!operational)(
    'kernel permits local shell writes and git, but blocks source/sibling git and scripts/environment escapes',
    async () => {
      const local = await execute('bash', {
        command:
          'printf local > shell-local; git add shell-local && git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit -m local',
      });
      expect(local.isError, local.output).toBe(false);
      expect(git(checkout, 'show', 'HEAD:shell-local')).toBe('local');
      for (const outside of [source, sibling]) {
        const originalHead = git(outside, 'rev-parse', 'HEAD');
        const commands = [
          `printf bad > ${quote(join(outside, 'shell-escape'))}`,
          `git -C ${quote(outside)} config --local isolation.escape bad`,
          `git --git-dir=${quote(join(outside, '.git'))} update-ref refs/heads/escape HEAD`,
          `GIT_DIR=${quote(join(outside, '.git'))} git update-ref refs/heads/env-escape HEAD`,
        ];
        writeFileSync(
          join(checkout, 'escape-script.sh'),
          `#!/bin/sh\nprintf bad > ${quote(join(outside, 'script-escape'))}\n`,
        );
        commands.push('sh escape-script.sh');
        for (const command of commands) {
          const result = await execute('bash', { command });
          expect(result.isError).toBe(true);
        }
        expect(existsSync(join(outside, 'shell-escape'))).toBe(false);
        expect(existsSync(join(outside, 'script-escape'))).toBe(false);
        expect(git(outside, 'rev-parse', 'HEAD')).toBe(originalHead);
        expect(git(outside, 'branch', '--list', 'escape', 'env-escape')).toBe('');
        expect(readFileSync(join(outside, '.git/config'), 'utf8')).not.toContain('isolation');
      }
      const symlink = await execute('bash', { command: 'printf bad > escape/symlink-escape' });
      expect(symlink.isError).toBe(true);
      expect(existsSync(join(source, 'symlink-escape'))).toBe(false);
      // Selecting a deeper cwd must not shrink the authorized workspace to that cwd.
      const nested = await execute('bash', {
        command: 'printf allowed > ../from-subdir',
        workingDirectory: 'worker',
      });
      expect(nested.isError).toBe(false);
      expect(readFileSync(join(checkout, 'from-subdir'), 'utf8')).toBe('allowed');
    },
    30_000,
  );
});
