import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAwsCredentialSources, hasAwsCredentialSource } from '../aws-credential-scan';

// The scanner reads ~/.aws/* under the real HOME. Isolate tests by overriding
// HOME so a developer's real AWS configuration is never inspected.
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    delete process.env[key];
  }
});

function isolatedHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kory-aws-scan-'));
}

describe('aws-credential-scan', () => {
  test('reports nothing when no env vars or AWS files exist', async () => {
    const dir = await isolatedHome();
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'credentials');
    process.env.AWS_CONFIG_FILE = join(dir, 'config');
    const scan = scanAwsCredentialSources();
    expect(scan.detected).toBe(false);
    expect(scan.sources).toEqual([]);
    expect(scan.description).toBe('');
    expect(hasAwsCredentialSource()).toBe(false);
  });

  test('detects environment variable credentials', async () => {
    process.env.HOME = await isolatedHome();
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    const scan = scanAwsCredentialSources();
    expect(scan.detected).toBe(true);
    expect(scan.description).toContain('environment variables');
    // Never returns the secret material.
    expect(scan.description).not.toContain('AKIA_TEST');
    expect(scan.description).not.toContain('secret');
  });

  test('detects ~/.aws/credentials profile without exposing its keys', async () => {
    const dir = await isolatedHome();
    const credFile = join(dir, 'credentials');
    process.env.AWS_SHARED_CREDENTIALS_FILE = credFile;
    await writeFile(
      credFile,
      '[default]\naws_access_key_id = AKIA_FROM_FILE\naws_secret_access_key = supersecret\n',
    );
    const scan = scanAwsCredentialSources();
    expect(scan.detected).toBe(true);
    expect(scan.sources.some((s) => s.kind === 'shared_credentials_file')).toBe(true);
    expect(scan.description).toContain('~/.aws/credentials');
    expect(scan.description).not.toContain('supersecret');
  });

  test('detects AWS_REGION round-trip into the description', async () => {
    process.env.HOME = await isolatedHome();
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_TEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_REGION = 'eu-central-1';
    const scan = scanAwsCredentialSources();
    expect(scan.detected).toBe(true);
    expect(scan.sources[0]?.region).toBe('eu-central-1');
  });
});