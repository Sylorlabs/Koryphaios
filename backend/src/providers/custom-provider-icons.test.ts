import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CUSTOM_PROVIDER_ICON_MAX_BYTES,
  CustomProviderIconValidationError,
  deleteCustomProviderIcon,
  readCustomProviderIcon,
  storeCustomProviderIcon,
} from './custom-provider-icons';

const originalDataDirectory = process.env.KORYPHAIOS_DATA_DIR;
let dataDirectory = '';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return output;
}

function png(width = 256, height = 256): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (1 + width * 4)] = 0;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function iconRoot(): string {
  return join(dataDirectory, 'provider-icons');
}

beforeEach(() => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'kory-provider-icons-'));
  process.env.KORYPHAIOS_DATA_DIR = dataDirectory;
});

afterEach(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
  if (originalDataDirectory === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = originalDataDirectory;
});

describe('custom provider icon storage', () => {
  test('stores and reads a private, owner-bound PNG with a strong ETag', async () => {
    const source = png();
    const metadata = await storeCustomProviderIcon({
      providerId: 'custom:seekai',
      bytes: source,
      contentType: 'image/png',
      shape: 'circle',
    });

    expect(metadata.assetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.shape).toBe('circle');

    const assetDirectory = join(iconRoot(), metadata.assetId);
    expect(lstatSync(iconRoot()).mode & 0o777).toBe(0o700);
    expect(lstatSync(assetDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(assetDirectory, 'icon.png')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(assetDirectory, 'metadata.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(assetDirectory, 'metadata.json'), 'utf8')).not.toContain(
      'custom:seekai',
    );

    const stored = await readCustomProviderIcon('custom:seekai', metadata.assetId);
    expect(Buffer.from(stored!.bytes).equals(source)).toBe(true);
    expect(stored).toMatchObject({
      contentType: 'image/png',
      etag: `"${metadata.revision}"`,
      metadata,
    });
    expect(readdirSync(iconRoot()).every((entry) => !entry.startsWith('.'))).toBe(true);
  });

  test('rejects wrong MIME, malformed PNGs, wrong dimensions, and oversized input', async () => {
    const valid = png();
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: valid,
        contentType: 'image/jpeg',
        shape: 'rounded-square',
      }),
    ).rejects.toBeInstanceOf(CustomProviderIconValidationError);
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: Buffer.from('not png'),
        contentType: 'image/png',
        shape: 'rounded-square',
      }),
    ).rejects.toThrow('not a valid PNG');
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: png(255, 256),
        contentType: 'image/png',
        shape: 'rounded-square',
      }),
    ).rejects.toThrow('exactly 256x256');
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: Buffer.alloc(CUSTOM_PROVIDER_ICON_MAX_BYTES + 1),
        contentType: 'image/png',
        shape: 'rounded-square',
      }),
    ).rejects.toThrow(`${CUSTOM_PROVIDER_ICON_MAX_BYTES} bytes`);
    expect(existsSync(iconRoot())).toBe(false);
  });

  test('replaces an owned asset only after the new asset is durable', async () => {
    const first = await storeCustomProviderIcon({
      providerId: 'custom:lab',
      bytes: png(),
      contentType: 'image/png',
      shape: 'rounded-square',
    });
    const second = await storeCustomProviderIcon({
      providerId: 'custom:lab',
      bytes: png(),
      contentType: 'image/png',
      shape: 'circle',
      previousAssetId: first.assetId,
    });

    expect(second.assetId).not.toBe(first.assetId);
    expect(second.revision).not.toBe(first.revision);
    expect(await readCustomProviderIcon('custom:lab', first.assetId)).toBeUndefined();
    expect((await readCustomProviderIcon('custom:lab', second.assetId))?.metadata.shape).toBe(
      'circle',
    );
    expect(readdirSync(iconRoot())).toEqual([second.assetId]);
  });

  test("does not disclose, read, or delete another provider owner's asset", async () => {
    const metadata = await storeCustomProviderIcon({
      providerId: 'custom:owner',
      bytes: png(),
      contentType: 'image/png',
      shape: 'rounded-square',
    });

    expect(await readCustomProviderIcon('custom:other', metadata.assetId)).toBeUndefined();
    expect(await deleteCustomProviderIcon('custom:other', metadata.assetId)).toBe(false);
    expect(existsSync(join(iconRoot(), metadata.assetId))).toBe(true);
    expect(await deleteCustomProviderIcon('custom:owner', metadata.assetId)).toBe(true);
    expect(await readCustomProviderIcon('custom:owner', metadata.assetId)).toBeUndefined();
  });

  test('rejects path-like identifiers and unsupported presentation shapes', async () => {
    const valid = png();
    await expect(readCustomProviderIcon('custom:test', '../../etc/passwd')).rejects.toThrow(
      'asset id is invalid',
    );
    await expect(
      storeCustomProviderIcon({
        providerId: ' custom:test',
        bytes: valid,
        contentType: 'image/png',
        shape: 'rounded-square',
      }),
    ).rejects.toThrow('opaque string');
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: valid,
        contentType: 'image/png',
        shape: 'hexagon',
      }),
    ).rejects.toThrow('rounded-square or circle');
    await expect(
      storeCustomProviderIcon({
        providerId: 'custom:test',
        bytes: valid,
        contentType: 'image/png',
        shape: 'circle',
        previousAssetId: '../previous',
      }),
    ).rejects.toThrow('asset id is invalid');
    expect(existsSync(iconRoot())).toBe(false);
  });

  if (process.platform !== 'win32') {
    test('refuses a symbolic-link asset without touching its target', async () => {
      const metadata = await storeCustomProviderIcon({
        providerId: 'custom:owner',
        bytes: png(),
        contentType: 'image/png',
        shape: 'rounded-square',
      });
      const outsideDirectory = mkdtempSync(join(tmpdir(), 'kory-provider-icon-outside-'));
      const sentinel = join(outsideDirectory, 'sentinel.txt');
      writeFileSync(sentinel, 'keep');
      rmSync(join(iconRoot(), metadata.assetId), { recursive: true });
      symlinkSync(outsideDirectory, join(iconRoot(), metadata.assetId), 'dir');

      try {
        await expect(readCustomProviderIcon('custom:owner', metadata.assetId)).rejects.toThrow(
          'unsafe directory',
        );
        await expect(deleteCustomProviderIcon('custom:owner', metadata.assetId)).rejects.toThrow(
          'unsafe directory',
        );
        expect(readFileSync(sentinel, 'utf8')).toBe('keep');
      } finally {
        rmSync(outsideDirectory, { recursive: true, force: true });
      }
    });
  }
});
