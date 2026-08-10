import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { koryLog } from '../logger';

interface SnapshotManifest {
  version: 1;
  timestamp: number;
  files: string[];
}

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const RESERVED_PROJECT_PATHS = new Set(['.git', '.koryphaios']);

export class SnapshotManager {
  private readonly workingDirectory: string;
  private readonly baseDir: string;

  constructor(workingDirectory: string) {
    const requested = resolve(workingDirectory);
    if (!existsSync(requested) || !lstatSync(requested).isDirectory()) {
      throw new Error(`Snapshot project directory is unavailable: ${requested}`);
    }
    this.workingDirectory = realpathSync(requested);

    const koryDirectory = join(this.workingDirectory, '.koryphaios');
    this.ensureOwnedDirectory(koryDirectory, '.koryphaios');
    this.baseDir = join(koryDirectory, 'snapshots');
    this.ensureOwnedDirectory(this.baseDir, 'snapshot storage');

    const canonicalBase = realpathSync(this.baseDir);
    if (!this.isWithin(this.workingDirectory, canonicalBase)) {
      throw new Error('Snapshot storage escaped the project directory');
    }
  }

  /**
   * Create a snapshot of exact files before they are modified. Directories,
   * symlinks, repository metadata, and paths outside the project are rejected.
   */
  async createSnapshot(
    sessionId: string,
    snapshotId: string,
    filePaths: string[],
    workingDirectory: string,
  ): Promise<void> {
    this.assertProject(workingDirectory);
    const snapshotDir = this.snapshotDirectory(sessionId, snapshotId);
    const sessionDir = dirname(snapshotDir);
    this.ensureOwnedDirectory(sessionDir, 'snapshot session directory');

    const temporary = join(sessionDir, `.${snapshotId}.${randomUUID()}.tmp`);
    this.assertWithin(this.baseDir, temporary, 'temporary snapshot directory');
    mkdirSync(temporary, { recursive: false });

    const files: string[] = [];
    try {
      for (const filePath of filePaths) {
        const source = this.resolveProjectFile(filePath, true);
        const destination = this.resolveSnapshotFile(temporary, source.manifestPath, false);
        mkdirSync(dirname(destination), { recursive: true });
        await Bun.write(destination, Bun.file(source.absolutePath));
        files.push(source.manifestPath);
      }

      const manifest: SnapshotManifest = {
        version: 1,
        timestamp: Date.now(),
        files: [...new Set(files)].sort(),
      };
      await Bun.write(join(temporary, 'manifest.json'), JSON.stringify(manifest));

      if (existsSync(snapshotDir)) {
        const info = lstatSync(snapshotDir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('Existing snapshot target is not an owned directory');
        }
        this.assertWithin(this.baseDir, realpathSync(snapshotDir), 'existing snapshot');
        rmSync(snapshotDir, { recursive: true, force: true });
      }
      renameSync(temporary, snapshotDir);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }

    koryLog.info({ sessionId, snapshotId, files: files.length }, 'Created file snapshot');
  }

  /** Restore every exact file recorded by the immutable snapshot manifest. */
  async restoreSnapshot(
    sessionId: string,
    snapshotId: string,
    workingDirectory: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.assertProject(workingDirectory);
      const snapshotDir = this.requireSnapshotDirectory(sessionId, snapshotId);
      const manifest = this.readManifest(snapshotDir);
      const result = await this.restoreManifestFiles(snapshotDir, manifest.files);
      if (!result.success) return { success: false, error: result.error };
      if (result.missing.length > 0) {
        return {
          success: false,
          error: `Snapshot is incomplete; missing ${result.missing.join(', ')}`,
        };
      }
      koryLog.info({ sessionId, snapshotId }, 'Restored snapshot');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Restore only exact project-relative files that also exist in the manifest. */
  async restoreFiles(
    sessionId: string,
    snapshotId: string,
    workingDirectory: string,
    filePaths: string[],
  ): Promise<{ success: boolean; restored: string[]; missing: string[]; error?: string }> {
    try {
      this.assertProject(workingDirectory);
      const snapshotDir = this.requireSnapshotDirectory(sessionId, snapshotId);
      const manifest = this.readManifest(snapshotDir);
      const manifestFiles = new Set(manifest.files);
      const requested = filePaths.map(
        (filePath) => this.resolveProjectFile(filePath, false).manifestPath,
      );
      const absent = requested.filter((filePath) => !manifestFiles.has(filePath));
      const present = requested.filter((filePath) => manifestFiles.has(filePath));
      const result = await this.restoreManifestFiles(snapshotDir, present);
      return {
        ...result,
        missing: [...new Set([...absent, ...result.missing])],
      };
    } catch (error) {
      return {
        success: false,
        restored: [],
        missing: filePaths,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Remove only the validated, project-owned snapshot namespace for a session. */
  prune(sessionId: string): void {
    const safeSessionId = this.safeId(sessionId, 'session');
    const sessionDir = join(this.baseDir, safeSessionId);
    this.assertWithin(this.baseDir, sessionDir, 'snapshot session directory');
    if (!existsSync(sessionDir)) return;
    const info = lstatSync(sessionDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Snapshot session path is not an owned directory');
    }
    this.assertWithin(this.baseDir, realpathSync(sessionDir), 'snapshot session directory');
    rmSync(sessionDir, { recursive: true, force: true });
  }

  private async restoreManifestFiles(
    snapshotDir: string,
    files: string[],
  ): Promise<{ success: boolean; restored: string[]; missing: string[]; error?: string }> {
    const restored: string[] = [];
    const missing: string[] = [];
    try {
      for (const manifestPath of files) {
        const target = this.resolveManifestProjectFile(manifestPath);
        const backupPath = this.resolveSnapshotFile(snapshotDir, manifestPath, true);
        if (!existsSync(backupPath)) {
          missing.push(manifestPath);
          continue;
        }
        const backupInfo = lstatSync(backupPath);
        if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) {
          throw new Error(`Snapshot entry is not a regular file: ${manifestPath}`);
        }

        this.assertNoSymlinkAncestors(this.workingDirectory, dirname(target));
        mkdirSync(dirname(target), { recursive: true });
        this.assertNoSymlinkAncestors(this.workingDirectory, dirname(target));
        if (existsSync(target)) {
          const targetInfo = lstatSync(target);
          if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
            throw new Error(`Restore target is not a regular project file: ${manifestPath}`);
          }
        }
        await Bun.write(target, Bun.file(backupPath));
        restored.push(manifestPath);
      }
      return { success: true, restored, missing };
    } catch (error) {
      return {
        success: false,
        restored,
        missing,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readManifest(snapshotDir: string): SnapshotManifest {
    const manifestPath = join(snapshotDir, 'manifest.json');
    const info = lstatSync(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Snapshot manifest is not a regular file');
    }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<SnapshotManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
      throw new Error('Snapshot manifest is missing or unsupported');
    }
    const files = parsed.files.map((filePath) => {
      if (typeof filePath !== 'string')
        throw new Error('Snapshot manifest contains an invalid path');
      return this.normalizeManifestPath(filePath);
    });
    return { version: 1, timestamp: Number(parsed.timestamp) || 0, files: [...new Set(files)] };
  }

  private resolveProjectFile(
    filePath: string,
    mustExist: boolean,
  ): { absolutePath: string; manifestPath: string } {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Snapshot file path must be a non-empty string');
    }
    const absolutePath = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.workingDirectory, filePath);
    this.assertWithin(this.workingDirectory, absolutePath, 'snapshot project file');
    const manifestPath = this.normalizeManifestPath(
      relative(this.workingDirectory, absolutePath).split(sep).join('/'),
    );
    this.assertNoSymlinkAncestors(this.workingDirectory, absolutePath);
    if (mustExist) {
      if (!existsSync(absolutePath)) throw new Error(`Snapshot source is missing: ${manifestPath}`);
      const info = lstatSync(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Snapshot source is not a regular file: ${manifestPath}`);
      }
      this.assertWithin(this.workingDirectory, realpathSync(absolutePath), 'snapshot source');
    }
    return { absolutePath, manifestPath };
  }

  private resolveManifestProjectFile(manifestPath: string): string {
    const normalized = this.normalizeManifestPath(manifestPath);
    const target = resolve(this.workingDirectory, ...normalized.split('/'));
    this.assertWithin(this.workingDirectory, target, 'snapshot restore target');
    return target;
  }

  private resolveSnapshotFile(
    snapshotDir: string,
    manifestPath: string,
    requireExisting: boolean,
  ): string {
    const normalized = this.normalizeManifestPath(manifestPath);
    const candidate = resolve(snapshotDir, ...normalized.split('/'));
    this.assertWithin(snapshotDir, candidate, 'snapshot entry');
    this.assertNoSymlinkAncestors(snapshotDir, requireExisting ? candidate : dirname(candidate));
    return candidate;
  }

  private normalizeManifestPath(filePath: string): string {
    if (!filePath || filePath.includes('\\') || filePath.startsWith('/')) {
      throw new Error(`Invalid snapshot path: ${filePath}`);
    }
    const segments = filePath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Invalid snapshot path: ${filePath}`);
    }
    if (RESERVED_PROJECT_PATHS.has(segments[0])) {
      throw new Error(`Reserved project metadata cannot be snapshotted: ${filePath}`);
    }
    return segments.join('/');
  }

  private snapshotDirectory(sessionId: string, snapshotId: string): string {
    const directory = join(
      this.baseDir,
      this.safeId(sessionId, 'session'),
      this.safeId(snapshotId, 'snapshot'),
    );
    this.assertWithin(this.baseDir, directory, 'snapshot directory');
    return directory;
  }

  private requireSnapshotDirectory(sessionId: string, snapshotId: string): string {
    const directory = this.snapshotDirectory(sessionId, snapshotId);
    if (!existsSync(directory)) throw new Error('Snapshot not found');
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Snapshot path is not an owned directory');
    }
    this.assertWithin(this.baseDir, realpathSync(directory), 'snapshot directory');
    return directory;
  }

  private safeId(value: string, label: string): string {
    if (!SAFE_ID.test(value) || value === '.' || value === '..') {
      throw new Error(`Invalid snapshot ${label} id`);
    }
    return value;
  }

  private assertProject(workingDirectory: string): void {
    const canonical = realpathSync(resolve(workingDirectory));
    if (canonical !== this.workingDirectory) {
      throw new Error('Snapshot project does not match the manager project');
    }
  }

  private ensureOwnedDirectory(path: string, label: string): void {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label} is not an owned directory`);
      }
      return;
    }
    this.assertWithin(this.workingDirectory, path, label);
    mkdirSync(path, { recursive: false });
  }

  private assertNoSymlinkAncestors(root: string, candidate: string): void {
    this.assertWithin(root, candidate, 'snapshot path');
    const rel = relative(root, candidate);
    let current = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (!existsSync(current)) break;
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Snapshot path crosses a symbolic link: ${relative(root, current)}`);
      }
    }
  }

  private isWithin(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${sep}`);
  }

  private assertWithin(root: string, candidate: string, label: string): void {
    if (!this.isWithin(resolve(root), resolve(candidate))) {
      throw new Error(`${label} escaped its owned directory`);
    }
  }
}
