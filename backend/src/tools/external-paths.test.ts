import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalizePath } from '../runtime/platform';
import { FilePathScope } from './external-paths';
import type { ToolCallInput, ToolContext } from './registry';

const directories: string[] = [];

function call(name: string, input: Record<string, unknown>): ToolCallInput {
  return { id: crypto.randomUUID(), name, input };
}

/** A working directory reached through a symlink: `ctx.workingDirectory` is
 * the alias, its canonical form is the real directory — on every OS, not just
 * macOS's /var→/private/var rewrite. */
function symlinkedWorkspace() {
  const real = mkdtempSync(join(tmpdir(), 'kory-scope-real-'));
  const aliasRoot = mkdtempSync(join(tmpdir(), 'kory-scope-alias-'));
  directories.push(real, aliasRoot);
  const cwd = join(aliasRoot, 'workspace');
  symlinkSync(real, cwd);
  writeFileSync(join(real, 'index.html'), '<html></html>\n');
  const ctx = { sessionId: 'scope-test', workingDirectory: cwd } as ToolContext;
  return { real, cwd, ctx };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FilePathScope.externalPaths', () => {
  test('a canonical-spelling path inside the project is not external', () => {
    const { real, ctx } = symlinkedWorkspace();
    const canonicalSpelling = join(canonicalizePath(real), 'index.html');
    const scope = new FilePathScope(ctx, call('read_file', { path: canonicalSpelling }));
    expect(scope.externalPaths).toEqual([]);
  });

  test('a symlink inside the project pointing outside stays external', () => {
    const { real, cwd, ctx } = symlinkedWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'kory-scope-out-'));
    directories.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside evidence\n');
    symlinkSync(outside, join(real, 'link-out'));
    const scope = new FilePathScope(
      ctx,
      call('read_file', { path: join(cwd, 'link-out', 'secret.txt') }),
    );
    expect(scope.externalPaths).toHaveLength(1);
  });

  test('traversal outside the project stays external', () => {
    const { ctx } = symlinkedWorkspace();
    const scope = new FilePathScope(
      ctx,
      call('read_file', { path: '../outside/secret.txt' }),
    );
    expect(scope.externalPaths).toHaveLength(1);
  });
});
