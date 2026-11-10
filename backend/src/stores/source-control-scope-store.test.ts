import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceControlScopeStore } from './source-control-scope-store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kory-source-scope-'));
  roots.push(root);
  const source = join(root, 'source');
  const docs = join(root, 'docs');
  mkdirSync(source);
  mkdirSync(docs);
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE source_control_repositories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE,
      identity_key TEXT NOT NULL UNIQUE, remote TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE project_roots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, canonical_path TEXT NOT NULL,
      label TEXT NOT NULL, access TEXT NOT NULL, source_control_kind TEXT NOT NULL,
      repository_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, canonical_path)
    );
  `);
  return { source, docs, database, store: new SourceControlScopeStore(database) };
}

describe('SourceControlScopeStore', () => {
  test('allocates stable repository and root identities for multiple roots', () => {
    const { source, docs, database, store } = fixture();
    const sourceRoot = store.ensureRoot('project-1', source, { label: 'Source' });
    const docsRoot = store.ensureRoot('project-1', docs, {
      label: 'Docs',
      access: 'read-only',
      sourceControl: 'none',
    });
    expect(sourceRoot.id).toBe(store.ensureRoot('project-1', source).id);
    expect(sourceRoot.repositoryId).toBeDefined();
    expect(docsRoot.repositoryId).toBeUndefined();
    expect(store.listRoots('project-1')).toEqual([docsRoot, sourceRoot]);
    database.close();
  });

  test('keeps repository kind identity stable and rejects kind drift', () => {
    const { source, database, store } = fixture();
    store.ensureRoot('project-1', source, { sourceControl: 'git' });
    expect(() => store.ensureRoot('project-1', source, { sourceControl: 'mercurial' })).toThrow(
      'Source-control kind changed',
    );
    database.close();
  });
});
