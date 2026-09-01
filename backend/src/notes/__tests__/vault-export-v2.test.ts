import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NoteBaseDefinition } from '../note-bases-service';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const databaseDirectory = mkdtempSync(join(tmpdir(), 'kory-vault-export-v2-db-'));
process.env.DATABASE_URL = `sqlite://${join(databaseDirectory, 'vault-export.sqlite')}`;

const { initDb } = await import('../../db');
const { createNoteBase, trashNoteBase, updateNoteBase } = await import('../note-bases-service');
const { noteDraftService } = await import('../note-draft-service');
const { createNote, createVaultExport } = await import('../notes-service');
const { parseVaultArchive } = await import('../vault-archive');

let fixtureRoot = '';

beforeAll(async () => {
  await initDb();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-vault-export-v2-'));
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(databaseDirectory, { recursive: true, force: true });
});

async function readArtifact(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

const initialDefinition: NoteBaseDefinition = {
  version: 1,
  sort: [],
  view: {
    kind: 'table',
    fields: [{ source: 'system', field: 'title' }],
  },
};

const updatedDefinition: NoteBaseDefinition = {
  version: 1,
  filter: {
    kind: 'predicate',
    field: { source: 'system', field: 'pinned' },
    operator: 'eq',
    value: true,
  },
  sort: [{ field: { source: 'system', field: 'updated' }, direction: 'desc' }],
  view: {
    kind: 'card',
    fields: [
      { source: 'system', field: 'title' },
      { source: 'system', field: 'tags' },
    ],
  },
};

describe('whole-vault export v2', () => {
  test('exports deterministic Base history and recoverable draft branches without crossing projects', async () => {
    const project = join(fixtureRoot, 'portable-project');
    const foreignProject = join(fixtureRoot, 'foreign-project');
    mkdirSync(project, { recursive: true });
    mkdirSync(foreignProject, { recursive: true });

    const note = await createNote(
      {
        title: 'Portable note',
        content: '# Portable\n\nAuthoritative content.\n',
        folderPath: '/Decisions',
        tags: ['portable'],
        pinned: true,
        includeInContext: true,
      },
      project,
    );
    const createdBase = createNoteBase(
      { name: 'Decisions', definition: initialDefinition },
      project,
    );
    const updatedBase = updateNoteBase(
      createdBase.id,
      {
        expectedRevision: createdBase.revision,
        name: 'Pinned decisions',
        definition: updatedDefinition,
      },
      project,
    );
    const trashedBase = trashNoteBase(createdBase.id, updatedBase.revision, project);

    const liveDraft = noteDraftService.createDraft(
      {
        noteId: note.id,
        baseRevision: note.revision,
        title: 'Portable note - unsaved',
        content: '# Portable\n\nUnsaved branch.\n',
        folderPath: '/Decisions',
        tags: ['portable', 'draft'],
        pinned: true,
        includeInContext: false,
        format: 'markdown',
      },
      project,
    );
    const orphanDraft = noteDraftService.createDraft(
      {
        noteId: 'missing-note-branch',
        baseRevision: 1,
        baseTitle: 'Deleted note',
        title: 'Deleted note - recovered',
        content: 'Only the durable draft still exists.\n',
        folderPath: '/Recovery',
        tags: ['orphan'],
        pinned: false,
        includeInContext: false,
        format: 'markdown',
      },
      project,
    );

    const foreignBase = createNoteBase(
      { name: 'Foreign Base', definition: initialDefinition },
      foreignProject,
    );
    const foreignDraft = noteDraftService.createDraft(
      {
        noteId: 'foreign-missing-note',
        baseRevision: 1,
        baseTitle: 'Foreign',
        title: 'Foreign',
        content: 'Must not cross project scope.',
        folderPath: '',
        tags: [],
        pinned: false,
        includeInContext: false,
        format: 'markdown',
      },
      foreignProject,
    );

    const first = await createVaultExport(project);
    const firstBytes = await readArtifact(first.body);
    const second = await createVaultExport(project);
    const secondBytes = await readArtifact(second.body);
    expect(firstBytes.equals(secondBytes)).toBe(true);

    const archive = await parseVaultArchive(firstBytes);
    expect(archive.manifest.version).toBe(2);
    expect(archive.manifest.files).toEqual([]);
    expect(archive.manifest.bases.map((base) => base.id)).toEqual([createdBase.id]);
    expect(archive.manifest.bases.map((base) => base.id)).not.toContain(foreignBase.id);
    expect(archive.manifest.drafts.map((draft) => draft.id).sort()).toEqual(
      [liveDraft.id, orphanDraft.id].sort(),
    );
    expect(archive.manifest.drafts.map((draft) => draft.id)).not.toContain(foreignDraft.id);

    const base = archive.manifest.bases[0]!;
    expect(base).toMatchObject({
      id: createdBase.id,
      name: 'Pinned decisions',
      revision: trashedBase.revision,
    });
    const basePayload = JSON.parse(
      archive.readEntry(base.definitionPath as string).toString('utf8'),
    ) as {
      format: string;
      version: number;
      current: { definition: NoteBaseDefinition; revision: number; trashedAt: string };
      revisions: Array<{ revision: number; operation: string; definition: NoteBaseDefinition }>;
    };
    expect(basePayload).toMatchObject({
      format: 'koryphaios-note-base',
      version: 1,
      current: {
        definition: updatedDefinition,
        revision: 3,
      },
    });
    expect(basePayload.current.trashedAt).toBeString();
    expect(basePayload.revisions.map(({ revision, operation }) => ({ revision, operation }))).toEqual(
      [
        { revision: 1, operation: 'create' },
        { revision: 2, operation: 'update' },
        { revision: 3, operation: 'trash' },
      ],
    );

    const exportedLiveDraft = archive.manifest.drafts.find((draft) => draft.id === liveDraft.id)!;
    expect(exportedLiveDraft).toMatchObject({
      noteId: note.id,
      baseRevision: note.revision,
      draftRevision: liveDraft.draftRevision,
      title: 'Portable note - unsaved',
      tags: ['portable', 'draft'],
      pinned: true,
      includeInContext: false,
      format: 'markdown',
      payloadHash: liveDraft.payloadHash,
    });
    expect(archive.readEntry(exportedLiveDraft.contentPath as string).toString('utf8')).toBe(
      '# Portable\n\nUnsaved branch.\n',
    );
    expect(archive.manifest.drafts.find((draft) => draft.id === orphanDraft.id)).toMatchObject({
      noteId: 'missing-note-branch',
      baseTitle: 'Deleted note',
    });

    for (const record of [...archive.manifest.bases, ...archive.manifest.drafts]) {
      expect(record).not.toHaveProperty('principalId');
      expect(record).not.toHaveProperty('projectRoot');
    }
    expect(JSON.stringify(basePayload)).not.toContain(project);
  });
});
