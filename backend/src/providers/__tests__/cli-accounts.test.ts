import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCliAccounts } from '../cli-accounts';

const roots: string[] = [];

function jwt(payload: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CLI account autodetection', () => {
  test('keeps numbered Codex homes separate and exposes only safe identity metadata', () => {
    const home = join(tmpdir(), `kory-cli-accounts-${crypto.randomUUID()}`);
    roots.push(home);
    const future = Math.floor(Date.now() / 1000) + 3600;
    const profiles = [
      ['.codex', 'personal@example.com', 'plus'],
      ['.codex2', 'work@example.com', 'pro'],
    ] as const;
    for (const [dir, email, plan] of profiles) {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, dir, 'auth.json'), JSON.stringify({
        tokens: {
          access_token: jwt({ exp: future }),
          id_token: jwt({
            email,
            exp: future,
            'https://api.openai.com/auth': { chatgpt_plan_type: plan },
          }),
          refresh_token: 'must-never-be-returned',
        },
      }));
    }

    const accounts = discoverCliAccounts(home).filter((account) => account.provider === 'codex');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.email).sort()).toEqual([
      'personal@example.com',
      'work@example.com',
    ]);
    expect(accounts.map((account) => account.plan).sort()).toEqual(['plus', 'pro']);
    expect(accounts.every((account) => account.health === 'ready')).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain('must-never-be-returned');
  });
});

