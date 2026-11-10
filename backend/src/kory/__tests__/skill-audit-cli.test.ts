import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadV5SkillPackages } from '../skill-packages';

describe('skill audit CLI output', () => {
  test('independent routing covers personal host pins and rejects implicit personal selection', () => {
    const projectRoot = resolve(import.meta.dir, '../../../..');
    const skillsHome = mkdtempSync(resolve(projectRoot, '.tmp-independent-routing-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(projectRoot, 'scripts/evaluate-skill-v5-independent-routing.ts'),
          '--summary',
          '--skill=response-style',
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, KORYPHAIOS_SKILLS_HOME: skillsHome },
          encoding: 'utf8',
          maxBuffer: 2_000_000,
          timeout: 45_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.coveredSkills).toBe(182);
      expect(report.corpusCases).toBe(187);
      expect(report.cases).toBe(2);
      expect(report.failedCases).toBe(0);
      expect(report.expectedSkillRecall).toBe(1);
      expect(report.forbiddenSkillAvoidance).toBe(1);
    } finally {
      rmSync(skillsHome, { recursive: true, force: true });
    }
  }, 50_000);

  test('emits complete piped JSON before the readiness exit and keeps summaries consistent', () => {
    const script = resolve(
      import.meta.dir,
      '../../../../scripts/audit-skill-v5-execution-readiness.ts',
    );
    // Exercise the complete real catalog and readiness checks on a host with
    // no optional toolchains. Output/exit semantics must not depend on which
    // compilers happen to be installed (or spend time compiling their probes).
    const emptyPath = mkdtempSync(resolve(tmpdir(), 'kory-audit-empty-path-'));
    try {
      // Some host fixtures have explicit executable overrides rather than PATH
      // lookup. Select absent tools through those same public configuration seams.
      const absentTool = resolve(emptyPath, 'unavailable');
      const env = {
        ...process.env,
        PATH: emptyPath,
        KORY_EVAL_GO: absentTool,
        KORY_EVAL_PHP: absentTool,
        KORY_EVAL_COMPOSER: absentTool,
        KORY_EVAL_DOTNET: absentTool,
        KORY_EVAL_KOTLINC: absentTool,
        KORY_EVAL_JAVA: absentTool,
        KORY_EVAL_HYPOTHESIS_PYTHON: absentTool,
        KORY_EVAL_MAVEN: absentTool,
        KORY_IOS_EVAL_DEVELOPER_DIR: absentTool,
      };
      const reports = [[], ['--summary']].map((args) => {
        const result = spawnSync(process.execPath, [script, ...args], {
          env,
          encoding: 'utf8',
          maxBuffer: 2_000_000,
          // The complete readiness audit takes roughly 5 seconds per invocation
          // on an idle host. The full backend suite also runs expensive media
          // and compiler fixtures, so allow contention without changing any
          // readiness assertions or accepting truncated/failed subprocesses.
          timeout: 60_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
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
      expect(reports[0].blocked).toBeGreaterThan(0);
      expect(
        reports[0].blockers.every((row: { reasons: string[] }) => row.reasons.length > 0),
      ).toBe(true);
      for (const skill of ['kotlin-engineering', 'property-fuzz-differential-testing']) {
        expect(
          reports[0].blockers.filter((row: { skill: string }) => row.skill === skill),
        ).toHaveLength(2);
        expect(
          reports[0].readyScenarios.some((row: { skill: string }) => row.skill === skill),
        ).toBe(false);
      }
      expect(reports[1]).toEqual({
        schemaVersion: 1,
        scenarios: expectedCount,
        ready: reports[0].ready,
        blocked: reports[0].blocked,
      });
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  }, 130_000);
});
