import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutateFileConfined } from '../confined-file-mutation';
import { osSandboxAvailable } from '../os-sandbox';
import {
  BatchEditTool,
  DeleteFileTool,
  EditFileTool,
  MoveFileTool,
  PatchTool,
  WriteFileTool,
} from '../../tools/files';
import type { Tool, ToolContext } from '../../tools/registry';

let base: string;
let root: string;
let outside: string;
let originalSandbox: string | undefined;

beforeEach(() => {
  originalSandbox = process.env.KORYPHAIOS_OS_SANDBOX;
  delete process.env.KORYPHAIOS_OS_SANDBOX;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'kory-confined-files-')));
  root = join(base, 'chat');
  outside = join(base, 'source');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'file.txt'), 'original');
  writeFileSync(join(outside, 'file.txt'), 'external original');
});

afterEach(() => {
  if (originalSandbox === undefined) delete process.env.KORYPHAIOS_OS_SANDBOX;
  else process.env.KORYPHAIOS_OS_SANDBOX = originalSandbox;
  rmSync(base, { recursive: true, force: true });
});

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'confined-files-test',
    workingDirectory: root,
    requiredWorkspaceRoot: root,
    // Even legacy broad access and optional sandbox=off cannot broaden the grant.
    allowedPaths: [base],
    isSandboxed: false,
    ...extra,
  };
}
function run(tool: Tool, input: Record<string, unknown>, extra: Partial<ToolContext> = {}) {
  return tool.run(context(extra), { id: 'mutation-test', name: tool.name, input });
}
function edits(path: string) {
  return { path, old_str: 'original', new_str: 'replacement' };
}
const mutations: Array<[Tool, Record<string, unknown>]> = [
  [new WriteFileTool(), { path: 'new/parent/file.txt', content: 'replacement' }],
  [new EditFileTool(), edits('file.txt')],
  [new BatchEditTool(), { files: [{ path: 'file.txt', edits: [edits('file.txt')] }] }],
  [new PatchTool(), { path: 'file.txt', edits: [edits('file.txt')] }],
  [new DeleteFileTool(), { path: 'file.txt' }],
  [new DeleteFileTool(), { path: 'empty' }],
  [new MoveFileTool(), { source: 'file.txt', destination: 'new/parent/moved.txt' }],
];

describe('mandatory file mutation fails closed', () => {
  for (const [index, [tool, input]] of mutations.entries()) {
    test(`${tool.name} (${index}) never falls back when enforcement is disabled`, async () => {
      mkdirSync(join(root, 'empty'));
      process.env.KORYPHAIOS_OS_SANDBOX = '0';
      const result = await run(tool, input);
      expect(result.isError).toBe(true);
      expect(result.output).toContain('OS sandbox enforcement is unavailable');
      expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original');
      expect(existsSync(join(root, 'new'))).toBe(false);
      expect(existsSync(join(root, 'empty'))).toBe(true);
    });
  }
  test('non-mandatory legacy writes still work with OS sandbox disabled', async () => {
    process.env.KORYPHAIOS_OS_SANDBOX = '0';
    const result = await run(
      new WriteFileTool(),
      { path: 'legacy/file.txt', content: 'legacy' },
      {
        requiredWorkspaceRoot: undefined,
      },
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(root, 'legacy/file.txt'), 'utf8')).toBe('legacy');
  });
  test('rejects a lexical external target and the grant root itself', async () => {
    for (const path of [outside, root, join(root, '..', 'source/file.txt')]) {
      await expect(
        mutateFileConfined(root, { operation: 'write', path, content: 'escape' }),
      ).rejects.toThrow('outside the mandatory workspace root');
    }
  });
});

// Real platform sandbox and filesystem: no mocks of the kernel boundary.
// The successful tests are important: an always-failing helper cannot pass.
describe.skipIf(!osSandboxAvailable())('kernel-confined file mutation integration', () => {
  for (const [index, [tool, input]] of mutations.entries()) {
    test(`${tool.name} (${index}) succeeds inside the owned root`, async () => {
      mkdirSync(join(root, 'empty'));
      const result = await run(tool, input);
      expect(result.isError).toBe(false);
      if (tool.name === 'write_file') {
        expect(readFileSync(join(root, 'new/parent/file.txt'), 'utf8')).toBe('replacement');
      } else if (tool.name === 'move_file') {
        expect(readFileSync(join(root, 'new/parent/moved.txt'), 'utf8')).toBe('original');
        expect(existsSync(join(root, 'file.txt'))).toBe(false);
      } else if (tool.name === 'delete_file') {
        expect(existsSync(join(root, input.path as string))).toBe(false);
      } else {
        expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('replacement');
      }
    });
  }

  for (const parentSwap of [false, true]) {
    for (const tool of [new WriteFileTool(), new EditFileTool(), new BatchEditTool()]) {
      test(`${tool.name} confines a ${parentSwap ? 'parent-directory' : 'file'} symlink swapped by UI callback`, async () => {
        const parent = join(root, 'parent');
        mkdirSync(parent);
        const target = join(parent, 'file.txt');
        writeFileSync(target, 'original');
        let swapped = false;
        let completed = false;
        let recorded = false;
        const input =
          tool.name === 'write_file'
            ? { path: target, content: 'replacement' }
            : tool.name === 'edit_file'
              ? edits(target)
              : { files: [{ path: target, edits: [edits(target)] }] };
        const result = await run(tool, input, {
          emitFileEdit: () => {
            if (swapped) return;
            swapped = true;
            if (parentSwap) {
              renameSync(parent, join(root, 'original-parent'));
              symlinkSync(outside, parent, 'dir');
            } else {
              unlinkSync(target);
              symlinkSync(join(outside, 'file.txt'), target);
            }
          },
          emitFileComplete: () => {
            completed = true;
          },
          recordChange: () => {
            recorded = true;
          },
        });
        expect(swapped).toBe(true);
        expect(result.isError).toBe(true);
        // macOS denies the write (EPERM/EROFS) because the profile leaves the
        // filesystem visible. Linux bubblewrap hides everything outside the
        // granted roots from the mount namespace, so the same escape resolves
        // to a nonexistent path (ENOENT) — or the recursive parent mkdir finds
        // the swapped symlink itself in the way, cannot stat through it into
        // the hidden filesystem, and aborts with EEXIST before any write is
        // attempted. All three prove the write never landed; the unchanged
        // external file below is the invariant that matters.
        expect(result.output).toMatch(
          /EPERM|EACCES|EROFS|ENOENT|EEXIST|[Oo]peration not permitted|[Rr]ead-only/,
        );
        expect(completed).toBe(false);
        expect(recorded).toBe(false);
        expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('external original');
      });
    }
  }

  test('parent creation cannot follow a swapped parent outside the grant', async () => {
    mkdirSync(join(root, 'parent'));
    const result = await run(
      new WriteFileTool(),
      {
        path: 'parent/new/deep/file.txt',
        content: 'replacement',
      },
      {
        emitFileEdit: () => {
          rmSync(join(root, 'parent'), { recursive: true });
          symlinkSync(outside, join(root, 'parent'), 'dir');
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(existsSync(join(outside, 'new'))).toBe(false);
  });

  test('kernel also confines delete, rmdir, and both move endpoints through a symlink parent', async () => {
    symlinkSync(outside, join(root, 'link'), 'dir');
    mkdirSync(join(outside, 'empty'));
    for (const mutation of [
      { operation: 'delete' as const, path: join(root, 'link/file.txt') },
      { operation: 'rmdir' as const, path: join(root, 'link/empty') },
      {
        operation: 'move' as const,
        source: join(root, 'link/file.txt'),
        destination: join(root, 'stolen.txt'),
      },
      {
        operation: 'move' as const,
        source: join(root, 'file.txt'),
        destination: join(root, 'link/moved.txt'),
      },
    ]) {
      await expect(mutateFileConfined(root, mutation)).rejects.toThrow(
        'Confined file mutation failed',
      );
    }
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('external original');
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(outside, 'empty'))).toBe(true);
    expect(existsSync(join(outside, 'moved.txt'))).toBe(false);
    expect(existsSync(join(root, 'stolen.txt'))).toBe(false);
  });

  test('file contents are data, including code-like strings and a large payload', async () => {
    const content =
      "'); require('node:fs').writeFileSync('/tmp/escaped', 'oops'); //\n" + 'x'.repeat(300_000);
    await mutateFileConfined(root, { operation: 'write', path: join(root, 'file.txt'), content });
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe(content);
  });
});
