import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateTmpNativeReadDecision } from '../mcp-bridge';

const base = mkdtempSync(join(tmpdir(), 'kory-private-tmp-read-'));
const privateTmp = join(base, 'jail', '.tmp');
const outside = join(base, 'project');
mkdirSync(join(privateTmp, 'devin-overflows-501', 'abc'), { recursive: true });
mkdirSync(outside, { recursive: true });
const overflow = join(privateTmp, 'devin-overflows-501', 'abc', 'content.txt');
writeFileSync(overflow, 'tool list');
writeFileSync(join(outside, 'secret.txt'), 'outside');
symlinkSync(join(outside, 'secret.txt'), join(privateTmp, 'escape.txt'));

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('privateTmpNativeReadDecision', () => {
  test('approves a native read of the CLI turn own private temp output', () => {
    expect(
      privateTmpNativeReadDecision('read', { file_path: overflow }, [privateTmp]),
    ).toMatchObject({ decision: 'approve' });
    expect(privateTmpNativeReadDecision('Grep', { path: privateTmp }, [privateTmp])?.decision).toBe(
      'approve',
    );
  });

  test('falls through for paths outside the private temp, relative paths, and links out', () => {
    expect(
      privateTmpNativeReadDecision('read', { file_path: join(outside, 'secret.txt') }, [
        privateTmp,
      ]),
    ).toBeNull();
    expect(
      privateTmpNativeReadDecision('read', { file_path: 'devin-overflows-501/abc/content.txt' }, [
        privateTmp,
      ]),
    ).toBeNull();
    expect(
      privateTmpNativeReadDecision('read', { file_path: join(privateTmp, 'escape.txt') }, [
        privateTmp,
      ]),
    ).toBeNull();
    expect(
      privateTmpNativeReadDecision(
        'read',
        { file_path: overflow, path: join(outside, 'secret.txt') },
        [privateTmp],
      ),
    ).toBeNull();
  });

  test('never approves shell or write tools, and needs a registered root', () => {
    expect(
      privateTmpNativeReadDecision('exec', { command: `cat ${overflow}` }, [privateTmp]),
    ).toBeNull();
    expect(privateTmpNativeReadDecision('Write', { file_path: overflow }, [privateTmp])).toBeNull();
    expect(privateTmpNativeReadDecision('read', { file_path: overflow }, [])).toBeNull();
  });
});
