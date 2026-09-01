import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const sourceRoot = join(import.meta.dir, '..');

/**
 * drizzle-orm/bun-sqlite delegates to Database.transaction(), whose callback
 * is synchronous. An async callback returns a Promise to the driver, so SQLite
 * commits before the first awaited continuation runs. Keep this source-wide
 * guard next to the database bootstrap: code that reads as one transaction
 * must actually remain on the synchronous stack through commit.
 */
describe('Bun SQLite transaction contract', () => {
  test('never passes an async callback to a synchronous transaction driver', () => {
    const transactionCall = ['\\.transaction', '\\s*\\(', '\\s*async\\b'].join('');
    const prohibited = new RegExp(transactionCall, 'm');
    const offenders = readdirSync(sourceRoot, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith('.ts'))
      .map((path) => join(sourceRoot, path))
      .filter((path) => prohibited.test(readFileSync(path, 'utf8')))
      .map((path) => relative(sourceRoot, path))
      .sort();

    expect(offenders).toEqual([]);
  });
});
