import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectIconSpec } from '@koryphaios/shared';
import { readProjectIcon, releaseReplacedProjectIcon, storeProjectIcon } from './project-icons';

const roots: string[] = [];
let previousDataDir: string | undefined;

function fixture() {
  previousDataDir = process.env.KORYPHAIOS_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'kory-icons-'));
  roots.push(root);
  process.env.KORYPHAIOS_DATA_DIR = root;
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = previousDataDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function png256(): Uint8Array {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(header, 12);
  header.writeUInt32BE(256, 16);
  header.writeUInt32BE(256, 20);
  return new Uint8Array(Buffer.concat([header, Buffer.alloc(64)]));
}

const projectId = 'project_test_icons';

function image(assetId: string): { icon: ProjectIconSpec } {
  return { icon: { mode: 'image', assetId } };
}

describe('releaseReplacedProjectIcon', () => {
  test('deletes the asset when an image icon becomes a monogram', async () => {
    fixture();
    const stored = await storeProjectIcon(projectId, png256());
    await releaseReplacedProjectIcon(
      { id: projectId, ...image(stored.assetId) },
      { icon: { mode: 'monogram', value: 'K' } },
    );
    expect(await readProjectIcon(projectId, stored.assetId)).toBeNull();
  });

  test('keeps the asset when the image spec is unchanged', async () => {
    fixture();
    const stored = await storeProjectIcon(projectId, png256());
    await releaseReplacedProjectIcon(
      { id: projectId, ...image(stored.assetId) },
      image(stored.assetId),
    );
    expect(await readProjectIcon(projectId, stored.assetId)).not.toBeNull();
  });

  test('deletes the old asset when a new image replaces it', async () => {
    fixture();
    const old = await storeProjectIcon(projectId, png256());
    const next = await storeProjectIcon(projectId, png256());
    await releaseReplacedProjectIcon({ id: projectId, ...image(old.assetId) }, image(next.assetId));
    expect(await readProjectIcon(projectId, old.assetId)).toBeNull();
    expect(await readProjectIcon(projectId, next.assetId)).not.toBeNull();
  });

  test('is a no-op when the previous icon was not an image', async () => {
    fixture();
    await expect(
      releaseReplacedProjectIcon(
        { id: projectId, icon: { mode: 'automatic' } },
        { icon: { mode: 'monogram', value: 'K' } },
      ),
    ).resolves.toBeUndefined();
  });
});
