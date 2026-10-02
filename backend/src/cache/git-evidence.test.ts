import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearGitEvidenceIdentityCache,
  gitBlobMatchesContent,
  tryResolveGitBlobEvidenceIdentity,
  tryResolveGitTreeEvidenceIdentity,
} from './git-evidence';
const roots: string[] = [];
afterEach(() => {
  clearGitEvidenceIdentityCache();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
describe('Git evidence identity', () => {
  test('shares clean blobs/trees across worktrees and bypasses dirty state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-evidence-'));
    roots.push(root);
    git(root, 'init', '-q');
    const file = join(root, 'shared.ts');
    writeFileSync(file, 'export const value = 1;\n');
    git(root, 'add', 'shared.ts');
    git(
      root,
      '-c',
      'user.name=Kory Test',
      '-c',
      'user.email=kory@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    const wt = `${root}-wt`;
    roots.push(wt);
    git(root, 'worktree', 'add', '--detach', '-q', wt, 'HEAD');
    const other = join(wt, 'shared.ts');
    const a = await tryResolveGitBlobEvidenceIdentity(root, file),
      b = await tryResolveGitBlobEvidenceIdentity(wt, other);
    expect(a).toBeDefined();
    expect(b).toEqual(a);
    expect(gitBlobMatchesContent(readFileSync(file), a!)).toBe(true);
    const ta = await tryResolveGitTreeEvidenceIdentity(root),
      tb = await tryResolveGitTreeEvidenceIdentity(wt);
    expect(ta?.scope).toBe(tb?.scope);
    expect(ta?.oid).toBe(tb?.oid);
    writeFileSync(other, 'export const value = 2;\n');
    expect(await tryResolveGitBlobEvidenceIdentity(wt, other)).toBeUndefined();
    expect(await tryResolveGitTreeEvidenceIdentity(wt)).toBeUndefined();
  });
});
