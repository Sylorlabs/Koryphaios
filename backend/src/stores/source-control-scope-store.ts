import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type {
  ProjectRootRef,
  RepositoryRef,
  RootAccess,
  SourceControlKind,
} from '@koryphaios/shared';

const KINDS = new Set<SourceControlKind>([
  'git',
  'mercurial',
  'perforce',
  'filesystem',
  'archive',
  'none',
]);
const ACCESS = new Set<RootAccess>([
  'read-write',
  'read-only',
  'excluded',
  'generated',
  'dependent',
  'publishable',
]);

type RepositoryRow = {
  id: string;
  kind: SourceControlKind;
  canonical_path: string;
  identity_key: string;
  remote: string | null;
};
type RootRow = {
  id: string;
  project_id: string;
  canonical_path: string;
  label: string;
  access: RootAccess;
  source_control_kind: SourceControlKind;
  repository_id: string | null;
};

function canonicalDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim()))
    throw new Error('Source-control root must be an absolute directory');
  const requested = resolve(value.trim());
  if (!existsSync(requested) || !statSync(requested).isDirectory())
    throw new Error('Source-control root is unavailable');
  return realpathSync(requested);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function assertKind(value: SourceControlKind): void {
  if (!KINDS.has(value)) throw new Error(`Unsupported source-control kind: ${value}`);
}

function assertAccess(value: RootAccess): void {
  if (!ACCESS.has(value)) throw new Error(`Unsupported root access: ${value}`);
}

export class SourceControlScopeStore {
  constructor(private readonly database: Database) {}

  getRepository(path: unknown, kind: SourceControlKind = 'git', remote?: string): RepositoryRef {
    assertKind(kind);
    const canonicalPath = canonicalDirectory(path);
    const existing = this.database
      .query<RepositoryRow, [string]>(
        `SELECT id, kind, canonical_path, identity_key, remote
         FROM source_control_repositories WHERE canonical_path = ?`,
      )
      .get(canonicalPath);
    if (existing) {
      if (existing.kind !== kind) throw new Error('Repository kind changed for an existing root');
      return this.toRepository(existing);
    }
    const now = Date.now();
    const identityKey = `${kind}:${canonicalPath}`;
    const id = stableId('repo', identityKey);
    this.database.run(
      `INSERT INTO source_control_repositories
       (id, kind, canonical_path, identity_key, remote, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, canonicalPath, identityKey, remote ?? null, now, now],
    );
    return { id, kind, canonicalPath, identityKey, ...(remote ? { remote } : {}) };
  }

  ensureRoot(
    projectId: string,
    path: unknown,
    options: {
      label?: string;
      access?: RootAccess;
      sourceControl?: SourceControlKind;
      repositoryPath?: unknown;
      remote?: string;
    } = {},
  ): ProjectRootRef {
    if (!projectId.trim()) throw new Error('Project ID is required');
    const canonicalPath = canonicalDirectory(path);
    const access = options.access ?? 'read-write';
    const sourceControl = options.sourceControl ?? 'git';
    assertAccess(access);
    assertKind(sourceControl);
    const existing = this.database
      .query<RootRow, [string, string]>(
        `SELECT id, project_id, canonical_path, label, access, source_control_kind, repository_id
         FROM project_roots WHERE project_id = ? AND canonical_path = ?`,
      )
      .get(projectId, canonicalPath);
    if (existing) {
      if (existing.source_control_kind !== sourceControl)
        throw new Error('Source-control kind changed for an existing root');
      if (existing.access !== access)
        throw new Error('Root access changed for an existing root; update it explicitly');
      return this.toRoot(existing);
    }
    const repository =
      sourceControl === 'none'
        ? undefined
        : this.getRepository(
            options.repositoryPath ?? canonicalPath,
            sourceControl,
            options.remote,
          );
    const id = stableId('root', `${projectId}:${canonicalPath}`);
    const label = (
      options.label?.trim() ||
      canonicalPath.split(/[\\/]/u).filter(Boolean).at(-1) ||
      'Root'
    ).slice(0, 120);
    const now = Date.now();
    this.database.run(
      `INSERT INTO project_roots
       (id, project_id, canonical_path, label, access, source_control_kind, repository_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        canonicalPath,
        label,
        access,
        sourceControl,
        repository?.id ?? null,
        now,
        now,
      ],
    );
    return {
      id,
      projectId,
      path: canonicalPath,
      label,
      access,
      sourceControl,
      ...(repository ? { repositoryId: repository.id } : {}),
    };
  }

  listRoots(projectId: string): ProjectRootRef[] {
    return this.database
      .query<RootRow, [string]>(
        `SELECT id, project_id, canonical_path, label, access, source_control_kind, repository_id
         FROM project_roots WHERE project_id = ? ORDER BY canonical_path`,
      )
      .all(projectId)
      .map((row) => this.toRoot(row));
  }

  private toRepository(row: RepositoryRow): RepositoryRef {
    return {
      id: row.id,
      kind: row.kind,
      canonicalPath: row.canonical_path,
      identityKey: row.identity_key,
      ...(row.remote ? { remote: row.remote } : {}),
    };
  }

  private toRoot(row: RootRow): ProjectRootRef {
    return {
      id: row.id,
      projectId: row.project_id,
      path: row.canonical_path,
      label: row.label,
      access: row.access,
      sourceControl: row.source_control_kind,
      ...(row.repository_id ? { repositoryId: row.repository_id } : {}),
    };
  }
}

export function createSourceControlScopeId(): string {
  return randomUUID();
}
