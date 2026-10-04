import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import { createVaultExport, listNotes, syncProjectDocuments, updateNote } from '../notes-service';
import {
  parseVaultArchive,
  previewVaultArchiveRestore,
  restoreVaultArchive,
  type ParsedVaultArchive,
} from '../vault-archive';
import { ProductionVaultRestoreAdapter } from '../vault-restore-service';

let root: string;
let destination: string;
beforeAll(async () => {
  await initDb();
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-relationships-')));
  destination = realpathSync(mkdtempSync(join(tmpdir(), 'vault-remapped-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
});

// Repack a validated export with a changed manifest. Payload bytes remain
// untouched, so rejected fixtures exercise relationship validation specifically.
function rewriteManifest(archive: ParsedVaultArchive, change: (manifest: any) => void): Buffer {
  const manifest = JSON.parse(JSON.stringify(archive.manifest));
  change(manifest);
  const parts: Buffer[] = [];
  for (const path of archive.entryPaths) {
    const bytes =
      path === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : archive.readEntry(path);
    const header = Buffer.alloc(512);
    const text = (offset: number, value: string) => {
      header.write(value, offset, 'utf8');
    };
    const octal = (offset: number, length: number, value: number) =>
      text(offset, value.toString(8).padStart(length - 1, '0') + '\0');
    text(0, path);
    octal(100, 8, 0o600);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, bytes.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    text(257, 'ustar\0');
    text(263, '00');
    text(
      148,
      header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
    );
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function fixture() {
  for (const name of ['alpha', 'beta', 'gamma'])
    writeFileSync(join(root, `${name}.md`), `# ${name}\n\nEvidence ${name}.\n`);
  await syncProjectDocuments(root);
  const notes = await listNotes(undefined, root);
  const a = notes.find((note) => note.title === 'alpha')!;
  const b = notes.find((note) => note.title === 'beta')!;
  const c = notes.find((note) => note.title === 'gamma')!;
  await updateNote(
    a.id,
    { content: '# alpha\n\nChanged evidence.', expectedRevision: a.revision },
    root,
  );
  const records = [
    [a.id, b.id, 'supports', 'accepted', 4],
    [b.id, c.id, 'contradicts', 'proposed', 1],
    [c.id, a.id, 'depends_on', 'rejected', 2],
  ] as const;
  for (const [from, to, type, status, revision] of records) {
    getDb()
      .query(
        `INSERT INTO note_relationships
      (from_note_id,to_note_id,project_root,type,status,actor_json,provenance,evidence,weight,revision,source_revision,target_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        from,
        to,
        root,
        type,
        status,
        JSON.stringify({
          sessionId: 'original-session',
          provider: 'test',
          model: 'evidence-model',
        }),
        'agent',
        'Cited source passage, not inferred similarity.',
        0.75,
        revision,
        1,
        1,
        1000,
        2000,
      );
  }
  const exported = await createVaultExport(root);
  const bytes = Buffer.from(await new Response(exported.body).arrayBuffer());
  return { bytes, archive: await parseVaultArchive(bytes), a, b, c };
}

describe('durable relationship vault portability', () => {
  test('roundtrips typed lifecycle/provenance and remaps IDs without refreshing stale evidence', async () => {
    const { bytes, archive, a } = await fixture();
    expect(archive.manifest.relationships).toHaveLength(3);
    expect(archive.manifest.links).toHaveLength(0);
    const original = archive.manifest.relationships!.find((edge) => edge.fromNoteId === a.id)!;
    expect(original).toMatchObject({
      type: 'supports',
      status: 'accepted',
      revision: 4,
      sourceRevision: 1,
      targetRevision: 1,
      provenance: 'agent',
    });
    const adapter = new ProductionVaultRestoreAdapter(getDb());
    const plan = await previewVaultArchiveRestore(bytes, {
      projectRoot: destination,
      inventory: await adapter.inspectProject(destination),
    });
    expect(plan.relationships).toBe(3);
    const result = await restoreVaultArchive(bytes, {
      projectRoot: destination,
      expectedArchiveSha256: plan.archiveSha256,
      adapter,
    });
    expect(result.restoredRelationships).toBe(3);
    const rows = getDb()
      .query<any, [string]>(
        `SELECT r.*, n.revision AS current_source_revision FROM note_relationships r JOIN notes n ON n.id = r.from_note_id WHERE r.project_root = ? ORDER BY r.type`,
      )
      .all(destination);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.status).sort()).toEqual(['accepted', 'proposed', 'rejected']);
    const restored = rows.find((row) => row.type === 'supports');
    expect(restored.from_note_id).not.toBe(a.id);
    expect(restored.source_revision).toBe(1);
    expect(restored.current_source_revision).toBe(2);
    expect(restored.revision).toBe(4);
    expect(restored.evidence).toBe(original.evidence);
    expect(restored.provenance).toBe('agent');
    expect(JSON.parse(restored.actor_json)).toEqual(original.actor);
    expect(restored.created_at).toBe(1000);
    expect(restored.updated_at).toBe(2000);
    // Export again from the destination: no inferred links or lifecycle changes.
    const again = await createVaultExport(destination);
    const parsedAgain = await parseVaultArchive(
      Buffer.from(await new Response(again.body).arrayBuffer()),
    );
    expect(
      parsedAgain.manifest
        .relationships!.map(({ fromNoteId, toNoteId, ...rest }) => rest)
        .sort((x, y) => x.type.localeCompare(y.type)),
    ).toEqual(
      archive.manifest
        .relationships!.map(({ fromNoteId, toNoteId, ...rest }) => rest)
        .sort((x, y) => x.type.localeCompare(y.type)),
    );
  });

  test('accepts old v1/v2 with no relationships and legacy association lifecycle defaults', async () => {
    const { archive } = await fixture();
    for (const version of [1, 2]) {
      const legacy = await parseVaultArchive(
        rewriteManifest(archive, (manifest) => {
          manifest.version = version;
          delete manifest.relationships;
        }),
      );
      expect(legacy.manifest.relationships).toEqual([]);
    }
    const normalized = await parseVaultArchive(
      rewriteManifest(archive, (manifest) => {
        for (const edge of manifest.relationships) {
          delete edge.type;
          delete edge.status;
          delete edge.actor;
        }
      }),
    );
    expect(
      normalized.manifest.relationships!.every(
        (edge) => edge.type === 'related_to' && edge.status === 'accepted',
      ),
    ).toBe(true);
  });

  test.each([
    [
      'foreign endpoint',
      (m: any) => {
        m.relationships[0].toNoteId = 'foreign-note';
      },
    ],
    [
      'self edge',
      (m: any) => {
        m.relationships[0].toNoteId = m.relationships[0].fromNoteId;
      },
    ],
    [
      'duplicate edge',
      (m: any) => {
        m.relationships.push(m.relationships[0]);
      },
    ],
    [
      'unknown type',
      (m: any) => {
        m.relationships[0].type = 'is_true';
      },
    ],
    [
      'unknown status',
      (m: any) => {
        m.relationships[0].status = 'verified';
      },
    ],
    [
      'empty evidence',
      (m: any) => {
        m.relationships[0].evidence = '';
      },
    ],
    [
      'bad weight',
      (m: any) => {
        m.relationships[0].weight = 2;
      },
    ],
    [
      'missing source revision',
      (m: any) => {
        delete m.relationships[0].sourceRevision;
      },
    ],
    [
      'future endpoint revision',
      (m: any) => {
        m.relationships[0].targetRevision = 999;
      },
    ],
    [
      'unknown provenance',
      (m: any) => {
        m.relationships[0].provenance = 'trusted';
      },
    ],
    [
      'malformed actor',
      (m: any) => {
        m.relationships[0].actor = { sessionId: {} };
      },
    ],
  ] as const)('rejects %s before any restore writes', async (_label, change) => {
    const { archive } = await fixture();
    await expect(parseVaultArchive(rewriteManifest(archive, change))).rejects.toThrow();
    expect(
      getDb()
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM notes WHERE project_root = ?',
        )
        .get(destination)!.count,
    ).toBe(0);
  });

  test('bounds relationship section size', async () => {
    const { bytes } = await fixture();
    await expect(parseVaultArchive(bytes, { limits: { maxRelationships: 2 } })).rejects.toThrow(
      '2 relationships',
    );
  });
});
