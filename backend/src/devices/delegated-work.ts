import { readFileSync, statSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { isContainedBy } from '../runtime/platform';
import {
  DELEGATION_LIMITS,
  describeReturnedWork,
  type DelegatedFileChange,
  type DelegatedWorkBundle,
  type DelegationCommitPolicy,
  type DelegationPlacement,
} from '@koryphaios/shared/src/compute-delegation';

const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Files that must never cross a machine boundary implicitly. A returned bundle
 * is a copy of the target checkout, so credentials and dependency trees are
 * excluded before anything is read, not filtered afterwards.
 */
function isDeniedPath(path: string): boolean {
  const value = path.replaceAll('\\', '/');
  if (/(^|\/)(node_modules|\.git|dist|build|target|\.koryphaios\/incoming)(\/|$)/i.test(value))
    return true;
  const name = value.split('/').pop() ?? '';
  if (/^\.env(\..+)?$/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name))
    return true;
  return /^(id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.p12|.*\.pfx)$/i.test(name);
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return false;
  const normalized = normalize(path).replaceAll('\\', '/');
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../'))
    return false;
  return !normalized.split('/').some((part) => part === '..' || part === '');
}

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: 20_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
  return { ok: true, out: result.stdout ?? '' };
}

function isTextFile(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size > DELEGATION_LIMITS.maxFileBytes) return false;
    const bytes = readFileSync(path);
    return !bytes.subarray(0, 8_000).includes(0);
  } catch {
    return false;
  }
}

/**
 * Read the target checkout's changes without mutating it. This is strictly
 * read-only: no add, commit, stash, checkout or push.
 */
export function exportWorkspaceChanges(input: {
  workspaceRoot: string;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  workspaceName: string;
  placement: DelegationPlacement;
  commit: DelegationCommitPolicy;
  transferId?: string;
  sourceSessionId?: string;
  summary?: string;
}): DelegatedWorkBundle {
  const root = realpathSync(input.workspaceRoot);
  const transferId = (input.transferId ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9._-]/g, '-');
  const notes: string[] = [];
  const files: DelegatedFileChange[] = [];
  let truncated = false;

  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  const isGit = inside.ok && inside.out.trim() === 'true';
  const baseCommit = isGit ? (git(root, ['rev-parse', 'HEAD']).out.trim() || null) : null;

  let patch = '';
  if (isGit) {
    const diff = git(root, ['diff', '--binary', '--no-color', baseCommit ? 'HEAD' : '--cached']);
    if (!diff.ok) {
      notes.push('Git diff could not be produced; only untracked files are included.');
    } else if (diff.out.length > DELEGATION_LIMITS.maxPatchBytes) {
      patch = diff.out.slice(0, DELEGATION_LIMITS.maxPatchBytes);
      truncated = true;
      notes.push(`Patch truncated at ${DELEGATION_LIMITS.maxPatchBytes} bytes.`);
    } else {
      patch = diff.out;
    }

    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.ok) {
      const tokens = status.out.split('\0');
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        if (token.length < 4) continue;
        const code = token.slice(0, 2);
        // Rename/copy entries carry the original path as the next token.
        if (/[RC]/.test(code[0] ?? '')) index += 1;
        const path = token.slice(3);
        if (!path || isDeniedPath(path) || !isSafeRelativePath(path)) continue;
        if (files.length >= DELEGATION_LIMITS.maxFiles) {
          truncated = true;
          notes.push(`File list truncated at ${DELEGATION_LIMITS.maxFiles} entries.`);
          break;
        }
        const absolute = join(root, path);
        let size = 0;
        try {
          size = statSync(absolute).size;
        } catch {
          /* deleted files have no current size */
        }
        const row: DelegatedFileChange = { path, status: code.trim() || '??', size };
        if (code === '??' && isTextFile(absolute)) {
          const remaining = DELEGATION_LIMITS.maxTransferBytes - patch.length;
          if (size <= remaining) {
            row.content = readFileSync(absolute, 'utf8');
          } else {
            truncated = true;
            notes.push(`Untracked file ${path} was not included (size bound).`);
          }
        }
        files.push(row);
      }
    }
  } else {
    notes.push('The target workspace is not a git checkout; no patch is available.');
  }

  return {
    version: 1,
    transferId,
    sessionId: input.sessionId,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    workspaceName: input.workspaceName,
    placement: input.placement,
    commit: input.commit,
    createdAt: Date.now(),
    baseCommit,
    patch,
    files,
    summary: (input.summary ?? '').slice(0, 8_000),
    truncated,
    notes,
  };
}

function safeDirectoryId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : crypto.randomUUID();
}

/**
 * Write returned work beside the origin checkout. Nothing is applied, staged,
 * committed or pushed: the user reviews the patch and decides.
 */
export function materializeDelegatedWork(
  workingDirectory: string,
  bundle: DelegatedWorkBundle,
): { directory: string; patchPath: string | null; files: number; truncated: boolean } {
  const base = realpathSync(workingDirectory);
  const directory = join(base, '.koryphaios', 'incoming', safeDirectoryId(bundle.transferId));
  const filesRoot = join(directory, 'files');
  mkdirSync(filesRoot, { recursive: true });
  let patchPath: string | null = null;
  if (bundle.patch) {
    patchPath = join(directory, 'changes.patch');
    writeFileSync(patchPath, bundle.patch, { mode: 0o600 });
  }
  let written = 0;
  for (const file of bundle.files) {
    if (file.content === undefined) continue;
    if (isDeniedPath(file.path) || !isSafeRelativePath(file.path)) continue;
    const target = join(filesRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!isContainedBy(filesRoot, target)) continue;
    writeFileSync(target, file.content, { mode: 0o600 });
    written += 1;
  }
  writeFileSync(join(directory, 'bundle.json'), JSON.stringify(bundle, null, 2), { mode: 0o600 });
  writeFileSync(join(directory, 'TRANSFER.md'), describeReturnedWork(bundle), { mode: 0o600 });
  return { directory, patchPath, files: written, truncated: bundle.truncated };
}
