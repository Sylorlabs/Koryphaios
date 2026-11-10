import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCreditDb, getUsageSamplesByProvider, initCreditDb, recordUsage } from './db';

const root = mkdtempSync(join(tmpdir(), 'freebuff-attribution-'));
const provider = 'freebuff-attribution-fixture';
afterAll(() => {
  getCreditDb().run('DELETE FROM credit_usage WHERE provider = ?', [provider]);
  rmSync(root, { recursive: true, force: true });
});
test('separates CLI account usage and admits legacy unattributed rows only when requested', () => {
  initCreditDb(root);
  recordUsage('freebuff/cli-default', provider, 100, 0, 0, { accountId: 'account-a' });
  recordUsage('freebuff/cli-default', provider, 200, 0, 0, { accountId: 'account-b' });
  recordUsage('freebuff/cli-default', provider, 50, 0, 0);
  expect(
    getUsageSamplesByProvider(provider, 0, { accountId: 'account-a' }).map((row) => row.tokensIn),
  ).toEqual([100]);
  expect(
    getUsageSamplesByProvider(provider, 0, { accountId: 'account-b' }).map((row) => row.tokensIn),
  ).toEqual([200]);
  expect(
    getUsageSamplesByProvider(provider, 0, {
      accountId: 'account-a',
      includeUnattributed: true,
    }).map((row) => row.tokensIn),
  ).toEqual([100, 50]);
  expect(getUsageSamplesByProvider(provider, 0).map((row) => row.tokensIn)).toEqual([100, 200, 50]);
});
