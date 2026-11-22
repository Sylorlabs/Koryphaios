import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WRITING_STYLE_SCENARIOS,
  WRITING_STYLE_SKILL_EVAL_MATERIALIZERS,
  scoreWritingStyle,
  writingStylePacket,
} from '../../eval/skills/skill-eval-writing-style-fixtures';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { loadV5SkillPackages } from '../skill-packages';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(index = 0) {
  const root = mkdtempSync(join(tmpdir(), 'kory-writing-control-'));
  roots.push(root);
  const id = WRITING_STYLE_SCENARIOS[index]!;
  WRITING_STYLE_SKILL_EVAL_MATERIALIZERS[index]!.materialize(root, { id } as never);
  return { root, id };
}
function positive(id: string) {
  const packet = writingStylePacket(id);
  if (id === WRITING_STYLE_SCENARIOS[0])
    return packet.source
      .replace(
        'Rollout is conditional\u2014do not release',
        'Rollout is conditional. Do not release',
      )
      .replace('follow-up', 'follow up')
      .replace('09:00\u201317:00', '09:00 to 17:00');
  return (
    '# Customer notice\n\nOnly customers with a confirmed duplicate charge are eligible for a $25 refund. Approval is not automatic. The cause remains uncertain. Contact support 09:00 to 17:00 UTC about ACME-17 at help-desk@example.test.\n\nA follow up and a check of the second stage are pending. The case owner requests care instead of speed. A review is required; text for customers must remain accurate.\n\n' +
    packet.protectedSpans[0] +
    '\n'
  );
}
function save(root: string, text: string) {
  writeFileSync(join(root, 'revised.md'), text);
  writeFileSync(
    join(root, 'review.md'),
    'Exact technical and quoted material is preserved. Prose was rephrased; semantic judgment remains separate.',
  );
}

describe('dash free writing artifact evaluator', () => {
  for (const index of [0, 1]) {
    test(`${WRITING_STYLE_SCENARIOS[index]} rejects original and accepts two revisions`, () => {
      const { root, id } = fixture(index);
      expect(scoreWritingStyle(root, id).passed).toBe(false);
      save(root, positive(id));
      let score = scoreWritingStyle(root, id);
      expect(score.passed, score.evidence.join('\n')).toBe(true);
      save(
        root,
        positive(id)
          .replace('remains uncertain', 'is not confirmed')
          .replace('09:00 to 17:00', '09:00 through 17:00'),
      );
      score = scoreWritingStyle(root, id);
      expect(score.passed, score.evidence.join('\n')).toBe(true);
      const evidence = JSON.parse(
        readFileSync(join(root, '.kory-eval/writing-style-evidence.json'), 'utf8'),
      );
      expect(evidence.blindSemanticStatus).toBe('not-run');
      expect(evidence.liveModelUplift).toBe('not-established');
    });
  }
  for (const [name, mutate] of [
    ['changed command flag', (text: string) => text.replace('--dry-run', '--run')],
    [
      'removed release condition',
      (text: string) => text.replace('Do not release until 3 checks pass', 'Release immediately'),
    ],
    [
      'false certainty',
      (text: string) => text.replace('cause remains uncertain', 'cause is confirmed'),
    ],
    [
      'dash lookalike',
      (text: string) => text.replace('Rollout is conditional.', 'Rollout is conditional\u2015'),
    ],
    ['prose hidden in code', (text: string) => '```text\n' + text + '\n```'],
    [
      'prose hidden in a quote',
      (text: string) =>
        text
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n'),
    ],
    ['claim in place of artifact', () => 'All checks passed.'],
  ] as const) {
    test(`rejects ${name}`, () => {
      const { root, id } = fixture();
      save(root, mutate(positive(id)));
      expect(scoreWritingStyle(root, id).passed).toBe(false);
    });
  }
  test('unknown eligibility and an automatic refund cannot pass', () => {
    const { root, id } = fixture(1);
    save(
      root,
      positive(id)
        .replace('Only customers with a confirmed duplicate charge', 'All customers')
        .replace('Approval is not automatic', 'Approval is automatic'),
    );
    const score = scoreWritingStyle(root, id);
    expect(score.passed).toBe(false);
    expect(score.verification).toBe(0);
  });
  test('fixed-file tampering and report symlinks fail closed', () => {
    const { root, id } = fixture();
    save(root, positive(id));
    writeFileSync(join(root, 'source.md'), 'forged');
    expect(scoreWritingStyle(root, id).integrityFailure).toBe(true);
    const next = fixture();
    const target = mkdtempSync(join(tmpdir(), 'kory-writing-preserve-'));
    roots.push(target);
    writeFileSync(join(target, 'writing-style-evidence.json'), 'preserve');
    symlinkSync(target, join(next.root, '.kory-eval'));
    expect(scoreWritingStyle(next.root, next.id).integrityFailure).toBe(true);
    expect(readFileSync(join(target, 'writing-style-evidence.json'), 'utf8')).toBe('preserve');
  });
  test('symlinked or oversized candidate artifacts are rejected without execution', () => {
    const { root, id } = fixture();
    rmSync(join(root, 'revised.md'));
    symlinkSync(join(root, 'source.md'), join(root, 'revised.md'));
    expect(scoreWritingStyle(root, id).passed).toBe(false);
    rmSync(join(root, 'revised.md'));
    writeFileSync(join(root, 'revised.md'), 'x'.repeat(128_001));
    expect(scoreWritingStyle(root, id).passed).toBe(false);
  });
  test('both packets have one dispatch and no invented semantic qualification', () => {
    const pkg = loadV5SkillPackages().packages.find((p) => p.sidecar.name === 'dash-free-writing')!;
    const rows = auditSkillEvalExecutionReadiness(
      [pkg],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ready)).toBe(true);
    for (const id of WRITING_STYLE_SCENARIOS) {
      expect(
        BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((m) => m.matches({ id } as never)),
      ).toHaveLength(1);
      expect(BUILTIN_SKILL_EVAL_SCORERS.filter((s) => s.scenarioIds.includes(id))).toHaveLength(1);
    }
  });
});
