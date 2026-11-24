#!/usr/bin/env bun
/**
 * Builds the macOS window and input helper used by the native desktop evaluation driver.
 *
 * The driver runs inside the candidate sandbox, where Apple Events are refused. The helper speaks
 * Accessibility, the window server, and directed input instead, so it is compiled from the Swift
 * source next to this script into a stable cache location rather than a temporary directory that
 * disappears mid campaign.
 *
 * Usage: bun run scripts/build-kory-macos-window-helper.ts [--out=<path>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const source = join(import.meta.dir, 'kory-macos-window-helper.swift');
if (!existsSync(source)) throw new Error(`Missing helper source at ${source}`);

const requested = process.argv
  .find((argument) => argument.startsWith('--out='))
  ?.slice('--out='.length);
const out = requested?.trim() || join(homedir(), '.koryphaios', 'bin', 'kory-macos-window-helper');
mkdirSync(join(out, '..'), { recursive: true });

const developerDir =
  process.env.DEVELOPER_DIR?.trim() ?? '/Applications/Xcode-beta.app/Contents/Developer';
const moduleCache = mkdtempSync(join(tmpdir(), 'kory-helper-modc-'));
try {
  execFileSync('/usr/bin/swiftc', ['-O', '-module-cache-path', moduleCache, source, '-o', out], {
    env: {
      ...process.env,
      DEVELOPER_DIR: existsSync(developerDir) ? developerDir : (process.env.DEVELOPER_DIR ?? ''),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} finally {
  rmSync(moduleCache, { recursive: true, force: true });
}
console.log(out);
