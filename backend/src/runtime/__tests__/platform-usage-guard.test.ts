/**
 * Guard: `process.platform` may only be read by `runtime/platform.ts`.
 *
 * AGENTS.md makes `backend/src/runtime/platform.ts` the single place that asks
 * which OS the server runs on. A new inline read reintroduces the drift the
 * module exists to prevent, so this test scans backend/src and fails on any
 * occurrence outside the explicit allowlist below. The allowlist covers only the
 * documented exceptions: injection seams whose parameter *defaults* to
 * `process.platform`. Tests and `__tests__` support code are out of scope.
 */
import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const BACKEND_SRC = join(import.meta.dir, '..', '..');
const NEEDLE = 'process.platform';
const MODULE_EXEMPT = 'runtime/platform.ts';

/**
 * Documented exceptions: a parameter or dependency default that injects the
 * host platform as a test seam. Each entry is the exact trimmed line and how
 * many times it may occur in that file.
 */
const ALLOWED: ReadonlyArray<{ file: string; line: string; count: number }> = [
  {
    file: 'security/resource-limits.ts',
    line: 'platform: NodeJS.Platform = process.platform,',
    count: 2,
  },
  {
    file: 'providers/freebuff-credentials.ts',
    line: 'platform: NodeJS.Platform = process.platform,',
    count: 1,
  },
  {
    file: 'providers/freebuff-credentials.ts',
    line: 'dependencies: FreebuffCredentialDependencies = { platform: process.platform, execFile },',
    count: 1,
  },
  {
    file: 'kory/skill-eval-bun-runtime-fixtures.ts',
    line: 'platform: string = process.platform,',
    count: 1,
  },
  {
    file: 'eval/skills/skill-eval-bun-runtime-fixtures.ts',
    line: 'platform: string = process.platform,',
    count: 1,
  },
];

function isExcludedPath(rel: string): boolean {
  return rel.endsWith('.test.ts') || rel.split(sep).includes('__tests__');
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Returns `file: trimmed line` for every non-allowlisted occurrence. */
function findViolations(root: string = BACKEND_SRC): string[] {
  const violations: string[] = [];
  const allowance = new Map<string, number>();
  for (const entry of ALLOWED) {
    const key = `${entry.file}\u0000${entry.line}`;
    allowance.set(key, (allowance.get(key) ?? 0) + entry.count);
  }
  for (const full of listSourceFiles(root)) {
    const rel = relative(root, full).split(sep).join('/');
    if (rel === MODULE_EXEMPT || isExcludedPath(rel)) continue;
    const lines = readFileSync(full, 'utf8').split('\n');
    for (const raw of lines) {
      if (!raw.includes(NEEDLE)) continue;
      const line = raw.trim();
      const key = `${rel}\u0000${line}`;
      const remaining = allowance.get(key) ?? 0;
      if (remaining > 0) {
        allowance.set(key, remaining - 1);
        continue;
      }
      violations.push(`${rel}: ${line}`);
    }
  }
  return violations;
}

describe('process.platform is read only by runtime/platform.ts', () => {
  it('has no inline OS reads in backend/src outside the documented exceptions', () => {
    expect(findViolations()).toEqual([]);
  });

  it('flags a new inline read, and not an allowlisted seam or a test file', () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-guard-'));
    try {
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'security'), { recursive: true });
      writeFileSync(join(root, 'routes', 'bad.ts'), "if (process.platform === 'darwin') {}\n");
      writeFileSync(join(root, 'routes', 'bad.test.ts'), "if (process.platform === 'darwin') {}\n");
      writeFileSync(
        join(root, 'security', 'resource-limits.ts'),
        '  platform: NodeJS.Platform = process.platform,\n  platform: NodeJS.Platform = process.platform,\n',
      );
      expect(findViolations(root)).toEqual([
        "routes/bad.ts: if (process.platform === 'darwin') {}",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
