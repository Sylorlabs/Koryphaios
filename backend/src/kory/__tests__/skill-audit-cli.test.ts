import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadV5SkillPackages } from '../skill-packages';

describe('skill audit CLI output', () => {
  test('emits complete piped JSON before the readiness exit and keeps summaries consistent', () => {
    const script = resolve(
      import.meta.dir,
      '../../../../scripts/audit-skill-v5-execution-readiness.ts',
    );
    const reports = [[], ['--summary']].map((args) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        maxBuffer: 2_000_000,
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout);
      expect(result.status).toBe(report.blocked > 0 ? 1 : 0);
      expect(report.ready + report.blocked).toBe(report.scenarios);
      return report;
    });
    const expectedCount = loadV5SkillPackages().packages.reduce(
      (count, skill) => count + skill.evaluation.tasks.length,
      0,
    );
    expect(reports[0].scenarios).toBe(expectedCount);
    expect(reports[0].readyScenarios).toHaveLength(reports[0].ready);
    expect(reports[0].blockers).toHaveLength(reports[0].blocked);
    expect(reports[1]).toEqual({
      schemaVersion: 1,
      scenarios: expectedCount,
      ready: reports[0].ready,
      blocked: reports[0].blocked,
    });
  }, 45_000);
});
