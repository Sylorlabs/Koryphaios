import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir } from '../security/fs-permissions';

export const CUSTOM_PROVIDER_ICON_SIZE = 256;
export const CUSTOM_PROVIDER_ICON_MAX_BYTES = 1024 * 1024;

export type CustomProviderIconShape = 'rounded-square' | 'circle';

export interface CustomProviderIconMetadata {
  assetId: string;
  revision: string;
  shape: CustomProviderIconShape;
}

export interface StoredCustomProviderIcon {
  bytes: Uint8Array;
  contentType: 'image/png';
  /** Strong HTTP ETag, including quotes. */
  etag: string;
  metadata: CustomProviderIconMetadata;
}

export interface StoreCustomProviderIconInput {
  /** Stable provider identifier. It is authenticated in storage, never used as a path. */
  providerId: unknown;
  bytes: unknown;
  contentType: unknown;
  shape: unknown;
  /** Replaced only after the new asset is durable. */
  previousAssetId?: unknown;
}

interface StoredManifest {
  version: 1;
  ownerHash: string;
  revision: string;
  shape: CustomProviderIconShape;
  contentType: 'image/png';
}

const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MANIFEST_FILE = 'metadata.json';
const ICON_FILE = 'icon.png';
const MAX_MANIFEST_BYTES = 4096;
const ALLOWED_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const FORBIDDEN_METADATA_CHUNKS = new Set([
  'tEXt',
  'zTXt',
  'iTXt',
  'eXIf',
  'iCCP',
  'acTL',
  'fcTL',
  'fdAT',
]);

export class CustomProviderIconValidationError extends Error {
  readonly code = 'INVALID_CUSTOM_PROVIDER_ICON';

  constructor(message: string) {
    super(message);
    this.name = 'CustomProviderIconValidationError';
  }
}

function validationError(message: string): never {
  throw new CustomProviderIconValidationError(message);
}

function providerIconsRoot(): string {
  const dataRoot = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return resolve(dataRoot, 'provider-icons');
}

function validateProviderId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    return validationError('Custom provider id must be a bounded, non-empty opaque string');
  }
  return value;
}

function validateAssetId(value: unknown, label = 'Custom provider icon asset id'): string {
  if (typeof value !== 'string' || !ASSET_ID_PATTERN.test(value)) {
    return validationError(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function validateShape(value: unknown): CustomProviderIconShape {
  if (value !== 'rounded-square' && value !== 'circle') {
    return validationError('Custom provider icon shape must be rounded-square or circle');
  }
  return value;
}

function validateContentType(value: unknown): 'image/png' {
  if (typeof value !== 'string' || value.trim().toLowerCase() !== 'image/png') {
    return validationError('Custom provider icons must use the image/png content type');
  }
  return 'image/png';
}

function validateBytes(value: unknown): Buffer {
  let bytes: Buffer;
  if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value);
  } else {
    return validationError('Custom provider icon bytes are required');
  }
  if (bytes.length === 0 || bytes.length > CUSTOM_PROVIDER_ICON_MAX_BYTES) {
    return validationError(
      `Custom provider icon must be between 1 and ${CUSTOM_PROVIDER_ICON_MAX_BYTES} bytes`,
    );
  }
  return bytes;
}

let crcTable: Uint32Array | undefined;

function pngCrc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < crcTable.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertValidPng(bytes: Buffer): void {
  if (bytes.length < 57 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    validationError('Custom provider icon is not a valid PNG');
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) validationError('Custom provider icon PNG is truncated');
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) {
      validationError('Custom provider icon PNG contains an invalid chunk length');
    }

    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) {
      validationError('Custom provider icon PNG contains an invalid chunk type');
    }
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = pngCrc32(bytes.subarray(typeStart, dataEnd));
    if (expectedCrc !== actualCrc) {
      validationError('Custom provider icon PNG failed its integrity check');
    }

    chunkCount += 1;
    if (chunkCount > 512) validationError('Custom provider icon PNG contains too many chunks');
    if (chunkCount === 1 && type !== 'IHDR') {
      validationError('Custom provider icon PNG must begin with IHDR');
    }
    if (FORBIDDEN_METADATA_CHUNKS.has(type)) {
      validationError('Custom provider icon PNG must not contain metadata or animation chunks');
    }
    if (type[0] === type[0]?.toUpperCase() && !ALLOWED_CRITICAL_CHUNKS.has(type)) {
      validationError('Custom provider icon PNG contains an unsupported critical chunk');
    }

    if (type === 'IHDR') {
      if (sawHeader || length !== 13) {
        validationError('Custom provider icon PNG has an invalid IHDR chunk');
      }
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      const interlace = bytes[dataStart + 12]!;
      const validBitDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        (colorType === 4 && [8, 16].includes(bitDepth)) ||
        (colorType === 6 && [8, 16].includes(bitDepth));
      if (width !== CUSTOM_PROVIDER_ICON_SIZE || height !== CUSTOM_PROVIDER_ICON_SIZE) {
        validationError(
          `Custom provider icon must be exactly ${CUSTOM_PROVIDER_ICON_SIZE}x${CUSTOM_PROVIDER_ICON_SIZE} pixels`,
        );
      }
      if (!validBitDepth || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
        validationError('Custom provider icon PNG uses an unsupported pixel format');
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      if (!sawHeader || sawEnd) validationError('Custom provider icon PNG chunks are out of order');
      sawImageData = true;
    } else if (type === 'IEND') {
      if (!sawImageData || sawEnd || length !== 0 || chunkEnd !== bytes.length) {
        validationError('Custom provider icon PNG has an invalid IEND chunk');
      }
      sawEnd = true;
    }

    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd) {
    validationError('Custom provider icon PNG is incomplete');
  }
}

function ownerHash(providerId: string): string {
  return createHash('sha256').update(providerId, 'utf8').digest('hex');
}

function revisionFor(bytes: Buffer, shape: CustomProviderIconShape): string {
  return createHash('sha256').update(bytes).update('\0').update(shape).digest('hex');
}

function assetDirectory(root: string, assetId: string): string {
  const target = resolve(root, assetId);
  if (dirname(target) !== root) {
    return validationError('Custom provider icon asset escaped its storage root');
  }
  return target;
}

async function assertRealOwnedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Custom provider icon storage contains an unsafe directory');
  }
  const currentUid = process.getuid?.();
  if (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('Custom provider icon storage has an unexpected owner');
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, content: Uint8Array | string): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(content);
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (process.platform !== 'win32' && metadata.nlink !== 1) ||
      (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) ||
      metadata.size < 1 ||
      metadata.size > maxBytes
    ) {
      throw new Error('Custom provider icon storage contains an unsafe file');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseManifest(bytes: Buffer): StoredManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Custom provider icon metadata is corrupt');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Custom provider icon metadata is corrupt');
  }
  const candidate = parsed as Partial<StoredManifest>;
  if (
    candidate.version !== 1 ||
    typeof candidate.ownerHash !== 'string' ||
    !SHA256_PATTERN.test(candidate.ownerHash) ||
    typeof candidate.revision !== 'string' ||
    !SHA256_PATTERN.test(candidate.revision) ||
    (candidate.shape !== 'rounded-square' && candidate.shape !== 'circle') ||
    candidate.contentType !== 'image/png'
  ) {
    throw new Error('Custom provider icon metadata is corrupt');
  }
  return candidate as StoredManifest;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function loadManifest(root: string, assetId: string): Promise<StoredManifest | undefined> {
  try {
    await assertRealOwnedDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const directory = assetDirectory(root, assetId);
  try {
    await assertRealOwnedDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseManifest(await readPrivateFile(join(directory, MANIFEST_FILE), MAX_MANIFEST_BYTES));
}

/**
 * Store a browser-normalized, static 256x256 PNG. Provider ids never become
 * file names: a one-way owner digest in the private manifest binds each random
 * asset to its provider without leaking that identifier into the directory.
 */
export async function storeCustomProviderIcon(
  input: StoreCustomProviderIconInput,
): Promise<CustomProviderIconMetadata> {
  const providerId = validateProviderId(input.providerId);
  const bytes = validateBytes(input.bytes);
  const contentType = validateContentType(input.contentType);
  const shape = validateShape(input.shape);
  const previousAssetId =
    input.previousAssetId === undefined || input.previousAssetId === null
      ? undefined
      : validateAssetId(input.previousAssetId, 'Previous custom provider icon asset id');
  assertValidPng(bytes);

  const assetId = randomUUID();
  const revision = revisionFor(bytes, shape);
  const metadata: CustomProviderIconMetadata = { assetId, revision, shape };
  const manifest: StoredManifest = {
    version: 1,
    ownerHash: ownerHash(providerId),
    revision,
    shape,
    contentType,
  };
  const root = providerIconsRoot();
  ensureSecureDir(root);
  const finalDirectory = assetDirectory(root, assetId);
  const stagingDirectory = resolve(root, `.${assetId}.${randomUUID()}.tmp`);
  if (dirname(stagingDirectory) !== root) {
    throw new Error('Custom provider icon staging path escaped its storage root');
  }

  let finalized = false;
  try {
    await mkdir(stagingDirectory, { mode: 0o700 });
    await writePrivateFile(join(stagingDirectory, ICON_FILE), bytes);
    await writePrivateFile(join(stagingDirectory, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
    await syncDirectory(stagingDirectory);
    await rename(stagingDirectory, finalDirectory);
    finalized = true;
    await syncDirectory(root);
  } catch (error) {
    await rm(finalized ? finalDirectory : stagingDirectory, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw error;
  }

  if (previousAssetId && previousAssetId !== assetId) {
    try {
      await deleteCustomProviderIcon(providerId, previousAssetId);
    } catch (error) {
      await deleteCustomProviderIcon(providerId, assetId).catch(() => undefined);
      throw error;
    }
  }

  return metadata;
}

/** Read an owned asset without following symlinks or trusting persisted paths. */
export async function readCustomProviderIcon(
  providerIdInput: unknown,
  assetIdInput: unknown,
): Promise<StoredCustomProviderIcon | undefined> {
  const providerId = validateProviderId(providerIdInput);
  const assetId = validateAssetId(assetIdInput);
  const root = providerIconsRoot();
  const manifest = await loadManifest(root, assetId);
  if (!manifest || !hashesEqual(manifest.ownerHash, ownerHash(providerId))) return undefined;

  const bytes = await readPrivateFile(
    join(assetDirectory(root, assetId), ICON_FILE),
    CUSTOM_PROVIDER_ICON_MAX_BYTES,
  );
  assertValidPng(bytes);
  const revision = revisionFor(bytes, manifest.shape);
  if (!hashesEqual(revision, manifest.revision)) {
    throw new Error('Custom provider icon content failed its integrity check');
  }

  return {
    bytes,
    contentType: manifest.contentType,
    etag: `"${manifest.revision}"`,
    metadata: {
      assetId,
      revision: manifest.revision,
      shape: manifest.shape,
    },
  };
}

/**
 * Atomically remove an owned asset from the live namespace before deleting its
 * bytes. A missing or differently-owned asset is deliberately indistinguishable.
 */
export async function deleteCustomProviderIcon(
  providerIdInput: unknown,
  assetIdInput: unknown,
): Promise<boolean> {
  const providerId = validateProviderId(providerIdInput);
  const assetId = validateAssetId(assetIdInput);
  const root = providerIconsRoot();
  const manifest = await loadManifest(root, assetId);
  if (!manifest || !hashesEqual(manifest.ownerHash, ownerHash(providerId))) return false;

  const directory = assetDirectory(root, assetId);
  const tombstone = resolve(root, `.${assetId}.${randomUUID()}.deleted`);
  if (dirname(tombstone) !== root) {
    throw new Error('Custom provider icon deletion path escaped its storage root');
  }
  try {
    await rename(directory, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await syncDirectory(root);
  await rm(tombstone, { recursive: true });
  await syncDirectory(root);
  return true;
}
