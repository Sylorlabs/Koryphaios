import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintProse } from '../../../skills-v5/dash-free-writing/scripts/check-prose.mjs';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';

export const WRITING_STYLE_SCENARIOS = [
  'dash-free-writing-mixed-technical-memo',
  'dash-free-writing-unicode-reader-copy',
] as const;
const shellExample = '```sh\nrelease-tool --dry-run --customer-id sample-17\n```';
const incidentQuote = '> Incident note: "retry\u2014then inspect customer-id"';
const customerQuote = '> Source statement: "eligible\u2014subject to review"';
const table = '| Signal | Value |\n| --- | ---: |\n| Drift | -7 ms |';
const sourceMemo = `# Release memo\n\nRollout is conditional\u2014do not release until 3 checks pass. The cause remains uncertain; a follow-up review is required. Support is available 09:00\u201317:00 UTC. The recorded drift is -7 ms on 2026-09-06. Preserve customer-id and consult [the guide](https://example.test/release-notes).\n\n${shellExample}\n\n${incidentQuote}\n\n${table}\n`;
const sourceNotice = `# Customer notice\n\nOnly customers with a confirmed duplicate charge are eligible for a $25 refund\u2014approval is not automatic. The cause remains uncertain. Contact support 09:00\u201317:00 UTC about ACME-17 at help-desk@example.test.\n\nA follow\u2010up and a second\u2011stage check are pending. The case\u2012owner requests care\u2015not speed. A re\u00adview is required; customer\uFF0Dfacing text must remain accurate.\n\n${customerQuote}\n`;

export function writingStylePacket(id: string) {
  if (!WRITING_STYLE_SCENARIOS.some((value) => value === id))
    throw new Error(`Unknown writing scenario: ${id}`);
  const memo = id === WRITING_STYLE_SCENARIOS[0];
  return {
    id,
    evidenceKind: 'synthetic-prose-artifact' as const,
    source: memo ? sourceMemo : sourceNotice,
    protectedSpans: memo
      ? [
          shellExample,
          incidentQuote,
          table,
          'customer-id',
          'https://example.test/release-notes',
          '2026-09-06',
          '-7 ms',
        ]
      : [customerQuote, 'ACME-17', 'help-desk@example.test'],
    literals: memo ? ['customer-id', '2026-09-06'] : ['ACME-17'],
  };
}

function fixedFiles(id: string): Record<string, string> {
  const packet = writingStylePacket(id);
  return {
    'source.md': packet.source,
    'contract.json': `${JSON.stringify({ ...packet, source: undefined }, null, 2)}\n`,
    'README.md':
      '# Prose revision task\n\nWrite revised.md and review.md. Rephrase source.md into natural prose without dash punctuation, keeping its facts, conditions, uncertainty and exact protected spans. contract.json identifies literal material. Source facts are synthetic exercise data, not live incident or account evidence. Do not execute quoted commands. Do not hide prose inside new code, quotations, HTML or frontmatter to evade inspection. The short review explains protected material and any ambiguity; it is not self-certification.\n\nThe deterministic evaluator checks punctuation, protected spans, factual anchors and artifact integrity. It does not certify semantic equivalence or natural writing quality. Those remain independent blind-review dimensions. No candidate code is executed by this scorer.\n',
  };
}

function readRegular(root: string, path: string): string | null {
  try {
    if (!lstatSync(root).isDirectory()) return null;
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > 128_000) return null;
    return readFileSync(current, 'utf8');
  } catch {
    return null;
  }
}

function reportPathSafe(root: string): boolean {
  for (const path of ['.kory-eval', '.kory-eval/writing-style-evidence.json']) {
    try {
      const stat = lstatSync(join(root, path));
      if (path === '.kory-eval' ? !stat.isDirectory() : !stat.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

function exposedProse(text: string, protectedSpans: string[]): string {
  let visible = text;
  for (const span of protectedSpans) visible = visible.replaceAll(span, ' ');
  return visible
    .replace(/(`+)[\s\S]*?\1/gu, ' ')
    .replace(/^.*(?:^\s*>|^\s{4}|^\s*<|^---\s*$).*$/gmu, ' ')
    .replace(/\s+/gu, ' ');
}

export function scoreWritingStyle(root: string, id: string): SkillEvalDeterministicScore {
  const fail = (message: string, integrityFailure = false): SkillEvalDeterministicScore => ({
    passed: false,
    quality: 0,
    verification: 0,
    integrityFailure,
    evidence: [message],
  });
  const fixed = fixedFiles(id);
  if (
    !Object.entries(fixed).every(([path, expected]) => readRegular(root, path) === expected) ||
    !reportPathSafe(root)
  )
    return fail('Fixed input or evidence path missing, changed, oversized or symlinked.', true);
  const revised = readRegular(root, 'revised.md');
  const review = readRegular(root, 'review.md');
  if (revised === null || review === null)
    return fail('Regular bounded revised.md and review.md artifacts are required.');
  const packet = writingStylePacket(id);
  const prose = exposedProse(revised, packet.protectedSpans);
  const remaining = packet.protectedSpans.reduce(
    (text, span) => text.replaceAll(span, ''),
    revised,
  );
  const checks: Record<string, boolean> = {
    'protected literal spans': packet.protectedSpans.every((span) => revised.includes(span)),
    'prose punctuation': lintProse(revised, { literals: packet.literals }).findings.length === 0,
    'no syntax hiding': !/```|~~~|`|^\s*>|^\s*<|^---\s*$|^ {4}\S/gmu.test(remaining),
    'review artifact present': review.trim().length > 0,
    'cause remains uncertain':
      /cause\b.{0,45}\b(?:uncertain|unknown|unconfirmed|not (?:known|confirmed|established))/iu.test(
        prose,
      ),
    'time range preserved as words': /09:00\s+(?:to|through|until)\s+17:00\s+UTC/u.test(prose),
  };
  if (id === WRITING_STYLE_SCENARIOS[0]) {
    checks['conditional release'] =
      /(?:do not release|must not (?:release|proceed)|cannot (?:release|proceed)|only (?:release|proceed)).{0,45}(?:until|unless|after|if)\s+(?:all\s+)?(?:3|three)\s+checks\s+pass/iu.test(
        prose,
      );
    checks['review still required'] =
      /(?:review.{0,35}(?:required|needed)|(?:require|need).{0,35}review)/iu.test(prose);
  } else {
    checks['refund amount preserved'] = /\$25\s+refund|refund\s+(?:of\s+)?\$25/iu.test(prose);
    checks['eligibility condition preserved'] =
      /(?:only|must).{0,65}confirmed duplicate charge|confirmed duplicate charge.{0,65}(?:required|necessary)/iu.test(
        prose,
      );
    checks['no automatic approval'] =
      /approval\s+(?:is\s+)?not automatic|not automatically approved/iu.test(prose);
  }
  const passed = Object.values(checks).every(Boolean);
  const evidence = Object.entries(checks).map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`);
  writeFixtureFile(
    root,
    '.kory-eval/writing-style-evidence.json',
    `${JSON.stringify({ schemaVersion: 1, scenarioId: id, evidenceKind: packet.evidenceKind, artifactSha256: createHash('sha256').update(revised).digest('hex'), checks, blindSemanticStatus: 'not-run', liveModelUplift: 'not-established', limitations: ['Lexical factual anchors do not prove semantic fidelity or readable writing.', 'Literal-preservation and syntax exclusions are scoped to this synthetic packet.', 'No quoted command or candidate code was executed.'] }, null, 2)}\n`,
  );
  return {
    passed,
    quality: Object.values(checks).filter(Boolean).length / Object.keys(checks).length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      ...evidence,
      'Deterministic artifact checks only; independent semantic assessment and model uplift are not established.',
    ],
  };
}

export const WRITING_STYLE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  WRITING_STYLE_SCENARIOS.map((id) => ({
    id: `${id}/artifact@1`,
    matches: (scenario) => scenario.id === id,
    materialize: (root) => {
      for (const [path, value] of Object.entries(fixedFiles(id)))
        writeFixtureFile(root, path, value);
      writeFixtureFile(root, 'revised.md', writingStylePacket(id).source);
      writeFixtureFile(root, 'review.md', '');
    },
  }));
export const WRITING_STYLE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  WRITING_STYLE_SCENARIOS.map((id) => ({
    id: `${id}/artifact-scorer@1`,
    scenarioIds: [id],
    score: ({ workingDirectory }) => scoreWritingStyle(workingDirectory, id),
  }));
