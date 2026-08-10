/**
 * ShadowRepo — isolated git repository for ghost commits.
 *
 * Ghost commits (privately retained checkpoints created by CheckpointStore) are stored
 * in a separate bare git repository under the common Git directory at
 * `.git/koryphaios/shadow-git/`. This keeps refs and objects invisible to
 * ordinary main-repository Git operations while preserving them when a
 * disposable linked worktree is removed.
 *
 * ## How it works
 *
 * The shadow repo is a **bare** repository (no working tree of its own).
 * When CheckpointStore needs to write a ghost commit, it uses a `GitExecutor`
 * configured with `GIT_DIR=<shadow-path>` and `GIT_WORK_TREE=<project-root>`.
 *
 * A **one-way alternate** lets the private repository read the main object
 * database while a snapshot is being assembled:
 *
 * - `shadow-git/objects/info/alternates` → the common `.git/objects`
 *
 * Every published snapshot is packed and physically verified inside the
 * shadow repository first. Main-repository commands receive a private object
 * directory only for the bounded operation that needs it; the main repository
 * never retains a reverse alternate.
 *
 * ## Migration
 *
 * On first construction after upgrade, `ensure()` detects legacy ghost refs
 * (`refs/kory/*`, `refs/notes/checkpoint-store`) in the main `.git/` and
 * migrates them to the shadow repo. Old objects in `.git/objects/` become
 * unreachable and are cleaned by normal `git gc`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, join, resolve, relative } from 'node:path';
import { GitExecutor } from './git-executor';
import { koryLog } from '../logger';

/** Refs that belong to the checkpoint system and should live in the shadow repo. */
const SHADOW_REF_PREFIXES = [
  'refs/kory/',
  'refs/notes/checkpoint-store',
  'refs/notes/shadow-logger',
];

const LOCK_DIRECTORY_NAME = 'koryphaios-locks';
const LOCK_NAME = 'checkpoint-shadow.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const LOCK_RETRY_MS = 25;
const OWNER_WRITE_GRACE_MS = 5_000;

interface RepositoryContext {
  gitDir: string;
  commonGitDir: string;
  mainObjects: string;
  storageRoot: string;
  shadow: string;
  legacyShadows: string[];
  marker: string;
}

interface ShadowStorageMarker {
  version: 2;
  objectFormat: 'sha1' | 'sha256';
  shadowPath: string;
  initializedAt: string;
}

const SHADOW_STORAGE_VERSION = 2;
const SHADOW_STORAGE_DIRECTORY = 'koryphaios';
const SHADOW_STORAGE_MARKER = 'shadow-storage.json';

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
  purpose: string;
  processIdentity?: string;
}

interface LockSnapshot {
  device: number;
  inode: number;
  modifiedAt: number;
  ownerToken: string | null;
}

/** Repository hooks can control Git stderr/stdout. Retain only structural
 * diagnostics at the logging boundary, never the captured text itself. */
export function shadowGitLogMetadata(
  operation: 'update-ref-copy',
  result: { success: boolean; output: string },
): { gitOperation: 'update-ref-copy'; success: boolean; outputLength: number } {
  return {
    gitOperation: operation,
    success: result.success,
    outputLength: result.output.length,
  };
}

export class ShadowRepo {
  /** Coalesce only currently-running initialization attempts. Resolved or
   * rejected entries are removed so a missing directory can be repaired by a
   * later call in the same process. */
  private static activeEnsures = new Map<string, Promise<string>>();

  /**
   * Absolute path to the shadow git directory for a given working directory.
   */
  static shadowPath(workingDirectory: string): string {
    return (
      this.repositoryContext(workingDirectory)?.shadow ??
      join(resolve(workingDirectory), '.koryphaios', 'shadow-git')
    );
  }

  static shadowObjectsPath(workingDirectory: string): string {
    return join(this.shadowPath(workingDirectory), 'objects');
  }

  static mainObjectsPath(workingDirectory: string): string {
    const context = this.repositoryContext(workingDirectory);
    if (!context) throw new ShadowRepoError(`No Git repository found at ${workingDirectory}`);
    return context.mainObjects;
  }

  /** Main-repository commands can read a private checkpoint for one bounded
   * operation without permanently exposing shadow objects to normal Git. */
  static mainReadEnv(workingDirectory: string): Record<string, string> {
    const inherited = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [this.shadowObjectsPath(workingDirectory), inherited]
        .filter(Boolean)
        .join(delimiter),
    };
  }

  /**
   * Environment variables that route git commands to the shadow repo.
   * Pass this as `baseEnv` to `new GitExecutor(cwd, baseEnv)`.
   */
  static shadowEnv(workingDirectory: string): Record<string, string> {
    return {
      GIT_DIR: this.shadowPath(workingDirectory),
      GIT_WORK_TREE: workingDirectory,
    };
  }

  /**
   * Ensure the shadow repo exists and alternates are wired.
   * Called on every CheckpointStore construction.
   *
   * @returns The absolute path to the shadow git directory.
   */
  static async ensure(workingDirectory: string): Promise<string> {
    const key = resolve(this.shadowPath(workingDirectory));
    const active = this.activeEnsures.get(key);
    if (active) return active;

    const pending = this.ensureOnce(workingDirectory).finally(() => {
      if (this.activeEnsures.get(key) === pending) this.activeEnsures.delete(key);
    });
    this.activeEnsures.set(key, pending);
    return pending;
  }

  private static async ensureOnce(workingDirectory: string): Promise<string> {
    const context = this.repositoryContext(workingDirectory);
    if (!context) {
      throw new ShadowRepoError(`No Git repository found at ${workingDirectory}`);
    }

    return this.withExclusiveLock(
      workingDirectory,
      async () => {
        this.ensureReservedStoragePath(context);
        this.migrateLegacyStorage(context);
        const existed = existsSync(context.shadow);
        const marker = this.readStorageMarker(context);
        if (marker && !existed) {
          throw new ShadowRepoError(
            `Checkpoint history is missing at ${context.shadow}; storage was previously initialized. ` +
              `Restore the common Git directory from backup or remove ${context.marker} only after accepting history loss.`,
          );
        }

        const mainFormatResult = await new GitExecutor(workingDirectory).exec([
          'rev-parse',
          '--show-object-format',
        ]);
        const mainFormat = mainFormatResult.stdout.trim();
        if (!mainFormatResult.success || (mainFormat !== 'sha1' && mainFormat !== 'sha256')) {
          throw new ShadowRepoError(
            `Could not determine main repository object format: ${mainFormatResult.output}`,
          );
        }

        // Git explicitly documents re-running `git init` as safe. Doing it under
        // the repository lock also repairs interrupted initializations without
        // deleting any objects or refs that may already exist.
        const init = await new GitExecutor(workingDirectory).execCombined([
          'init',
          '--bare',
          `--object-format=${mainFormat}`,
          context.shadow,
        ]);
        if (!init.success) {
          throw new ShadowRepoError(
            `Could not initialize shadow repository at ${context.shadow}: ${init.output}`,
          );
        }

        // Validate the repository itself without GIT_WORK_TREE. Supplying a
        // work tree intentionally makes `--is-bare-repository` report false,
        // even when GIT_DIR points at a valid bare repository.
        const shadowGit = new GitExecutor(workingDirectory, { GIT_DIR: context.shadow });
        const validation = await shadowGit.exec(['rev-parse', '--is-bare-repository']);
        if (!validation.success || validation.stdout.trim() !== 'true') {
          throw new ShadowRepoError(
            `Shadow repository validation failed at ${context.shadow}: ${validation.output}`,
          );
        }

        const shadowFormat = await shadowGit.exec(['rev-parse', '--show-object-format']);
        if (!shadowFormat.success || shadowFormat.stdout.trim() !== mainFormat) {
          throw new ShadowRepoError(
            `Shadow repository object format does not match main repository (${shadowFormat.stdout.trim() || 'unknown'} != ${mainFormat})`,
          );
        }

        for (const [key, value] of [
          ['core.fsync', 'all'],
          ['core.fsyncMethod', 'fsync'],
        ] as const) {
          const configured = await shadowGit.exec(['config', key, value]);
          if (!configured.success) {
            throw new ShadowRepoError(
              `Could not harden shadow repository writes: ${configured.output}`,
            );
          }
        }

        this.writeShadowAlternate(context);
        await this.migrateFromMainRepo(workingDirectory);
        if (!marker || marker.version !== SHADOW_STORAGE_VERSION) {
          await this.bootstrapStandaloneStorage(workingDirectory, context);
          this.writeStorageMarker(context, {
            version: SHADOW_STORAGE_VERSION,
            objectFormat: mainFormat,
            shadowPath: context.shadow,
            initializedAt: new Date().toISOString(),
          });
        } else if (marker.objectFormat !== mainFormat || marker.shadowPath !== context.shadow) {
          throw new ShadowRepoError(`Checkpoint storage marker does not match ${context.shadow}`);
        }
        this.removeManagedMainAlternates(context);

        if (!existed) {
          koryLog.info({ shadow: context.shadow }, 'ShadowRepo: created shadow bare repo');
        }
        return context.shadow;
      },
      'shadow initialization and migration',
    );
  }

  /** Serialize multi-command shadow transactions across every
   * CheckpointStore instance and every Koryphaios process sharing the Git
   * repository. The lock lives in the common Git directory, so linked
   * worktrees coordinate with the primary checkout too. */
  static async withExclusiveLock<T>(
    workingDirectory: string,
    action: () => Promise<T>,
    purpose = 'checkpoint transaction',
  ): Promise<T> {
    const context = this.repositoryContext(workingDirectory);
    if (!context) {
      throw new ShadowRepoError(`No Git repository found at ${workingDirectory}`);
    }
    const lockRoot = join(context.commonGitDir, LOCK_DIRECTORY_NAME);
    if (existsSync(lockRoot)) {
      const lockRootStat = lstatSync(lockRoot);
      if (lockRootStat.isSymbolicLink() || !lockRootStat.isDirectory()) {
        throw new ShadowRepoError(`Unsafe checkpoint lock directory: ${lockRoot}`);
      }
    } else {
      mkdirSync(lockRoot, { mode: 0o700 });
    }
    const lockPath = join(lockRoot, LOCK_NAME);
    const release = await this.acquireDirectoryLock(lockPath, purpose);
    try {
      return await action();
    } finally {
      release();
    }
  }

  /**
   * Run `git gc --prune=now` in the shadow repo to clean unreachable objects
   * after checkpoint refs have been pruned.
   */
  static async gc(
    workingDirectory: string,
    options: { exclusiveLockHeld?: boolean } = {},
  ): Promise<void> {
    const run = async () => {
      const shadow = this.shadowPath(workingDirectory);
      if (!existsSync(shadow)) return;
      const git = new GitExecutor(workingDirectory, this.shadowEnv(workingDirectory));
      const result = await git.exec(['gc', '--prune=now'], { timeoutMs: 60_000 });
      if (!result.success) {
        throw new ShadowRepoError(`Shadow repository GC failed: ${result.output}`);
      }
    };

    if (options.exclusiveLockHeld) {
      await run();
    } else {
      await this.ensure(workingDirectory);
      await this.withExclusiveLock(workingDirectory, run, 'shadow garbage collection');
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Find the main `.git` directory for a working directory.
   * Handles both `.git/` (normal repo) and `.git` file (worktree).
   */
  private static repositoryContext(workingDirectory: string): RepositoryContext | null {
    const root = resolve(workingDirectory);
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    let gitDir = dotGit;
    try {
      const stat = statSync(dotGit);
      if (stat.isFile()) {
        const content = readFileSync(dotGit, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return null;
        gitDir = resolve(workingDirectory, match[1].trim());
      }
    } catch {
      return null;
    }

    // Linked worktrees point at `.git/worktrees/<name>`. Their `commondir`
    // file identifies the shared repository directory whose object database
    // Git actually uses.
    let commonGitDir = gitDir;
    const commonDirFile = join(gitDir, 'commondir');
    if (existsSync(commonDirFile)) {
      try {
        const pointer = readFileSync(commonDirFile, 'utf-8').trim();
        if (pointer) commonGitDir = resolve(gitDir, pointer);
      } catch {
        return null;
      }
    }

    try {
      commonGitDir = realpathSync(commonGitDir);
      gitDir = realpathSync(gitDir);
    } catch {
      return null;
    }

    const storageRoot = join(commonGitDir, SHADOW_STORAGE_DIRECTORY);
    const mainWorktreeLegacy = join(dirname(commonGitDir), '.koryphaios', 'shadow-git');
    const currentWorktreeLegacy = join(root, '.koryphaios', 'shadow-git');

    return {
      gitDir,
      commonGitDir,
      mainObjects: join(commonGitDir, 'objects'),
      storageRoot,
      shadow: join(storageRoot, 'shadow-git'),
      legacyShadows: [...new Set([mainWorktreeLegacy, currentWorktreeLegacy])],
      marker: join(storageRoot, SHADOW_STORAGE_MARKER),
    };
  }

  /** Write the one managed shadow → main alternate. Moving a legacy
   * worktree-local shadow changes the base directory used to resolve relative
   * entries, so stale Kory spellings must be replaced rather than appended. */
  private static writeShadowAlternate(context: RepositoryContext): void {
    const shadowObjects = join(context.shadow, 'objects');
    const shadowObjectsInfo = join(shadowObjects, 'info');
    const shadowAlternates = join(shadowObjectsInfo, 'alternates');

    if (!existsSync(shadowObjectsInfo)) mkdirSync(shadowObjectsInfo, { recursive: true });

    const desired = relative(shadowObjects, context.mainObjects).replaceAll('\\', '/');
    const legacyManaged = new Set(
      context.legacyShadows.map((legacy) =>
        relative(join(legacy, 'objects'), context.mainObjects).replaceAll('\\', '/'),
      ),
    );
    const existing = existsSync(shadowAlternates)
      ? readFileSync(shadowAlternates, 'utf-8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    const retained = existing.filter((entry) => {
      if (entry === desired || legacyManaged.has(entry)) return false;
      // Older builds sometimes persisted the same managed target absolutely.
      return resolve(shadowObjects, entry) !== resolve(context.mainObjects);
    });
    this.atomicWrite(shadowAlternates, `${[...retained, desired].join('\n')}\n`);
  }

  /** Remove only alternates written by older Koryphaios versions. Other
   * operator-managed alternates are preserved line-for-line. */
  private static removeManagedMainAlternates(context: RepositoryContext): void {
    const alternates = join(context.mainObjects, 'info', 'alternates');
    if (!existsSync(alternates)) return;
    const content = readFileSync(alternates, 'utf-8');
    const hadTrailingNewline = content.endsWith('\n');
    const managedTargets = new Set([
      resolve(join(context.shadow, 'objects')),
      ...context.legacyShadows.map((legacy) => resolve(join(legacy, 'objects'))),
    ]);
    const lines = content.split('\n');
    if (hadTrailingNewline) lines.pop();
    const retained = lines.filter((line) => {
      const candidate = line.trim();
      if (!candidate) return true;
      return !managedTargets.has(resolve(context.mainObjects, candidate));
    });
    if (retained.length === lines.length) return;
    this.atomicWrite(alternates, `${retained.join('\n')}${hadTrailingNewline ? '\n' : ''}`);
  }

  private static ensureReservedStoragePath(context: RepositoryContext): void {
    try {
      if (existsSync(context.storageRoot)) {
        const storageStat = lstatSync(context.storageRoot);
        if (storageStat.isSymbolicLink() || !storageStat.isDirectory()) {
          throw new ShadowRepoError(
            `Reserved checkpoint storage path is not a real directory: ${context.storageRoot}`,
          );
        }
      } else {
        mkdirSync(context.storageRoot, { mode: 0o700 });
      }

      if (existsSync(context.shadow)) {
        const shadowStat = lstatSync(context.shadow);
        if (shadowStat.isSymbolicLink() || (!shadowStat.isDirectory() && !shadowStat.isFile())) {
          throw new ShadowRepoError(`Unsafe shadow repository path: ${context.shadow}`);
        }
      }
      if (existsSync(context.marker) && lstatSync(context.marker).isSymbolicLink()) {
        throw new ShadowRepoError(`Unsafe checkpoint storage marker: ${context.marker}`);
      }
    } catch (error) {
      if (error instanceof ShadowRepoError) throw error;
      throw new ShadowRepoError(`Could not validate checkpoint storage path: ${String(error)}`);
    }
  }

  /** Move the pre-v2 worktree-local shadow repository into the common Git
   * directory. This makes checkpoints survive removal of a linked worktree. */
  private static migrateLegacyStorage(context: RepositoryContext): void {
    const legacy = context.legacyShadows.filter((candidate) => {
      if (!existsSync(candidate)) return false;
      const candidateStat = lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new ShadowRepoError(`Refusing symlinked legacy checkpoint storage: ${candidate}`);
      }
      if (!candidateStat.isDirectory()) {
        throw new ShadowRepoError(`Legacy checkpoint storage is not a directory: ${candidate}`);
      }
      return true;
    });
    if (legacy.length === 0) return;
    if (existsSync(context.shadow)) {
      throw new ShadowRepoError(
        `Both canonical and legacy checkpoint stores exist; preserve both and reconcile manually: ${context.shadow}, ${legacy.join(', ')}`,
      );
    }
    if (legacy.length > 1) {
      throw new ShadowRepoError(
        `Multiple worktree-local checkpoint stores need manual reconciliation: ${legacy.join(', ')}`,
      );
    }
    renameSync(legacy[0], context.shadow);
    koryLog.info(
      { from: legacy[0], to: context.shadow },
      'ShadowRepo: moved checkpoint storage into common Git directory',
    );
  }

  private static readStorageMarker(context: RepositoryContext): ShadowStorageMarker | null {
    if (!existsSync(context.marker)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(context.marker, 'utf-8'),
      ) as Partial<ShadowStorageMarker>;
      if (
        parsed.version !== SHADOW_STORAGE_VERSION ||
        (parsed.objectFormat !== 'sha1' && parsed.objectFormat !== 'sha256') ||
        typeof parsed.shadowPath !== 'string' ||
        typeof parsed.initializedAt !== 'string'
      ) {
        throw new Error('invalid marker schema');
      }
      return parsed as ShadowStorageMarker;
    } catch (error) {
      throw new ShadowRepoError(`Checkpoint storage marker is corrupt: ${String(error)}`);
    }
  }

  private static writeStorageMarker(context: RepositoryContext, marker: ShadowStorageMarker): void {
    this.atomicWriteFsync(context.marker, `${JSON.stringify(marker, null, 2)}\n`);
  }

  /** Existing alternate-backed checkpoints predate standalone publication.
   * Internalize and physically verify every reachable object exactly once
   * before recording the v2 durability marker. */
  private static async bootstrapStandaloneStorage(
    workingDirectory: string,
    context: RepositoryContext,
  ): Promise<void> {
    const shadowGit = new GitExecutor(workingDirectory, { GIT_DIR: context.shadow });
    const refs = await shadowGit.exec(['for-each-ref', '--format=%(objectname)']);
    if (!refs.success) {
      throw new ShadowRepoError(`Could not inspect existing checkpoint refs: ${refs.output}`);
    }
    if (refs.stdout.trim()) {
      const repack = await shadowGit.exec(['repack', '-a', '-d'], { timeoutMs: 120_000 });
      if (!repack.success) {
        throw new ShadowRepoError(`Could not internalize existing checkpoints: ${repack.output}`);
      }
      await this.verifyPhysicalReachability(workingDirectory, context);
    }
  }

  private static async verifyPhysicalReachability(
    workingDirectory: string,
    context: RepositoryContext,
  ): Promise<void> {
    const shadowGit = new GitExecutor(workingDirectory, { GIT_DIR: context.shadow });
    const reachable = await shadowGit.exec(
      ['rev-list', '--objects', '--no-object-names', '--all'],
      { timeoutMs: 120_000 },
    );
    if (!reachable.success) {
      throw new ShadowRepoError(`Checkpoint object graph is incomplete: ${reachable.output}`);
    }
    const expected = new Set(
      reachable.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (expected.size === 0) return;

    const physical = new Set<string>();
    const objects = join(context.shadow, 'objects');
    for (const prefix of readdirSync(objects, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/i.test(prefix.name)) continue;
      for (const object of readdirSync(join(objects, prefix.name), { withFileTypes: true })) {
        if (object.isFile() && /^[0-9a-f]+$/i.test(object.name)) {
          physical.add(`${prefix.name}${object.name}`.toLowerCase());
        }
      }
    }

    const packDirectory = join(objects, 'pack');
    if (existsSync(packDirectory)) {
      for (const entry of readdirSync(packDirectory)) {
        if (!entry.endsWith('.idx')) continue;
        const verified = await shadowGit.exec(['verify-pack', '-v', join(packDirectory, entry)], {
          timeoutMs: 120_000,
        });
        if (!verified.success) {
          throw new ShadowRepoError(
            `Checkpoint pack verification failed for ${entry}: ${verified.output}`,
          );
        }
        for (const line of verified.stdout.split('\n')) {
          const objectName = line.trim().split(/\s+/, 1)[0];
          if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(objectName)) {
            physical.add(objectName.toLowerCase());
          }
        }
      }
    }

    const missing = [...expected].filter((objectName) => !physical.has(objectName.toLowerCase()));
    if (missing.length > 0) {
      throw new ShadowRepoError(
        `Checkpoint storage still borrows ${missing.length} object(s) from the main repository (first: ${missing[0]})`,
      );
    }
  }

  private static atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private static atomicWriteFsync(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
      const parent = openSync(dirname(path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  /** Create and install a verified non-thin pack for a new root snapshot
   * before any public ref can point at it. Existing durable snapshots are
   * exclusions so unchanged objects are not repeatedly packed. Must be called
   * while holding the common repository lock. */
  static async internalizeSnapshot(
    workingDirectory: string,
    root: string,
    durableRoots: string[],
  ): Promise<void> {
    const context = this.repositoryContext(workingDirectory);
    if (!context) throw new ShadowRepoError(`No Git repository found at ${workingDirectory}`);
    const shadowGit = new GitExecutor(workingDirectory, { GIT_DIR: context.shadow });
    const revisions = `${[root, ...durableRoots.map((hash) => `^${hash}`)].join('\n')}\n`;
    const expectedResult = await shadowGit.exec(
      ['rev-list', '--objects', '--no-object-names', '--stdin'],
      { stdin: revisions, timeoutMs: 120_000 },
    );
    if (!expectedResult.success) {
      throw new ShadowRepoError(
        `Could not enumerate checkpoint snapshot closure: ${expectedResult.output}`,
      );
    }
    const expected = new Set(
      expectedResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (expected.size === 0) {
      throw new ShadowRepoError('New checkpoint snapshot produced an empty object closure');
    }

    const temporaryRoot = join(context.storageRoot, 'tmp', 'packs');
    mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(temporaryRoot, 'pending-'));
    const base = join(temporary, 'pack');
    try {
      const packed = await shadowGit.exec(
        ['pack-objects', '--revs', '--non-empty', '--missing=error', '--delta-base-offset', base],
        { stdin: revisions, timeoutMs: 120_000 },
      );
      const packHash = packed.stdout.trim();
      if (!packed.success || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(packHash)) {
        throw new ShadowRepoError(`Could not pack checkpoint snapshot: ${packed.output}`);
      }
      const sourcePack = `${base}-${packHash}.pack`;
      const sourceIndex = `${base}-${packHash}.idx`;
      if (!existsSync(sourcePack) || !existsSync(sourceIndex)) {
        throw new ShadowRepoError('Checkpoint pack command did not produce a pack and index');
      }
      const verified = await shadowGit.exec(['verify-pack', '-v', sourceIndex], {
        timeoutMs: 120_000,
      });
      if (!verified.success) {
        throw new ShadowRepoError(`Checkpoint pack verification failed: ${verified.output}`);
      }
      const packedObjects = new Set<string>();
      for (const line of verified.stdout.split('\n')) {
        const objectName = line.trim().split(/\s+/, 1)[0];
        if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(objectName)) {
          packedObjects.add(objectName.toLowerCase());
        }
      }
      const missing = [...expected].filter(
        (objectName) => !packedObjects.has(objectName.toLowerCase()),
      );
      if (missing.length > 0) {
        throw new ShadowRepoError(
          `Verified checkpoint pack omitted ${missing.length} object(s) (first: ${missing[0]})`,
        );
      }

      const destination = join(context.shadow, 'objects', 'pack');
      mkdirSync(destination, { recursive: true });
      const destinationPack = join(destination, `pack-${packHash}.pack`);
      const destinationIndex = join(destination, `pack-${packHash}.idx`);
      if (!existsSync(destinationPack)) renameSync(sourcePack, destinationPack);
      if (!existsSync(destinationIndex)) renameSync(sourceIndex, destinationIndex);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  /** Copy a complete standalone snapshot into the main object database before
   * a normal branch is allowed to reference it. This prevents later shadow
   * pruning from invalidating a user-visible branch. Must run under the common
   * repository lock. */
  static async materializeSnapshotInMain(workingDirectory: string, root: string): Promise<void> {
    const context = this.repositoryContext(workingDirectory);
    if (!context) throw new ShadowRepoError(`No Git repository found at ${workingDirectory}`);
    const shadowGit = new GitExecutor(workingDirectory, { GIT_DIR: context.shadow });
    const revisions = `${root}\n`;
    const expectedResult = await shadowGit.exec(
      ['rev-list', '--objects', '--no-object-names', '--stdin'],
      { stdin: revisions, timeoutMs: 120_000 },
    );
    if (!expectedResult.success) {
      throw new ShadowRepoError(
        `Could not enumerate branch snapshot closure: ${expectedResult.output}`,
      );
    }
    const expected = new Set(
      expectedResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );

    const temporaryRoot = join(context.storageRoot, 'tmp', 'exports');
    mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(temporaryRoot, 'branch-'));
    const base = join(temporary, 'pack');
    try {
      const packed = await shadowGit.exec(
        ['pack-objects', '--revs', '--non-empty', '--missing=error', '--delta-base-offset', base],
        { stdin: revisions, timeoutMs: 120_000 },
      );
      const packHash = packed.stdout.trim();
      if (!packed.success || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(packHash)) {
        throw new ShadowRepoError(`Could not pack branch snapshot: ${packed.output}`);
      }
      const sourcePack = `${base}-${packHash}.pack`;
      const sourceIndex = `${base}-${packHash}.idx`;
      const verified = await shadowGit.exec(['verify-pack', '-v', sourceIndex], {
        timeoutMs: 120_000,
      });
      if (!verified.success) {
        throw new ShadowRepoError(`Branch snapshot pack verification failed: ${verified.output}`);
      }
      const packedObjects = new Set<string>();
      for (const line of verified.stdout.split('\n')) {
        const objectName = line.trim().split(/\s+/, 1)[0];
        if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(objectName)) {
          packedObjects.add(objectName.toLowerCase());
        }
      }
      const missing = [...expected].filter(
        (objectName) => !packedObjects.has(objectName.toLowerCase()),
      );
      if (missing.length > 0) {
        throw new ShadowRepoError(`Branch pack omitted ${missing.length} required object(s)`);
      }

      const destination = join(context.mainObjects, 'pack');
      mkdirSync(destination, { recursive: true });
      const destinationPack = join(destination, `pack-${packHash}.pack`);
      const destinationIndex = join(destination, `pack-${packHash}.idx`);
      if (!existsSync(destinationPack)) renameSync(sourcePack, destinationPack);
      if (!existsSync(destinationIndex)) renameSync(sourceIndex, destinationIndex);

      const mainGit = new GitExecutor(workingDirectory);
      const proof = await mainGit.exec(['cat-file', '-e', `${root}^{commit}`]);
      if (!proof.success) {
        throw new ShadowRepoError(
          `Main repository could not read materialized branch snapshot: ${proof.output}`,
        );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  /**
   * One-time migration: move legacy ghost refs from the main repo to the shadow repo.
   * Idempotent — safe to call on every startup (no-ops if already migrated).
   */
  private static async migrateFromMainRepo(workingDirectory: string): Promise<void> {
    const mainExecutor = new GitExecutor(workingDirectory);
    const shadowExecutor = new GitExecutor(workingDirectory, {
      GIT_DIR: this.shadowPath(workingDirectory),
    });

    let migrated = 0;
    const copied: Array<{ refName: string; objectName: string }> = [];

    for (const refPrefix of SHADOW_REF_PREFIXES) {
      // List all refs under this prefix in the main repo.
      const listResult = await mainExecutor.execCombined([
        'for-each-ref',
        '--format=%(refname)|%(objectname)',
        refPrefix,
      ]);
      if (!listResult.success || !listResult.output.trim()) continue;

      for (const line of listResult.output.split('\n').filter(Boolean)) {
        const [refName, objectName] = line.split('|');
        if (!refName || !objectName) continue;

        const currentShadow = await shadowExecutor.execCombined(['rev-parse', '--verify', refName]);
        if (currentShadow.success && currentShadow.output.trim() !== objectName) {
          // Never overwrite either side of a migration conflict. Leaving the
          // main ref in place is noisy but recoverable and avoids data loss.
          koryLog.error(
            { refName, mainObject: objectName, shadowObject: currentShadow.output.trim() },
            'ShadowRepo: migration conflict; preserved both refs',
          );
          continue;
        }

        if (!currentShadow.success) {
          // Empty old value means "the ref must not exist", preventing a
          // concurrent creator from being overwritten.
          const copyResult = await shadowExecutor.execCombined([
            'update-ref',
            refName,
            objectName,
            '',
          ]);
          if (!copyResult.success) {
            koryLog.warn(
              { refName, ...shadowGitLogMetadata('update-ref-copy', copyResult) },
              'ShadowRepo: failed to copy ref to shadow',
            );
            continue;
          }
        }

        const verified = await shadowExecutor.execCombined(['rev-parse', '--verify', refName]);
        if (!verified.success || verified.output.trim() !== objectName) {
          koryLog.error(
            { refName },
            'ShadowRepo: copied ref could not be verified; main ref preserved',
          );
          continue;
        }
        copied.push({ refName, objectName });
      }
    }

    if (copied.length === 0) return;

    // A ref copied through alternates does not itself copy the object graph.
    // Internalize every object reachable from the shadow refs before deleting
    // the main refs; otherwise a later main-repo `git gc --prune=now` can
    // destroy the only physical copy of a migrated checkpoint.
    const repack = await shadowExecutor.exec(['repack', '-a', '-d'], { timeoutMs: 60_000 });
    if (!repack.success) {
      throw new ShadowRepoError(
        `Could not internalize migrated checkpoint objects; main refs were preserved: ${repack.output}`,
      );
    }

    for (const { refName, objectName } of copied) {
      // Delete only if the main ref still has the object we copied.
      const deleted = await mainExecutor.execCombined(['update-ref', '-d', refName, objectName]);
      if (deleted.success) migrated++;
    }

    if (migrated > 0) {
      koryLog.info({ migrated }, 'ShadowRepo: migrated legacy ghost refs to shadow repo');
    }
  }

  private static async acquireDirectoryLock(
    lockPath: string,
    purpose: string,
  ): Promise<() => void> {
    const owner = this.createLockOwner(purpose);
    const startedAt = Date.now();

    while (true) {
      let created = false;
      try {
        mkdirSync(lockPath);
        created = true;
        writeFileSync(join(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
          flag: 'wx',
          mode: 0o600,
        });
        return () => this.releaseDirectoryLock(lockPath, owner);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (created) {
          rmSync(lockPath, { recursive: true, force: true });
          throw new ShadowRepoError(
            `Could not write shadow repository lock owner: ${String(error)}`,
          );
        }
        if (code !== 'EEXIST') {
          throw new ShadowRepoError(`Could not acquire shadow repository lock: ${String(error)}`);
        }
      }

      if (this.reapStaleLock(lockPath)) continue;

      if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
        const currentOwner = this.readLockOwner(lockPath);
        throw new ShadowRepoError(
          currentOwner
            ? `Timed out waiting for shadow repository lock held by PID ${currentOwner.pid} on ${currentOwner.hostname} for ${currentOwner.purpose} since ${new Date(currentOwner.createdAt).toISOString()}`
            : 'Timed out waiting for shadow repository lock with unreadable owner metadata',
        );
      }
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
    }
  }

  private static releaseDirectoryLock(lockPath: string, owner: LockOwner): void {
    try {
      const current = this.readLockOwner(lockPath);
      if (current?.token !== owner.token) return;
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best-effort during shutdown. A stale lock is recoverable by the next
      // process because its owner PID will no longer be alive.
    }
  }

  private static isStaleLock(lockPath: string): boolean {
    let ageMs: number;
    try {
      const lockStat = lstatSync(lockPath);
      if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return false;
      ageMs = Date.now() - lockStat.mtimeMs;
    } catch {
      return false;
    }

    const owner = this.readLockOwner(lockPath);
    if (!owner) return ageMs >= OWNER_WRITE_GRACE_MS;
    if (owner.hostname !== hostname()) return false;
    if (!this.isProcessAlive(owner.pid)) return true;
    const currentIdentity = this.processIdentity(owner.pid);
    return Boolean(
      owner.processIdentity && currentIdentity && owner.processIdentity !== currentIdentity,
    );
  }

  private static reapStaleLock(lockPath: string): boolean {
    const reaperPath = `${lockPath}.reaper`;
    const reaperOwner = this.tryAcquireReaperLease(reaperPath);
    if (!reaperOwner) return false;

    try {
      const before = this.snapshotLock(lockPath);
      if (!before || !this.isStaleLock(lockPath)) return false;
      const current = this.snapshotLock(lockPath);
      if (!current || !this.sameLockSnapshot(before, current) || !this.isStaleLock(lockPath)) {
        return false;
      }
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    } finally {
      this.releaseDirectoryLock(reaperPath, reaperOwner);
    }
  }

  /** Acquire the short recovery lease used to remove a stale main lock. The
   * lease is itself recoverable: a process may die after mkdir, after writing
   * its owner, or after deleting the target lock without wedging later
   * checkpoint operations for the full lock timeout. */
  private static tryAcquireReaperLease(reaperPath: string): LockOwner | null {
    const owner = this.createLockOwner('reap stale shadow repository lock');
    let created = false;
    try {
      mkdirSync(reaperPath);
      created = true;
      writeFileSync(join(reaperPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
        flag: 'wx',
        mode: 0o600,
      });
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (created) {
        rmSync(reaperPath, { recursive: true, force: true });
        throw new ShadowRepoError(`Could not write shadow lock reaper owner: ${String(error)}`);
      }
      if (code !== 'EEXIST') {
        throw new ShadowRepoError(`Could not acquire shadow lock reaper: ${String(error)}`);
      }
    }

    this.reapAbandonedLease(reaperPath);
    return null;
  }

  /** Atomically quarantine exactly the stale lease inode that was inspected.
   * The post-rename identity check prevents deleting a newly-created lease if
   * another process released and replaced it during recovery. */
  private static reapAbandonedLease(lockPath: string): boolean {
    const before = this.snapshotLock(lockPath);
    if (!before || !this.isStaleLock(lockPath)) return false;
    const current = this.snapshotLock(lockPath);
    if (!current || !this.sameLockSnapshot(before, current) || !this.isStaleLock(lockPath)) {
      return false;
    }

    const quarantine = `${lockPath}.abandoned-${randomUUID()}`;
    try {
      renameSync(lockPath, quarantine);
    } catch {
      return false;
    }

    const moved = this.snapshotLock(quarantine);
    if (!moved || !this.sameLockSnapshot(before, moved)) {
      // Do not delete a lease that changed identity between validation and
      // rename. Restore it when possible; otherwise leave the quarantined
      // inode intact for operator inspection rather than destroying it.
      try {
        if (!existsSync(lockPath)) renameSync(quarantine, lockPath);
      } catch {
        // Fail closed. A later acquisition can recover the remaining lease.
      }
      return false;
    }

    rmSync(quarantine, { recursive: true, force: true });
    return true;
  }

  private static snapshotLock(lockPath: string): LockSnapshot | null {
    try {
      const lockStat = lstatSync(lockPath);
      if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return null;
      return {
        device: lockStat.dev,
        inode: lockStat.ino,
        modifiedAt: lockStat.mtimeMs,
        ownerToken: this.readLockOwner(lockPath)?.token ?? null,
      };
    } catch {
      return null;
    }
  }

  private static sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
    return (
      left.device === right.device &&
      left.inode === right.inode &&
      left.modifiedAt === right.modifiedAt &&
      left.ownerToken === right.ownerToken
    );
  }

  private static createLockOwner(purpose: string): LockOwner {
    return {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
      purpose,
      processIdentity: this.processIdentity(process.pid),
    };
  }

  private static readLockOwner(lockPath: string): LockOwner | null {
    try {
      const parsed = JSON.parse(
        readFileSync(join(lockPath, LOCK_OWNER_FILE), 'utf-8'),
      ) as Partial<LockOwner>;
      if (
        typeof parsed.token !== 'string' ||
        typeof parsed.pid !== 'number' ||
        typeof parsed.hostname !== 'string' ||
        typeof parsed.createdAt !== 'number' ||
        typeof parsed.purpose !== 'string'
      )
        return null;
      return parsed as LockOwner;
    } catch {
      return null;
    }
  }

  private static isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private static processIdentity(pid: number): string | undefined {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      // Fields after the command name start at proc field 3. Start time is
      // field 22, therefore offset 19 in this suffix.
      const fields = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux-proc-start:${fields[19]}` : undefined;
    } catch {
      return undefined;
    }
  }
}

export class ShadowRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowRepoError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
