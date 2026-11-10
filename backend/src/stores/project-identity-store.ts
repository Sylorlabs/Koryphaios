import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  normalizeProjectIconSpec,
  type ProjectIconSpec,
  type ProjectIdentity,
} from '@koryphaios/shared';

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS project_identities (
    id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

export interface ProjectIdentityUpdate {
  name?: unknown;
  icon?: unknown;
  expectedRevision?: number;
}

export class ProjectIdentityConflictError extends Error {
  readonly code = 'PROJECT_IDENTITY_REVISION_CONFLICT';

  constructor(message = 'Project identity changed; reload before saving again') {
    super(message);
    this.name = 'ProjectIdentityConflictError';
  }
}

type IdentityRow = {
  id: string;
  identity_key: string;
  root_path: string;
  name: string;
  icon: string;
  revision: number;
  created_at: number;
  updated_at: number;
};

function canonicalProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    throw new Error('Project root must be an absolute path');
  }
  const requested = resolve(value.trim());
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error('Project root is unavailable');
  }
  return realpathSync(requested);
}

function displayName(value: unknown, fallbackPath: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length > 120) throw new Error('Project name is too long');
  return name || fallbackPath.split(/[\\/]/u).filter(Boolean).at(-1) || 'Project';
}

function identityId(identityKey: string): string {
  return `project_${createHash('sha256').update(identityKey).digest('hex').slice(0, 32)}`;
}

function parseIcon(value: string): ProjectIconSpec {
  try {
    return normalizeProjectIconSpec(JSON.parse(value));
  } catch {
    return { mode: 'automatic' };
  }
}

function rowToIdentity(row: IdentityRow): ProjectIdentity {
  const icon = parseIcon(row.icon);
  return {
    id: row.id,
    name: row.name,
    icon,
    ...(icon.mode === 'image' ? { assetUrl: `/api/workspace/project-icon/${icon.assetId}` } : {}),
  };
}

export class ProjectIdentityStore {
  constructor(private readonly database: Database) {
    // This keeps older test databases and installations that have not run the
    // latest migration readable while the normal startup migration remains the
    // schema authority.
    this.database.exec(TABLE_SQL);
  }

  private row(rootPath: string): IdentityRow | null {
    return this.database
      .query<IdentityRow, [string]>(
        `SELECT id, identity_key, root_path, name, icon, revision, created_at, updated_at
         FROM project_identities WHERE root_path = ?`,
      )
      .get(rootPath);
  }

  get(rootPath: unknown, fallbackName?: unknown): ProjectIdentity {
    const canonical = canonicalProjectPath(rootPath);
    const existing = this.row(canonical);
    if (existing) return rowToIdentity(existing);
    return this.create(canonical, fallbackName);
  }

  getWithRevision(
    rootPath: unknown,
    fallbackName?: unknown,
  ): ProjectIdentity & { revision: number } {
    const canonical = canonicalProjectPath(rootPath);
    const existing = this.row(canonical);
    if (existing) return { ...rowToIdentity(existing), revision: existing.revision };
    const created = this.create(canonical, fallbackName);
    return { ...created, revision: 1 };
  }

  list(rootPaths: readonly string[]): Record<string, ProjectIdentity> {
    const result: Record<string, ProjectIdentity> = {};
    for (const rootPath of rootPaths) {
      const canonical = canonicalProjectPath(rootPath);
      result[canonical] = this.get(canonical);
    }
    return result;
  }

  create(rootPath: unknown, fallbackName?: unknown): ProjectIdentity {
    const canonical = canonicalProjectPath(rootPath);
    const existing = this.row(canonical);
    if (existing) return rowToIdentity(existing);
    const now = Date.now();
    const identityKey = `path:${canonical}`;
    const identity: ProjectIdentity = {
      id: identityId(identityKey),
      name: displayName(fallbackName, canonical),
      icon: { mode: 'automatic' },
    };
    this.database.run(
      `INSERT INTO project_identities
       (id, identity_key, root_path, name, icon, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [identity.id, identityKey, canonical, identity.name, JSON.stringify(identity.icon), now, now],
    );
    return identity;
  }

  update(rootPath: unknown, patch: ProjectIdentityUpdate): ProjectIdentity & { revision: number } {
    const canonical = canonicalProjectPath(rootPath);
    const current =
      this.row(canonical) ??
      (() => {
        this.create(canonical);
        return this.row(canonical)!;
      })();
    if (
      patch.expectedRevision !== undefined &&
      (!Number.isInteger(patch.expectedRevision) || patch.expectedRevision !== current.revision)
    ) {
      throw new ProjectIdentityConflictError();
    }
    const name = patch.name === undefined ? current.name : displayName(patch.name, canonical);
    const icon =
      patch.icon === undefined ? parseIcon(current.icon) : normalizeProjectIconSpec(patch.icon);
    const revision = current.revision + 1;
    const updatedAt = Date.now();
    const result = this.database.run(
      `UPDATE project_identities
       SET name = ?, icon = ?, revision = ?, updated_at = ?
       WHERE root_path = ? AND revision = ?`,
      [name, JSON.stringify(icon), revision, updatedAt, canonical, current.revision],
    );
    if (result.changes !== 1) throw new ProjectIdentityConflictError();
    return { id: current.id, name, icon, revision };
  }

  reset(rootPath: unknown, expectedRevision?: number): ProjectIdentity & { revision: number } {
    return this.update(rootPath, { icon: { mode: 'automatic' }, expectedRevision });
  }
}

export { canonicalProjectPath };
