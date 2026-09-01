import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCliAccounts, resetCliAccountJsonCacheForTests } from '../cli-accounts';
import { serverLog } from '../../logger';

const roots: string[] = [];

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

afterEach(() => {
  resetCliAccountJsonCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI account autodetection', () => {
  test('keeps numbered Codex homes separate without trusting unsigned account claims', () => {
    const home = join(tmpdir(), `kory-cli-accounts-${crypto.randomUUID()}`);
    roots.push(home);
    const future = Math.floor(Date.now() / 1000) + 3600;
    const profiles = [
      ['.codex', 'personal@example.com', 'plus'],
      ['.codex2', 'work@example.com', 'pro'],
    ] as const;
    for (const [dir, email, plan] of profiles) {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(
        join(home, dir, 'auth.json'),
        JSON.stringify({
          tokens: {
            access_token: jwt({ exp: future }),
            id_token: jwt({
              email,
              exp: future,
              'https://api.openai.com/auth': { chatgpt_plan_type: plan },
            }),
            refresh_token: 'must-never-be-returned',
          },
        }),
      );
    }

    const accounts = discoverCliAccounts(home).filter((account) => account.provider === 'codex');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.email)).toEqual([null, null]);
    expect(accounts.map((account) => account.plan)).toEqual([null, null]);
    expect(accounts.map((account) => account.label).sort()).toEqual(['codex', 'codex 2']);
    expect(accounts.every((account) => account.health === 'unknown')).toBe(true);
    expect(accounts.every((account) => account.expiresAt === null)).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain('personal@example.com');
    expect(JSON.stringify(accounts)).not.toContain('work@example.com');
    expect(JSON.stringify(accounts)).not.toContain('"plan":"plus"');
    expect(JSON.stringify(accounts)).not.toContain('"plan":"pro"');
    expect(JSON.stringify(accounts)).not.toContain('must-never-be-returned');
  });

  test('reports a malformed account file once per filesystem revision', () => {
    const home = join(tmpdir(), `kory-cli-accounts-${crypto.randomUUID()}`);
    roots.push(home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    const authFile = join(home, '.codex', 'auth.json');
    writeFileSync(authFile, '{broken');
    const debug = spyOn(serverLog, 'debug').mockImplementation(() => serverLog);

    discoverCliAccounts(home);
    discoverCliAccounts(home);

    const malformed = debug.mock.calls.filter(
      (call) => call[1] === 'cli-accounts: account JSON is malformed',
    );
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.[0]).toEqual({
      fileName: 'auth.json',
      bytes: 7,
      errorType: 'SyntaxError',
    });
    expect(JSON.stringify(malformed)).not.toContain('{broken');

    writeFileSync(authFile, JSON.stringify({ repaired: true }));
    discoverCliAccounts(home);
    expect(
      debug.mock.calls.filter((call) => call[1] === 'cli-accounts: account JSON is malformed'),
    ).toHaveLength(1);
    debug.mockRestore();
  });

  test('never reports non-JSON credential formats as malformed', () => {
    const home = join(tmpdir(), `kory-cli-accounts-${crypto.randomUUID()}`);
    roots.push(home);
    mkdirSync(join(home, '.local', 'share', 'devin'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'devin', 'credentials.toml'),
      '[oauth]\ntoken = "x"\n',
    );
    const debug = spyOn(serverLog, 'debug').mockImplementation(() => serverLog);

    const accounts = discoverCliAccounts(home);
    const devin = accounts.filter((account) => account.provider === 'devin');
    expect(devin.length).toBeGreaterThan(0);
    expect(
      debug.mock.calls.filter((call) => call[1] === 'cli-accounts: account JSON is malformed'),
    ).toHaveLength(0);
    debug.mockRestore();
  });
});
