import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const productionDbDirectory = mkdtempSync(join(tmpdir(), 'kory-vault-restore-module-db-'));
process.env.DATABASE_URL = `sqlite://${join(productionDbDirectory, 'unused.sqlite')}`;

const { ProductionVaultRestoreAdapter } = await import('../vault-restore-service');
const { previewVaultArchiveRestore, restoreVaultArchive } = await import('../vault-archive');

const BLOCK = 512;
const NOW = '2026-08-30T12:00:00.000Z';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-vault-restore-'));

beforeAll(() => {
  mkdirSync(fixtureRoot, { recursive: true });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(productionDbDirectory, { recursive: true, force: true });
});

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeText(header: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeText(header, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

function tarHeader(path: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeText(header, 0, 100, path);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function tar(entries: Array<{ path: string; bytes: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.bytes), entry.bytes);
    const padding = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function projectDocumentId(projectRoot: string, sourcePath: string): string {
  return (
    'project-document:' +
    Buffer.from(JSON.stringify([resolve(projectRoot), sourcePath]), 'utf8').toString('base64url')
  );
}

function canonicalDraftHash(input: {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: string;
}): string {
  return digest(
    JSON.stringify([
      input.title,
      input.content,
      input.folderPath,
      input.tags,
      input.pinned,
      input.includeInContext,
      input.format,
    ]),
  );
}

function makeArchive(options: { badDraftHash?: boolean; genericFile?: boolean } = {}) {
  const noteContent = Buffer.from('# Restored\n\nPortable source note.\n');
  const attachment = Buffer.from('attachment proof');
  const draft = {
    title: 'Orphan recovery',
    content: 'Unsaved words survive.\n',
    folderPath: '/Recovery',
    tags: ['orphan'],
    pinned: false,
    includeInContext: false,
    format: 'markdown',
  };
  const draftContent = Buffer.from(draft.content);
  const baseDefinition = {
    version: 1,
    sort: [],
    view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
  };
  const basePayload = Buffer.from(
    JSON.stringify(
      {
        format: 'koryphaios-note-base',
        version: 1,
        current: {
          name: 'Portable decisions',
          definition: baseDefinition,
          revision: 1,
          trashedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        revisions: [
          {
            revision: 1,
            operation: 'create',
            name: 'Portable decisions',
            definition: baseDefinition,
            trashedAt: null,
            baseCreatedAt: NOW,
            baseUpdatedAt: NOW,
            createdAt: NOW,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  const oldSourceId = projectDocumentId('/old/project', 'docs/restored.md');
  const manifest = {
    format: 'koryphaios-notes-vault',
    version: 2,
    project: { name: 'Portable' },
    notes: [
      {
        id: oldSourceId,
        title: 'Restored',
        folderPath: '/docs',
        tags: ['portable'],
        internalTags: [],
        pinned: true,
        includeInContext: true,
        format: 'markdown',
        sourcePath: 'docs/restored.md',
        revision: 1,
        userId: null,
        createdAt: NOW,
        updatedAt: NOW,
        trashedAt: null,
        trashReason: null,
        contentPath: 'notes/current.md',
        contentBytes: noteContent.length,
        contentSha256: digest(noteContent),
      },
    ],
    revisions: [
      {
        noteId: oldSourceId,
        revision: 1,
        operation: 'create',
        title: 'Restored',
        folderPath: '/docs',
        tags: ['portable'],
        internalTags: [],
        pinned: true,
        includeInContext: true,
        format: 'markdown',
        sourcePath: 'docs/restored.md',
        trashedAt: null,
        trashReason: null,
        noteCreatedAt: NOW,
        noteUpdatedAt: NOW,
        createdAt: NOW,
        contentPath: 'revisions/one.md',
        contentBytes: noteContent.length,
        contentSha256: digest(noteContent),
      },
    ],
    attachments: [
      {
        id: 'attachment-one',
        noteId: oldSourceId,
        filename: 'proof.txt',
        mimeType: 'text/plain',
        size: attachment.length,
        createdAt: NOW,
        path: 'attachments/one',
        sha256: digest(attachment),
      },
    ],
    links: [{ fromNoteId: oldSourceId, toNoteId: oldSourceId }],
    bases: [
      {
        id: 'base-one',
        name: 'Portable decisions',
        revision: 1,
        trashedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        definitionPath: 'bases/one.json',
        definitionBytes: basePayload.length,
        definitionSha256: digest(basePayload),
      },
    ],
    drafts: [
      {
        id: 'draft-one',
        noteId: 'deleted-note',
        baseRevision: 1,
        draftRevision: 3,
        baseTitle: 'Deleted note',
        sourcePathAtBase: null,
        title: draft.title,
        folderPath: draft.folderPath,
        tags: draft.tags,
        pinned: draft.pinned,
        includeInContext: draft.includeInContext,
        format: draft.format,
        payloadHash: options.badDraftHash ? '0'.repeat(64) : canonicalDraftHash(draft),
        createdAt: NOW,
        updatedAt: NOW,
        contentPath: 'drafts/one.md',
        contentBytes: draftContent.length,
        contentSha256: digest(draftContent),
      },
    ],
    files: options.genericFile
      ? [
          {
            id: 'future-file',
            path: 'workspace/future.bin',
            size: 1,
            sha256: digest(Buffer.from('x')),
          },
        ]
      : [],
  };
  const entries = [
    { path: 'notes/current.md', bytes: noteContent },
    { path: 'revisions/one.md', bytes: noteContent },
    { path: 'attachments/one', bytes: attachment },
    { path: 'bases/one.json', bytes: basePayload },
    { path: 'drafts/one.md', bytes: draftContent },
  ];
  if (options.genericFile) entries.push({ path: 'workspace/future.bin', bytes: Buffer.from('x') });
  entries.push({ path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) });
  return { bytes: tar(entries), oldSourceId, noteContent, attachment };
}

function makeDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
      folder_path TEXT NOT NULL, tags TEXT NOT NULL, pinned INTEGER NOT NULL,
      include_in_context INTEGER NOT NULL, format TEXT NOT NULL,
      project_root TEXT, revision INTEGER NOT NULL, trashed_at INTEGER,
      trash_reason TEXT, user_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE note_revisions (
      note_id TEXT NOT NULL, revision INTEGER NOT NULL, project_root TEXT NOT NULL,
      operation TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      content_bytes INTEGER NOT NULL, folder_path TEXT NOT NULL, tags TEXT NOT NULL,
      pinned INTEGER NOT NULL, include_in_context INTEGER NOT NULL, format TEXT NOT NULL,
      source_path TEXT, trashed_at INTEGER, trash_reason TEXT,
      note_created_at INTEGER NOT NULL, note_updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(note_id, revision),
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE note_links (
      from_note_id TEXT NOT NULL, to_note_id TEXT NOT NULL,
      PRIMARY KEY(from_note_id, to_note_id),
      FOREIGN KEY(from_note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(to_note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE note_attachments (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL, filename TEXT NOT NULL,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL, FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE note_draft_principals (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    INSERT INTO note_draft_principals VALUES ('local-test', 'local', 1);
    CREATE TABLE note_drafts (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_root TEXT NOT NULL,
      note_id TEXT NOT NULL, base_revision INTEGER NOT NULL, draft_revision INTEGER NOT NULL,
      base_title TEXT NOT NULL, source_path_at_base TEXT, title TEXT NOT NULL,
      content TEXT NOT NULL, content_bytes INTEGER NOT NULL, folder_path TEXT NOT NULL,
      tags TEXT NOT NULL, pinned INTEGER NOT NULL, include_in_context INTEGER NOT NULL,
      format TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(principal_id) REFERENCES note_draft_principals(id) ON DELETE RESTRICT
    );
    CREATE TABLE note_bases (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_root TEXT NOT NULL,
      name TEXT NOT NULL, definition TEXT NOT NULL, revision INTEGER NOT NULL,
      trashed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(principal_id) REFERENCES note_draft_principals(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX uq_note_bases_scope_name
      ON note_bases(principal_id, project_root, name COLLATE NOCASE);
    CREATE TABLE note_base_revisions (
      base_id TEXT NOT NULL, revision INTEGER NOT NULL, project_root TEXT NOT NULL,
      operation TEXT NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL,
      trashed_at INTEGER, base_created_at INTEGER NOT NULL, base_updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(base_id, revision),
      FOREIGN KEY(base_id) REFERENCES note_bases(id) ON DELETE CASCADE
    );
    CREATE TABLE note_vault_restore_commits (
      archive_sha256 TEXT NOT NULL, project_root TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL, plan_token TEXT NOT NULL, committed_at INTEGER NOT NULL,
      PRIMARY KEY(archive_sha256, project_root)
    );
  `);
  return database;
}

async function planFor(
  adapter: InstanceType<typeof ProductionVaultRestoreAdapter>,
  bytes: Buffer,
  projectRoot: string,
) {
  return previewVaultArchiveRestore(bytes, {
    projectRoot,
    inventory: await adapter.inspectProject(projectRoot),
  });
}

describe('production whole-vault restore adapter', () => {
  test('atomically restores and re-keys source notes, history, links, attachments, Bases, and orphan drafts', async () => {
    const projectRoot = mkdtempSync(join(fixtureRoot, 'complete-'));
    const database = makeDatabase();
    const adapter = new ProductionVaultRestoreAdapter(database, { legacyProjectRoot: projectRoot });
    const archive = makeArchive();
    const plan = await planFor(adapter, archive.bytes, projectRoot);
    expect(plan.canRestore).toBe(true);

    const result = await restoreVaultArchive(archive.bytes, {
      projectRoot,
      expectedArchiveSha256: plan.archiveSha256,
      adapter,
    });
    expect(result).toMatchObject({
      restoredNotes: 1,
      restoredRevisions: 1,
      restoredAttachments: 1,
      restoredLinks: 1,
      restoredBases: 1,
      restoredDrafts: 1,
    });

    const mappedId = projectDocumentId(projectRoot, 'docs/restored.md');
    expect(mappedId).not.toBe(archive.oldSourceId);
    expect(database.query<{ id: string }, []>(`SELECT id FROM notes`).get()?.id).toBe(mappedId);
    expect(
      database.query<{ note_id: string }, []>(`SELECT note_id FROM note_revisions`).get()?.note_id,
    ).toBe(mappedId);
    expect(
      database
        .query(`SELECT 1 FROM note_links WHERE from_note_id = ? AND to_note_id = ?`)
        .get(mappedId, mappedId),
    ).toBeTruthy();
    expect(readFileSync(join(projectRoot, 'docs/restored.md'))).toEqual(archive.noteContent);
    expect(readFileSync(join(projectRoot, '.koryphaios/attachments/attachment-one'))).toEqual(
      archive.attachment,
    );
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM note_base_revisions`)
        .get()?.count,
    ).toBe(1);
    expect(
      database.query<{ note_id: string }, []>(`SELECT note_id FROM note_drafts`).get()?.note_id,
    ).toBe('deleted-note');
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM note_vault_restore_commits`)
        .get()?.count,
    ).toBe(1);

    await expect(
      restoreVaultArchive(archive.bytes, {
        projectRoot,
        expectedArchiveSha256: plan.archiveSha256,
        adapter,
      }),
    ).rejects.toThrow('overwrite');
    database.close();
  });

  test('preserves a target created after preview and rolls back every row and staged artifact', async () => {
    const projectRoot = mkdtempSync(join(fixtureRoot, 'race-'));
    const database = makeDatabase();
    const adapter = new ProductionVaultRestoreAdapter(database, { legacyProjectRoot: projectRoot });
    const archive = makeArchive();
    const plan = await planFor(adapter, archive.bytes, projectRoot);
    mkdirSync(join(projectRoot, 'docs'));
    writeFileSync(join(projectRoot, 'docs/restored.md'), 'new local work');

    await expect(adapter.commitNoOverwriteAtomically(plan)).rejects.toThrow('now exists');
    expect(readFileSync(join(projectRoot, 'docs/restored.md'), 'utf8')).toBe('new local work');
    expect(
      database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM notes`).get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM note_vault_restore_commits`)
        .get()?.count,
    ).toBe(0);
    const journalDirectory = join(projectRoot, '.koryphaios/vault-restore-journal');
    expect(
      existsSync(journalDirectory)
        ? readdirSync(journalDirectory).filter((name) => name.endsWith('.json'))
        : [],
    ).toEqual([]);
    database.close();
  });

  test('fails closed for forged draft snapshots and future generic files before creating data', async () => {
    for (const archive of [
      makeArchive({ badDraftHash: true }),
      makeArchive({ genericFile: true }),
    ]) {
      const projectRoot = mkdtempSync(join(fixtureRoot, 'invalid-'));
      const database = makeDatabase();
      const adapter = new ProductionVaultRestoreAdapter(database, {
        legacyProjectRoot: projectRoot,
      });
      const plan = await planFor(adapter, archive.bytes, projectRoot);
      await expect(adapter.commitNoOverwriteAtomically(plan)).rejects.toThrow();
      expect(
        database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM notes`).get()?.count,
      ).toBe(0);
      expect(existsSync(join(projectRoot, 'docs/restored.md'))).toBe(false);
      database.close();
    }
  });

  test('uses the commit witness to retain completed files and removes exact uncommitted crash residue', async () => {
    const projectRoot = mkdtempSync(join(fixtureRoot, 'recovery-'));
    const database = makeDatabase();
    const adapter = new ProductionVaultRestoreAdapter(database, { legacyProjectRoot: projectRoot });
    const archive = makeArchive();
    const plan = await planFor(adapter, archive.bytes, projectRoot);
    await adapter.commitNoOverwriteAtomically(plan);

    const journalDirectory = join(projectRoot, '.koryphaios/vault-restore-journal');
    const stagingRoot = join(projectRoot, '.koryphaios/vault-restore-staging');
    mkdirSync(journalDirectory, { recursive: true });
    const committedStage = join(stagingRoot, 'committed-proof');
    mkdirSync(committedStage, { recursive: true });
    const sourceBytes = archive.noteContent;
    writeFileSync(
      join(journalDirectory, `${plan.archiveSha256}.json`),
      JSON.stringify({
        format: 'koryphaios-vault-restore-journal',
        version: 1,
        archiveSha256: plan.archiveSha256,
        manifestSha256: plan.manifestSha256,
        planToken: plan.planToken,
        projectRoot,
        stagingRelative: '.koryphaios/vault-restore-staging/committed-proof',
        files: [
          {
            kind: 'source',
            targetRelative: 'docs/restored.md',
            stageRelative: '0',
            bytes: sourceBytes.length,
            sha256: digest(sourceBytes),
            mode: 0o600,
          },
        ],
      }),
    );
    await adapter.inspectProject(projectRoot);
    expect(readFileSync(join(projectRoot, 'docs/restored.md'))).toEqual(sourceBytes);
    expect(existsSync(join(journalDirectory, `${plan.archiveSha256}.json`))).toBe(false);

    const partial = Buffer.from('partial crash bytes');
    const uncommittedDigest = 'a'.repeat(64);
    const uncommittedStage = join(stagingRoot, 'uncommitted-proof');
    mkdirSync(uncommittedStage, { recursive: true });
    writeFileSync(join(uncommittedStage, '0'), partial);
    linkSync(join(uncommittedStage, '0'), join(projectRoot, 'partial.md'));
    writeFileSync(
      join(journalDirectory, `${uncommittedDigest}.json`),
      JSON.stringify({
        format: 'koryphaios-vault-restore-journal',
        version: 1,
        archiveSha256: uncommittedDigest,
        manifestSha256: 'b'.repeat(64),
        planToken: 'c'.repeat(64),
        projectRoot,
        stagingRelative: '.koryphaios/vault-restore-staging/uncommitted-proof',
        files: [
          {
            kind: 'source',
            targetRelative: 'partial.md',
            stageRelative: '0',
            bytes: partial.length,
            sha256: digest(partial),
            mode: 0o600,
          },
        ],
      }),
    );
    await adapter.inspectProject(projectRoot);
    expect(existsSync(join(projectRoot, 'partial.md'))).toBe(false);
    expect(existsSync(join(journalDirectory, `${uncommittedDigest}.json`))).toBe(false);
    database.close();
  });
});
