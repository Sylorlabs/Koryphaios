import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SkillEvalScenarioV3 } from '../../eval/skills/skill-eval-harness';
import { hasRegressionText } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  PILOT_SKILL_EVAL_MATERIALIZERS,
  PILOT_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-pilot-fixtures';

const scenario = { id: 'application-security-full-task-2' } as SkillEvalScenarioV3;
const materializer = PILOT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
const scorer = PILOT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenario.id))!;

// Deterministic scorer controls, not candidate execution or promotion evidence.
const source = `import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export function parseCommand(raw: string) {
  if (Buffer.byteLength(raw) > 8192) throw new Error('Invalid command');
  const v = JSON.parse(raw);
  if (!v || v.version !== 1 || v.op !== 'sync' || typeof v.accountId !== 'string' || !v.accountId || v.accountId.length > 128 || Object.keys(v).length !== 3) throw new Error('Invalid command');
  return v;
}
export function resolveAuthorizedPath(root: string, requested: string) {
  const target = realpathSync(resolve(root, requested));
  const rel = relative(realpathSync(root), target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Outside root');
  return target;
}
export function restoreQueue(raw: string) {
  const v = JSON.parse(raw);
  if (!Array.isArray(v) || v.some(e => !e || e.version !== 1 || e.op !== 'sync' || typeof e.id !== 'string')) throw new Error('Invalid queue');
  return v;
}
export function serializeSession(s: any) { return JSON.stringify({ credentialHandle: s.credentialHandle }); }
export function redactDiagnostic(s: string) { return s.replace(/\\b(?:access_token|refresh)=[^\\s]+/g, '[redacted]').replace(/[\\u0000-\\u001f]/g, ''); }
export function canExportRecovery(s: any, now: number) { return !s.revoked && s.expiresAt > now && s.reauthenticatedAt !== null && now >= s.reauthenticatedAt && now - s.reauthenticatedAt <= 60000; }
`;
const imports = `import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseCommand, resolveAuthorizedPath, canExportRecovery } from '../src/security';
`;
// Mirrors the observed test's vocabulary and real negative assertions, without
// requiring the candidate to name a test after the scorer's keyword list.
const commandTest = `test('commands have exact typed shapes and bounded input', () => {
  expect(() => parseCommand('{"version":1,"op":"delete-all"}')).toThrow('Invalid command');
  expect(() => parseCommand('{"version":1,"op":"export-recovery","admin":true}')).toThrow('Invalid command');
  expect(() => parseCommand(JSON.stringify({ version: 1, op: 'sync', accountId: 'a'.repeat(129) }))).toThrow('Invalid command');
  expect(() => parseCommand(' '.repeat(8193))).toThrow('Invalid command');
});
`;
const pathTest = `test('canonical path denies escape', () => {
  expect(() => resolveAuthorizedPath(join(process.cwd(), 'authorized'), '/etc/passwd')).toThrow();
});
`;
const sessionTest = `test('expired and revoked sessions cannot export', () => {
  expect(canExportRecovery({ expiresAt: 0, revoked: false, reauthenticatedAt: 0 }, 1)).toBe(false);
  expect(canExportRecovery({ expiresAt: 2, revoked: true, reauthenticatedAt: 0 }, 1)).toBe(false);
});
`;

async function scoreControl(tests: string, implementation = source) {
  const root = mkdtempSync(join(tmpdir(), 'kory-appsec-coverage-'));
  try {
    await materializer.materialize(root, scenario);
    writeFileSync(join(root, 'src/security.ts'), implementation);
    writeFileSync(join(root, 'tests/security.test.ts'), imports + tests);
    return await scorer.score({ workingDirectory: root } as Parameters<typeof scorer.score>[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('desktop coverage accepts invalid-command rejection assertions', async () => {
  const result = await scoreControl(commandTest + pathTest + sessionTest);
  expect(result.evidence).toContain('hidden behavior checks: pass');
  expect(result.evidence).toContain('desktop trust-boundary regression coverage: present');
  expect(result.passed).toBe(true);
});

for (const [category, tests] of [
  ['command', pathTest + sessionTest],
  ['path', commandTest + sessionTest],
  ['session', commandTest + pathTest],
] as const) {
  test(`desktop coverage still requires ${category} regressions`, async () => {
    const result = await scoreControl(tests);
    expect(result.evidence).toContain('hidden behavior checks: pass');
    expect(result.evidence).toContain('desktop trust-boundary regression coverage: missing');
    expect(result.passed).toBe(false);
  });
}

test('desktop coverage cannot override a redaction failure', async () => {
  const result = await scoreControl(
    commandTest + pathTest + sessionTest,
    source.replace('(?:access_token|refresh)', '(?:access_token)'),
  );
  expect(result.evidence).toContain('desktop trust-boundary regression coverage: present');
  expect(result.evidence).toContain('hidden behavior checks: fail');
  expect(result.passed).toBe(false);
});

test('desktop coverage cannot override a failing public assertion', async () => {
  const result = await scoreControl(
    commandTest + pathTest + sessionTest + `test('failing control', () => expect(1).toBe(2));`,
  );
  expect(result.evidence).toContain('desktop trust-boundary regression coverage: present');
  expect(result.evidence.join('\n')).toContain('Public tests: failed');
  expect(result.passed).toBe(false);
});

const archived = resolve(
  import.meta.dir,
  '../../../../.koryphaios/skills/eval-artifacts/application-security-full-task-2_40d2f435-83af-4d97-a12b-6a2eb0561fe5/with-skill',
);
// Saved files remain read-only. Missing local archives are explicit skips; the
// portable controls above still run. Re-scoring is diagnostic, never a new pair.
const replay = existsSync(join(archived, 'run-manifest.json')) ? test : test.skip;
replay('saved 5.1.6 desktop candidate reproduces the coverage false negative', async () => {
  const manifestBytes = readFileSync(join(archived, 'run-manifest.json'));
  expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(
    '6e6bea3547466264f30a26d576f4b6f0c0e79ed9faff5c3d1b66421efba36f27',
  );
  const manifest = JSON.parse(manifestBytes.toString());
  expect(manifest.score.passed).toBe(false);
  expect(manifest.score.evidence).toContain('desktop trust-boundary regression coverage: missing');
  const root = mkdtempSync(join(tmpdir(), 'kory-appsec-recorded-'));
  try {
    await materializer.materialize(root, scenario);
    for (const path of ['src/security.ts', 'tests/security.test.ts']) {
      const bytes = readFileSync(join(archived, 'files', path));
      const change = manifest.changes.find((entry: { path: string }) => entry.path === path);
      expect(createHash('sha256').update('file\0').update(bytes).digest('hex')).toBe(
        change.afterSha256,
      );
      writeFileSync(join(root, path), bytes);
    }
    expect(hasRegressionText(root, [/malformed|unknown|payload|schema/i])).toBe(false);
    const result = await scorer.score({ workingDirectory: root } as Parameters<
      typeof scorer.score
    >[0]);
    expect(result.evidence).toContain('hidden behavior checks: pass');
    expect(result.passed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
