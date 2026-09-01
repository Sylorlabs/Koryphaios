import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, PayloadTooLargeError, ValidationError } from '../../errors/types';
import {
  parseVaultArchive,
  previewVaultArchiveRestore,
  restoreVaultArchive,
  type VaultArchiveManifest,
  type VaultArchiveRestorePlan,
  type VaultRestoreCommitCounts,
} from '../vault-archive';

const BLOCK = 512;
const NOTE_CONTENT = Buffer.from('# Durable note\n');
const ATTACHMENT_CONTENT = Buffer.from('proof bytes');
const DRAFT_CONTENT = Buffer.from('recoverable draft');
const EXTRA_CONTENT = Buffer.from('{"portable":true}\n');
const NOW = '2026-08-30T12:00:00.000Z';

let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-vault-archive-'));
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeText(header: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeText(header, offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
}

interface TarEntryFixture {
  path: string;
  bytes: Buffer;
  type?: number;
  malformedSize?: string;
}

function tarHeader(entry: TarEntryFixture): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeText(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  if (entry.malformedSize !== undefined) {
    writeText(header, 124, 12, entry.malformedSize);
  } else {
    writeOctal(header, 124, 12, entry.bytes.length);
  }
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type ?? 0x30;
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function makeTar(entries: TarEntryFixture[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry), entry.bytes);
    const padding = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function rewriteHeaderChecksum(archive: Buffer, headerOffset = 0): void {
  const header = archive.subarray(headerOffset, headerOffset + BLOCK);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.fill(0, 148, 156);
  writeText(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
}

function baseManifest(version: 1 | 2 = 1): VaultArchiveManifest {
  const noteHash = digest(NOTE_CONTENT);
  return {
    format: 'koryphaios-notes-vault',
    version,
    project: { name: 'Portable project' },
    notes: [
      {
        id: 'note-1',
        title: 'Durable note',
        folderPath: '/Decisions',
        tags: ['portable'],
        internalTags: [],
        pinned: true,
        includeInContext: true,
        format: 'markdown',
        sourcePath: 'docs/durable.md',
        revision: 1,
        userId: null,
        createdAt: NOW,
        updatedAt: NOW,
        trashedAt: null,
        trashReason: null,
        contentPath: 'notes/note-1.md',
        contentBytes: NOTE_CONTENT.length,
        contentSha256: noteHash,
      },
    ],
    revisions: [
      {
        noteId: 'note-1',
        revision: 1,
        operation: 'create',
        title: 'Durable note',
        folderPath: '/Decisions',
        tags: ['portable'],
        internalTags: [],
        pinned: true,
        includeInContext: true,
        format: 'markdown',
        sourcePath: 'docs/durable.md',
        trashedAt: null,
        trashReason: null,
        noteCreatedAt: NOW,
        noteUpdatedAt: NOW,
        createdAt: NOW,
        contentPath: 'revisions/note-1/1.md',
        contentBytes: NOTE_CONTENT.length,
        contentSha256: noteHash,
      },
    ],
    attachments: [
      {
        id: 'attachment-1',
        noteId: 'note-1',
        filename: 'proof.bin',
        mimeType: 'application/octet-stream',
        size: ATTACHMENT_CONTENT.length,
        createdAt: NOW,
        path: 'attachments/attachment-1',
        sha256: digest(ATTACHMENT_CONTENT),
      },
    ],
    links: [{ fromNoteId: 'note-1', toNoteId: 'note-1' }],
    bases: [],
    drafts: [],
    files: [],
  };
}

function archiveFromManifest(
  manifest: VaultArchiveManifest,
  extraEntries: TarEntryFixture[] = [],
): Buffer {
  const entries: TarEntryFixture[] = [
    { path: 'notes/note-1.md', bytes: NOTE_CONTENT },
    { path: 'revisions/note-1/1.md', bytes: NOTE_CONTENT },
    { path: 'attachments/attachment-1', bytes: ATTACHMENT_CONTENT },
  ];
  if (manifest.version === 2 && manifest.drafts.length) {
    entries.push({ path: 'drafts/draft-1.md', bytes: DRAFT_CONTENT });
  }
  if (manifest.version === 2 && manifest.files.length) {
    entries.push({ path: 'workspace/extra.json', bytes: EXTRA_CONTENT });
  }
  entries.push(...extraEntries);
  entries.push({ path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) });
  return makeTar(entries);
}

function v2Manifest(): VaultArchiveManifest {
  const manifest = baseManifest(2);
  manifest.bases = [{ id: 'base-1', name: 'Decisions', definition: { version: 1 } }];
  manifest.drafts = [
    {
      id: 'draft-1',
      noteId: 'note-1',
      contentPath: 'drafts/draft-1.md',
      contentBytes: DRAFT_CONTENT.length,
      contentSha256: digest(DRAFT_CONTENT),
    },
  ];
  manifest.files = [
    {
      id: 'workspace-extra',
      path: 'workspace/extra.json',
      size: EXTRA_CONTENT.length,
      sha256: digest(EXTRA_CONTENT),
    },
  ];
  return manifest;
}

describe('vault archive integrity boundary', () => {
  test('parses Buffer and File inputs, verifies all payloads, and accepts v1 and v2', async () => {
    const v1Bytes = archiveFromManifest(baseManifest());
    const v1 = await parseVaultArchive(v1Bytes);
    expect(v1.manifest.version).toBe(1);
    expect(v1.archiveSha256).toBe(digest(v1Bytes));
    expect(v1.manifestSha256).toBe(digest(Buffer.from(JSON.stringify(baseManifest()))));
    expect(v1.readEntry('notes/note-1.md')).toEqual(NOTE_CONTENT);
    const mutableCopy = v1.readEntry('notes/note-1.md');
    mutableCopy[0] = 0;
    expect(v1.readEntry('notes/note-1.md')).toEqual(NOTE_CONTENT);
    expect(() => {
      v1.manifest.notes[0]!.title = 'mutated after validation';
    }).toThrow();

    const v2Bytes = archiveFromManifest(v2Manifest());
    const file = new File([v2Bytes], 'portable-vault.tar', {
      type: 'application/x-tar',
    });
    const v2 = await parseVaultArchive(file);
    expect(v2.manifest.version).toBe(2);
    expect(v2.manifest.bases).toHaveLength(1);
    expect(v2.manifest.drafts).toHaveLength(1);
    expect(v2.readEntry('drafts/draft-1.md')).toEqual(DRAFT_CONTENT);
  });

  test('rejects traversal, duplicate names, non-regular entries, malformed sizes, and bad checksums', async () => {
    const traversal = makeTar([
      { path: '../outside', bytes: Buffer.alloc(0) },
      { path: 'manifest.json', bytes: Buffer.from('{}') },
    ]);
    await expect(parseVaultArchive(traversal)).rejects.toThrow('unsafe path segment');

    const duplicate = makeTar([
      { path: 'same', bytes: Buffer.alloc(0) },
      { path: 'same', bytes: Buffer.alloc(0) },
    ]);
    await expect(parseVaultArchive(duplicate)).rejects.toThrow('duplicate entry');

    const nonRegular = makeTar([{ path: 'link', bytes: Buffer.alloc(0), type: 0x32 }]);
    await expect(parseVaultArchive(nonRegular)).rejects.toThrow('non-regular');

    const malformedSize = makeTar([
      {
        path: 'bad-size',
        bytes: Buffer.alloc(0),
        malformedSize: '0000000000x\0',
      },
    ]);
    await expect(parseVaultArchive(malformedSize)).rejects.toThrow('expected octal digits');

    const base256Size = archiveFromManifest(baseManifest());
    base256Size[124] = 0xb0;
    rewriteHeaderChecksum(base256Size);
    await expect(parseVaultArchive(base256Size)).rejects.toThrow('expected octal digits');

    const badChecksum = archiveFromManifest(baseManifest());
    badChecksum[10] ^= 0x01;
    await expect(parseVaultArchive(badChecksum)).rejects.toThrow('checksum mismatch');
  });

  test('rejects unsupported manifests, undeclared entries, and every payload integrity mismatch', async () => {
    const unsupportedFormat = baseManifest() as VaultArchiveManifest & { format: string };
    unsupportedFormat.format = 'other-vault';
    await expect(parseVaultArchive(archiveFromManifest(unsupportedFormat))).rejects.toThrow(
      'Unsupported vault archive format',
    );

    const unsupportedVersion = baseManifest() as VaultArchiveManifest & { version: number };
    unsupportedVersion.version = 3;
    await expect(parseVaultArchive(archiveFromManifest(unsupportedVersion))).rejects.toThrow(
      'Unsupported vault archive version',
    );

    await expect(
      parseVaultArchive(
        archiveFromManifest(baseManifest(), [{ path: 'undeclared.bin', bytes: Buffer.from('x') }]),
      ),
    ).rejects.toThrow('undeclared entry');

    const wrongHash = baseManifest();
    wrongHash.notes[0]!.contentSha256 = '0'.repeat(64);
    wrongHash.revisions[0]!.contentSha256 = '0'.repeat(64);
    await expect(parseVaultArchive(archiveFromManifest(wrongHash))).rejects.toThrow(
      'SHA-256 mismatch',
    );

    const wrongBytes = baseManifest();
    wrongBytes.attachments[0]!.size = ATTACHMENT_CONTENT.length + 1;
    await expect(parseVaultArchive(archiveFromManifest(wrongBytes))).rejects.toThrow(
      'byte count mismatch',
    );
  });

  test('rejects excessive archive bytes, tar entry counts, and manifest record counts', async () => {
    const bytes = archiveFromManifest(baseManifest());
    await expect(
      parseVaultArchive(bytes, { limits: { maxArchiveBytes: bytes.length - 1 } }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(parseVaultArchive(bytes, { limits: { maxEntries: 2 } })).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    await expect(parseVaultArchive(bytes, { limits: { maxNotes: 0 } })).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });
});

describe('vault safe-merge preview and restore', () => {
  test('builds a project-scoped preview only after archive and file hashes verify', async () => {
    const project = join(fixtureRoot, 'preview-clean');
    mkdirSync(project, { recursive: true });
    const bytes = archiveFromManifest(baseManifest());
    const preview = await previewVaultArchiveRestore(bytes, {
      projectRoot: project,
      inventory: {},
    });
    expect(preview).toMatchObject({
      format: 'koryphaios-notes-vault',
      archiveVersion: 1,
      archiveSha256: digest(bytes),
      notes: 1,
      revisions: 1,
      attachments: 1,
      links: 1,
      canRestore: true,
      mode: 'safe-merge',
    });
    expect(preview.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.conflicts).toEqual([]);
  });

  test('reports database and filesystem collisions without escaping the selected project', async () => {
    const project = join(fixtureRoot, 'preview-conflicts');
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs', 'durable.md'), 'do not overwrite');
    const preview = await previewVaultArchiveRestore(archiveFromManifest(v2Manifest()), {
      projectRoot: project,
      inventory: {
        noteIds: ['note-1'],
        attachmentIds: ['attachment-1'],
        sourcePaths: ['docs/durable.md'],
        baseIds: ['base-1'],
        baseNames: ['decisions'],
        draftIds: ['draft-1'],
      },
    });
    expect(preview.canRestore).toBe(false);
    expect(preview.conflicts.map((conflict) => conflict.kind)).toEqual([
      'attachment_exists',
      'base_name_exists',
      'note_id_exists',
      'note_id_exists',
      'source_exists',
    ]);

    const unsafe = baseManifest();
    unsafe.notes[0]!.sourcePath = '../outside.md';
    unsafe.revisions[0]!.sourcePath = '../outside.md';
    await expect(
      previewVaultArchiveRestore(archiveFromManifest(unsafe), { projectRoot: project }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('restores through one atomic no-overwrite commit bound to the preview digest', async () => {
    const project = join(fixtureRoot, 'restore-clean');
    mkdirSync(project, { recursive: true });
    const bytes = archiveFromManifest(baseManifest());
    let inspectedRoot = '';
    let commitCalls = 0;
    const counts: VaultRestoreCommitCounts = {
      restoredNotes: 1,
      restoredRevisions: 1,
      restoredAttachments: 1,
      restoredLinks: 1,
      restoredBases: 0,
      restoredDrafts: 0,
    };
    const result = await restoreVaultArchive(bytes, {
      projectRoot: project,
      expectedArchiveSha256: digest(bytes),
      adapter: {
        inspectProject(root) {
          inspectedRoot = root;
          return {};
        },
        commitNoOverwriteAtomically(plan: Readonly<VaultArchiveRestorePlan>) {
          commitCalls += 1;
          expect(plan.canRestore).toBe(true);
          expect(plan.archive.readEntry('attachments/attachment-1')).toEqual(ATTACHMENT_CONTENT);
          return Promise.resolve(counts);
        },
      },
    });
    expect(inspectedRoot).toBe(project);
    expect(commitCalls).toBe(1);
    expect(result).toMatchObject({ ...counts, canRestore: true, archiveSha256: digest(bytes) });
    expect('archive' in result).toBe(false);
  });

  test('fails closed before commit when bytes changed or fresh inventory contains a conflict', async () => {
    const project = join(fixtureRoot, 'restore-conflict');
    mkdirSync(project, { recursive: true });
    const bytes = archiveFromManifest(baseManifest());
    let commitCalls = 0;
    const adapter = {
      inspectProject: () => ({ noteIds: ['note-1'] }),
      commitNoOverwriteAtomically: async () => {
        commitCalls += 1;
        return {
          restoredNotes: 1,
          restoredRevisions: 1,
          restoredAttachments: 1,
          restoredLinks: 1,
          restoredBases: 0,
          restoredDrafts: 0,
        };
      },
    };
    await expect(
      restoreVaultArchive(bytes, {
        projectRoot: project,
        expectedArchiveSha256: '0'.repeat(64),
        adapter,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      restoreVaultArchive(bytes, {
        projectRoot: project,
        expectedArchiveSha256: digest(bytes),
        adapter,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(commitCalls).toBe(0);
  });
});
