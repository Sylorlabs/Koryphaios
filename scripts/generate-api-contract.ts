#!/usr/bin/env bun
// Regenerates the API contract from the backend's real route table.
//
//   bun run api:generate   write openapi.json and shared/src/api/generated-client.ts
//   bun run api:check      render in memory and fail if the committed files differ
//
// The route table comes from the same Elysia plugins `backend/src/server.ts`
// mounts. Importing them opens the database module, so this script points the
// process at a throwaway SQLite file before loading anything (the same
// isolation the backend test runner uses). Nothing under ./data is touched.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const checkOnly = process.argv.includes('--check');

function isolateProcessEnvironment(): () => void {
  const scratch = mkdtempSync(join(tmpdir(), 'kory-api-contract-'));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET,
  };
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `sqlite://${join(scratch, 'api-contract.sqlite')}`;
  process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  };
}

async function main(): Promise<number> {
  const cleanup = isolateProcessEnvironment();
  let files: Record<string, string>;
  try {
    const { renderApiContract } = await import('../backend/src/api-contract/render');
    files = await renderApiContract();
  } finally {
    cleanup();
  }

  if (checkOnly) {
    const stale = Object.keys(files)
      .sort()
      .filter((path) => {
        const full = join(ROOT, path);
        return !existsSync(full) || readFileSync(full, 'utf8') !== files[path];
      });
    if (stale.length > 0) {
      console.error('API contract is stale. Run `bun run api:generate` and commit the result:');
      for (const path of stale) console.error(`  ${path}`);
      return 1;
    }
    console.log(`API contract is up to date (${Object.keys(files).length} files).`);
    return 0;
  }

  for (const [path, text] of Object.entries(files)) {
    const full = join(ROOT, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
    console.log(`wrote ${path}`);
  }
  return 0;
}

process.exitCode = await main();
