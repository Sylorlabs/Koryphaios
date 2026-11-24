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

  test('an alias-spelling path inside a canonical working directory is not external', () => {
    const { real, cwd } = symlinkedWorkspace();
    // Mirrors a session rooted at the canonical path (bridge chatRoot resolves
    // symlinks) receiving a target spelled through the alias — macOS /tmp vs
    // /private/tmp being the everyday case.
    const ctx = {
      sessionId: 'scope-test',
      workingDirectory: canonicalizePath(real),
    } as ToolContext;
    const scope = new FilePathScope(ctx, call('read_file', { path: join(cwd, 'index.html') }));
    expect(scope.externalPaths).toEqual([]);
    const writeScope = new FilePathScope(
      ctx,
      call('write_file', { path: join(cwd, 'new-file.txt'), content: 'x' }),
    );
    expect(writeScope.externalPaths).toEqual([]);
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
    const scope = new FilePathScope(ctx, call('read_file', { path: '../outside/secret.txt' }));
    expect(scope.externalPaths).toHaveLength(1);
  });

  test('a path inside a host-granted read root is not external', () => {
    const { cwd, ctx } = symlinkedWorkspace();
    // A managed CLI's private jail temp: outside cwd, explicitly allowed.
    const privateTmp = mkdtempSync(join(tmpdir(), 'kory-home-'));
    mkdirSync(join(privateTmp, '.tmp'), { recursive: true });
    directories.push(privateTmp);
    const overflow = join(privateTmp, '.tmp', 'devin-overflows-501', 'content.txt');
    mkdirSync(join(privateTmp, '.tmp', 'devin-overflows-501'), { recursive: true });
    writeFileSync(overflow, 'tool output\n');
    const scoped = {
      ...ctx,
      allowedPaths: [cwd, privateTmp],
    } as ToolContext;
    const scope = new FilePathScope(scoped, call('read_file', { path: overflow }));
    expect(scope.externalPaths).toEqual([]);
  });

  test('a symlink inside an allowed root pointing elsewhere stays external', () => {
    const { cwd, ctx } = symlinkedWorkspace();
    const privateTmp = mkdtempSync(join(tmpdir(), 'kory-home-'));
    directories.push(privateTmp);
    const elsewhere = mkdtempSync(join(tmpdir(), 'kory-scope-else-'));
    directories.push(elsewhere);
    writeFileSync(join(elsewhere, 'secret.txt'), 'x\n');
    symlinkSync(elsewhere, join(privateTmp, 'link-out'));
    const scoped = {
      ...ctx,
      allowedPaths: [cwd, privateTmp],
    } as ToolContext;
    const scope = new FilePathScope(
      scoped,
      call('read_file', { path: join(privateTmp, 'link-out', 'secret.txt') }),
    );
    expect(scope.externalPaths).toHaveLength(1);
  });
});

/** A review copy (cwd) plus the producer checkout it mirrors: ctx carries
 * reviewSourceRoot so producer-spelled paths land on the copy. */
function reviewCopyWorkspace() {
  const producer = mkdtempSync(join(tmpdir(), 'kory-review-src-'));
  const copy = mkdtempSync(join(tmpdir(), 'kory-review-copy-'));
  directories.push(producer, copy);
  mkdirSync(join(producer, 'src'), { recursive: true });
  mkdirSync(join(copy, 'src'), { recursive: true });
  writeFileSync(join(producer, 'src', 'index.ts'), 'producer contents\n');
  writeFileSync(join(copy, 'src', 'index.ts'), 'copy contents\n');
  const ctx = {
    sessionId: 'scope-test',
    workingDirectory: copy,
    reviewSourceRoot: producer,
  } as ToolContext;
  return { producer, copy, ctx };
}

describe('FilePathScope reviewSourceRoot mapping', () => {
  test('a producer-absolute path maps to the same relative path in the copy', () => {
    const { producer, copy, ctx } = reviewCopyWorkspace();
    const scope = new FilePathScope(
      ctx,
      call('read_file', { path: join(producer, 'src', 'index.ts') }),
    );
    expect(scope.externalPaths).toEqual([]);
    expect(scope.call.input.path).toBe(canonicalizePath(join(copy, 'src', 'index.ts')));
  });

  test('a canonical-spelled producer path under a symlinked source root maps into the copy', () => {
    const { copy } = reviewCopyWorkspace();
    const realSrc = mkdtempSync(join(tmpdir(), 'kory-review-real-'));
    const aliasRoot = mkdtempSync(join(tmpdir(), 'kory-review-alias-'));
    directories.push(realSrc, aliasRoot);
    const aliasSrc = join(aliasRoot, 'src-alias');
    symlinkSync(realSrc, aliasSrc);
    mkdirSync(join(realSrc, 'src'), { recursive: true });
    writeFileSync(join(realSrc, 'src', 'index.ts'), 'producer\n');
    mkdirSync(join(copy, 'src'), { recursive: true });
    writeFileSync(join(copy, 'src', 'index.ts'), 'copy\n');
    const ctx = {
      sessionId: 'scope-test',
      workingDirectory: copy,
      reviewSourceRoot: aliasSrc,
    } as ToolContext;
    const scope = new FilePathScope(
      ctx,
      call('read_file', { path: join(realSrc, 'src', 'index.ts') }),
    );
    expect(scope.externalPaths).toEqual([]);
    expect(scope.call.input.path).toBe(canonicalizePath(join(copy, 'src', 'index.ts')));
  });

  test('a path outside both the copy and the source root stays external', () => {
    const { ctx } = reviewCopyWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'kory-review-out-'));
    directories.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
    const scope = new FilePathScope(ctx, call('read_file', { path: join(outside, 'secret.txt') }));
    expect(scope.externalPaths).toHaveLength(1);
  });

  test('a symlink inside the copy pointing outside stays external', () => {
    const { copy, ctx } = reviewCopyWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'kory-review-out-'));
    directories.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
    symlinkSync(outside, join(copy, 'link-out'));
    const scope = new FilePathScope(
      ctx,
      call('read_file', { path: join(copy, 'link-out', 'secret.txt') }),
    );
    expect(scope.externalPaths).toHaveLength(1);
  });
});
