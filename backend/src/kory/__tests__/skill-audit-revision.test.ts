import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_SKILL_DEFINITIONS,
  V5_SKILL_PACKAGE_CATALOG,
  auditBundledSkillDefinitions,
} from '../skills';
import { getV5AuditLedgerPath, syncV5AuditLedger, updateV5AuditRecord } from '../skill-v5-audit';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const name = 'skill-authoring-evaluation';
const packages = V5_SKILL_PACKAGE_CATALOG.packages;
const original = packages.find((item) => item.sidecar.name === name)!;
const counts = auditBundledSkillDefinitions();
const options = {
  baseCount: counts.baseCount,
  professionalCount: counts.professionalCount,
  now: new Date('2026-09-06T12:00:00Z'),
};
function initialized() {
  const root = mkdtempSync(join(tmpdir(), 'kory-audit-revision-'));
  roots.push(root);
  syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, packages, options);
  updateV5AuditRecord(
    root,
    name,
    {
      v5Status: 'qualified',
      fullTaskEvals: 2,
      openRegressions: 1,
      uplift: { passRateDelta: 0.2, qualityDelta: 0.1, verificationDelta: 0.1 },
      nextAction: 'A historical qualified result, not evidence for a future rewrite.',
    },
    options.now,
  );
  return root;
}

describe('revision-bound skill audit evidence', () => {
  test('does not carry qualification or uplift into an unchanged-version instruction edit', () => {
    const root = initialized();
    const changed = {
      ...original,
      sourceContent: original.sourceContent + '\nAn additional scoped instruction.\n',
    };
    const ledger = syncV5AuditLedger(
      root,
      BUNDLED_SKILL_DEFINITIONS,
      packages.map((item) => (item === original ? changed : item)),
      options,
    );
    expect(ledger.records.find((item) => item.skill === name)).toMatchObject({
      v5Status: 'blocked',
      fullTaskEvals: 0,
      uplift: null,
      openRegressions: 1,
    });
  });

  test('invalidates changed task contracts and semantic versions without deleting regressions', () => {
    for (const changed of [
      { ...original, sidecar: { ...original.sidecar, version: '5.99.0' } },
      {
        ...original,
        evaluation: {
          ...original.evaluation,
          tasks: original.evaluation.tasks.map((task, index) =>
            index === 0
              ? { ...task, prompt: task.prompt + ' Preserve the additional recorded invariant.' }
              : task,
          ),
        },
      },
    ]) {
      const root = initialized();
      const record = syncV5AuditLedger(
        root,
        BUNDLED_SKILL_DEFINITIONS,
        packages.map((item) => (item === original ? changed : item)),
        options,
      ).records.find((item) => item.skill === name)!;
      expect(record.v5Status).not.toBe('qualified');
      expect(record.fullTaskEvals).toBe(0);
      expect(record.uplift).toBeNull();
      expect(record.openRegressions).toBe(1);
    }
  });

  test('a changed supporting reference invalidates qualification even when the entrypoint is identical', () => {
    const root = initialized();
    const directory = join(root, 'package-copy');
    cpSync(original.directory, directory, { recursive: true });
    const resource = join(directory, 'references/sources.md');
    writeFileSync(
      resource,
      readFileSync(resource, 'utf8') + '\nA material source applicability correction.\n',
    );
    const changed = { ...original, directory };
    const record = syncV5AuditLedger(
      root,
      BUNDLED_SKILL_DEFINITIONS,
      packages.map((item) => (item === original ? changed : item)),
      options,
    ).records.find((item) => item.skill === name)!;
    expect(record.v5Status).not.toBe('qualified');
    expect(record.uplift).toBeNull();
  });

  test('legacy unbound successes and missing packages do not stay qualified', () => {
    const root = initialized();
    const path = getV5AuditLedgerPath(root);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    for (const record of data.records) delete record.packageFingerprint;
    writeFileSync(path, JSON.stringify(data));
    expect(
      syncV5AuditLedger(root, BUNDLED_SKILL_DEFINITIONS, packages, options).records.find(
        (item) => item.skill === name,
      )!.v5Status,
    ).not.toBe('qualified');
    const missingRoot = initialized();
    expect(
      syncV5AuditLedger(
        missingRoot,
        BUNDLED_SKILL_DEFINITIONS,
        packages.filter((item) => item !== original),
        options,
      ).records.find((item) => item.skill === name),
    ).toMatchObject({
      v5Status: 'unreviewed',
      packageVersion: null,
      fullTaskEvals: 0,
      uplift: null,
      openRegressions: 1,
    });
  });

  test('a truly unchanged package preserves its evidence and retired decisions remain explicit', () => {
    const root = initialized();
    const record = syncV5AuditLedger(
      root,
      BUNDLED_SKILL_DEFINITIONS,
      packages,
      options,
    ).records.find((item) => item.skill === name)!;
    expect(record).toMatchObject({ v5Status: 'qualified', fullTaskEvals: 2, openRegressions: 1 });
    updateV5AuditRecord(root, name, { v5Status: 'retired' }, options.now);
    const changed = {
      ...original,
      sourceContent: original.sourceContent + '\nChanged while retired.\n',
    };
    expect(
      syncV5AuditLedger(
        root,
        BUNDLED_SKILL_DEFINITIONS,
        packages.map((item) => (item === original ? changed : item)),
        options,
      ).records.find((item) => item.skill === name)!.v5Status,
    ).toBe('retired');
  });
});
