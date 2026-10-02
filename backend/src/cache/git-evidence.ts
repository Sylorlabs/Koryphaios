import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export interface GitBlobEvidenceIdentity {
  scope: string;
  oid: string;
  algorithm: 'sha1' | 'sha256';
}
export interface GitTreeEvidenceIdentity extends GitBlobEvidenceIdentity {
  relativeWorkingDirectory: string;
}
interface RepoInfo {
  root: string;
  scope: string;
  algorithm: 'sha1' | 'sha256';
  workingDirectory: string;
}
interface CachedIdentity {
  fingerprint: string;
  identity?: GitBlobEvidenceIdentity;
}
const repoCache = new Map<string, Promise<RepoInfo | undefined>>();
const identityCache = new Map<string, CachedIdentity>();
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return String(r.stdout).trim();
}
async function repoInfo(workingDirectory: string): Promise<RepoInfo | undefined> {
  let wd: string;
  try {
    wd = await realpath(workingDirectory);
  } catch {
    return undefined;
  }
  let cached = repoCache.get(wd);
  if (!cached) {
    cached = (async () => {
      try {
        const root = await realpath(await git(wd, ['rev-parse', '--show-toplevel']));
        const commonRaw = await git(wd, ['rev-parse', '--git-common-dir']);
        const common = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
        const format = await git(wd, ['rev-parse', '--show-object-format']).catch(() => 'sha1');
        return {
          root,
          scope: createHash('sha256').update(common).digest('hex'),
          algorithm: format === 'sha256' ? 'sha256' : 'sha1',
          workingDirectory: wd,
        };
      } catch {
        return undefined;
      }
    })();
    repoCache.set(wd, cached);
  }
  return cached;
}
export async function tryResolveGitBlobEvidenceIdentity(
  workingDirectory: string,
  filePath: string,
): Promise<GitBlobEvidenceIdentity | undefined> {
  const info = await repoInfo(workingDirectory);
  if (!info) return undefined;
  let file: string;
  try {
    file = await realpath(filePath);
  } catch {
    return undefined;
  }
  const rel = relative(info.root, file).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../')) return undefined;
  let st;
  try {
    st = await stat(file);
  } catch {
    return undefined;
  }
  const fp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const cached = identityCache.get(file);
  if (cached?.fingerprint === fp) return cached.identity;
  try {
    const status = await git(info.root, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      rel,
    ]);
    if (status) {
      identityCache.set(file, { fingerprint: fp, identity: undefined });
      return undefined;
    }
    const indexed = await git(info.root, ['ls-files', '-s', '--', rel]);
    const m = indexed.match(/^\d+\s+([0-9a-f]+)\s+0\t/u);
    if (!m) {
      identityCache.set(file, { fingerprint: fp, identity: undefined });
      return undefined;
    }
    const identity = {
      scope: info.scope,
      oid: m[1],
      algorithm: info.algorithm,
    } as GitBlobEvidenceIdentity;
    identityCache.set(file, { fingerprint: fp, identity });
    return identity;
  } catch {
    return undefined;
  }
}
export async function tryResolveGitTreeEvidenceIdentity(
  workingDirectory: string,
): Promise<GitTreeEvidenceIdentity | undefined> {
  const info = await repoInfo(workingDirectory);
  if (!info) return undefined;
  try {
    if (await git(info.root, ['status', '--porcelain=v1', '--untracked-files=all']))
      return undefined;
    const oid = await git(info.root, ['rev-parse', 'HEAD^{tree}']);
    return {
      scope: info.scope,
      oid,
      algorithm: info.algorithm,
      relativeWorkingDirectory:
        relative(info.root, info.workingDirectory).replaceAll('\\', '/') || '.',
    };
  } catch {
    return undefined;
  }
}
export function gitBlobMatchesContent(
  content: Uint8Array,
  identity: GitBlobEvidenceIdentity,
): boolean {
  const header = Buffer.from(`blob ${content.byteLength}\0`, 'utf8');
  return (
    createHash(identity.algorithm).update(header).update(content).digest('hex') === identity.oid
  );
}
export function clearGitEvidenceIdentityCache(): void {
  repoCache.clear();
  identityCache.clear();
}
