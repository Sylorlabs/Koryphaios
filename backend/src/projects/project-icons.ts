import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir } from '../security/fs-permissions';

export const PROJECT_ICON_MAX_BYTES = 1_024 * 1_024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ASSET_ID = /^[0-9a-f-]{36}$/i;

function root(): string {
  const dataRoot = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return resolve(dataRoot, 'project-icons');
}

function ownerHash(projectId: string): string {
  return createHash('sha256').update(projectId).digest('hex');
}

function assetDirectory(assetId: string): string {
  if (!ASSET_ID.test(assetId)) throw new Error('Invalid project icon asset id');
  const storage = root();
  const target = resolve(storage, assetId);
  if (dirname(target) !== storage) throw new Error('Project icon escaped its storage root');
  return target;
}

function validPng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  // Browser crop output is required to be exactly 256×256 PNG.
  const firstChunkLength = bytes.readUInt32BE(8);
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || firstChunkLength !== 13) return false;
  return bytes.readUInt32BE(16) === 256 && bytes.readUInt32BE(20) === 256;
}

async function privateWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function storeProjectIcon(
  projectId: string,
  input: Uint8Array,
): Promise<{ assetId: string; revision: string }> {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > PROJECT_ICON_MAX_BYTES || !validPng(bytes)) {
    throw new Error('Project icon must be a 256×256 PNG smaller than 1 MiB');
  }
  const assetId = randomUUID();
  const revision = createHash('sha256').update(bytes).digest('hex');
  const storage = root();
  ensureSecureDir(storage);
  const finalDirectory = assetDirectory(assetId);
  const stagingDirectory = resolve(storage, `.${assetId}.${randomUUID()}.tmp`);
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    await privateWrite(join(stagingDirectory, 'icon.png'), bytes);
    await privateWrite(
      join(stagingDirectory, 'metadata.json'),
      JSON.stringify({ version: 1, ownerHash: ownerHash(projectId), revision }) + '\n',
    );
    await rename(stagingDirectory, finalDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return { assetId, revision };
}

export async function readProjectIcon(
  projectId: string,
  assetId: string,
): Promise<{ bytes: Buffer; revision: string } | null> {
  const directory = assetDirectory(assetId);
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')) as {
      ownerHash?: string;
      revision?: string;
    };
    const expected = Buffer.from(ownerHash(projectId), 'hex');
    const actual = Buffer.from(metadata.ownerHash ?? '', 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const bytes = await readFile(join(directory, 'icon.png'));
    if (!validPng(bytes) || createHash('sha256').update(bytes).digest('hex') !== metadata.revision)
      return null;
    return { bytes, revision: metadata.revision ?? '' };
  } catch {
    return null;
  }
}

export async function deleteProjectIcon(projectId: string, assetId: string): Promise<boolean> {
  const directory = assetDirectory(assetId);
  const stored = await readProjectIcon(projectId, assetId);
  if (!stored) return false;
  const tombstone = resolve(root(), `.${assetId}.${randomUUID()}.deleted`);
  await rename(directory, tombstone);
  await rm(tombstone, { recursive: true, force: true });
  return true;
}
