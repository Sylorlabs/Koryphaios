import { describe, expect, test } from 'bun:test';
import { lintProse } from '../../../../skills-v5/dash-free-writing/scripts/check-prose.mjs';
import { auditV5SkillLibraryQuality, instructionParagraphs } from '../skill-v5-quality';
import { loadV5SkillPackages } from '../skill-packages';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const STRICT_DASH_FREE_SKILLS = new Set([
  'api-contract-design',
  'architecture-planning',
  'debugging',
  'feature-implementation',
  'interaction-design',
  'skill-authoring-evaluation',
]);

function authoredMarkdownFiles(directory: string): string[] {
  const files = [join(directory, 'SKILL.md')];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  };
  visit(join(directory, 'references'));
  return files;
}

describe('prose style and skill editorial diagnostics', () => {
  test('every package entrypoint and source map avoids authored em and en dashes', () => {
    for (const skill of loadV5SkillPackages().packages) {
      for (const relative of ['SKILL.md', 'references/sources.md']) {
        const path = join(skill.directory, relative);
        const findings = lintProse(readFileSync(path, 'utf8')).findings.filter((finding) =>
          ['\u2013', '\u2014'].includes(finding.character),
        );
        expect(findings, path).toEqual([]);
      }
    }
  });
  test('ratchets every authored dash finding and keeps migrated packages clean', () => {
    const catalog = loadV5SkillPackages();
    const skillNames = catalog.packages.map((skill) => skill.sidecar.name);
    const debt = JSON.parse(
      readFileSync(
        join(import.meta.dir, '../../../../skills-v5/dash-free-writing/prose-debt.json'),
        'utf8',
      ),
    ) as { schemaVersion: number; counts: Record<string, number> };
    expect(debt.schemaVersion).toBe(1);
    expect(Object.keys(debt.counts).sort()).toEqual([...skillNames].sort());

    const overBudget: Array<{ skill: string; allowed: number; actual: number }> = [];
    for (const skill of catalog.packages) {
      const findings = authoredMarkdownFiles(skill.directory).flatMap((path) =>
        lintProse(readFileSync(path, 'utf8'), { literals: skillNames }).findings.map((finding) => ({
          path,
          ...finding,
        })),
      );
      const allowed = debt.counts[skill.sidecar.name] ?? 0;
      if (findings.length > allowed) {
        overBudget.push({ skill: skill.sidecar.name, allowed, actual: findings.length });
      }
      if (STRICT_DASH_FREE_SKILLS.has(skill.sidecar.name)) {
        expect(findings, skill.sidecar.name).toEqual([]);
      }
    }
    expect(overBudget, 'Authored prose must not increase the recorded dash debt').toEqual([]);
  });
  test('reports dash families, compounds, double hyphens and soft hyphens', () => {
    for (const mark of [
      '-',
      '--',
      '\u2010',
      '\u2011',
      '\u2012',
      '\u2013',
      '\u2014',
      '\u2015',
      '\uFE58',
      '\uFE63',
      '\uFF0D',
      '\u00AD',
      '\u2212',
    ]) {
      const report = lintProse(`Reader${mark}facing prose`);
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.semanticReviewRequired).toBe(true);
    }
  });
  test('keeps required syntax and exact material outside automatic punctuation edits', () => {
    const source =
      '---\nname: example-skill\n---\n# Guide\n\n- Read `--dry-run` and ``code-`value``.\n\n```sh\nrun --flag-name\n```\n\n~~~text\nA quoted em\u2014dash\n~~~\n\n> Exact source\u2014unchanged.\n\n| Value | Count |\n| --- | ---: |\n| a | -7 |\n\n[Source](https://example.org/a-b_(c-d))\n\nVerified 2026-09-17. Contact a-b@example-domain.org. Value: -3.2. Formula: $x-y$.\n';
    const report = lintProse(source);
    expect(report.findings).toEqual([]);
    expect(report.protectedCharacters).toBeGreaterThan(0);
  });
  test('checks visible link labels and prose around protected literals', () => {
    const source = '[Reader-facing](https://example.org/a-b) text\u2014with an aside. `code-id`';
    expect(lintProse(source).findings.map((f) => f.character)).toEqual(['-', '\u2014']);
    expect(
      lintProse('Keep customer-id but re-write prose.', { literals: ['customer-id'] }).findings,
    ).toHaveLength(1);
    expect(() => lintProse('text', { literals: [''] })).toThrow();
  });
  test('does not hide prose behind currency, incomplete metadata or mismatched code delimiters', () => {
    for (const source of [
      'The cost is $20\u2014$30 per month.',
      'Budget $20 now\u2014reserve $30 later.',
      '---\nReader\u2014facing copy',
      '`must\u2014remain``',
    ]) {
      expect(
        lintProse(source).findings.map((finding) => finding.character),
        source,
      ).toContain('\u2014');
    }
    expect(lintProse('Use ``literal`token\u2014exact`` and $x-y$.').findings).toEqual([]);
  });
  test('checks nested list prose without treating its indentation as a code block', () => {
    const source =
      '- Parent\n    - Child\u2014copy\n\n      Continued\u2014copy\n\n          command --flag-name\n';
    expect(lintProse(source).findings.map((finding) => [finding.line, finding.character])).toEqual([
      [2, '\u2014'],
      [4, '\u2014'],
    ]);
    expect(lintProse('    command --flag-name\n').findings).toEqual([]);
  });
  test('fresh lines retain locations and numbers retain signs', () => {
    expect(lintProse('Value -4\nA\u2014B').findings[0]).toMatchObject({
      line: 2,
      column: 2,
      offset: 10,
    });
    expect(lintProse('From 3-5 days').findings).toHaveLength(1);
    expect(lintProse('It might fail. Use a separate sentence.')).toMatchObject({ findings: [] });
  });
  test('finds Unicode dash lookalikes and preserves codepoint columns with UTF16 offsets', () => {
    for (const mark of ['\u2053', '\u207B', '\u208B', '\u{10EAD}']) {
      expect(lintProse(`Reader${mark}facing`).findings.map((f) => f.character)).toEqual([mark]);
    }
    expect(lintProse('🙂A\u2014B').findings[0]).toMatchObject({ line: 1, column: 3, offset: 3 });
    expect(lintProse('X\u{10EAD}Y\u2014Z').findings[1]).toMatchObject({
      line: 1,
      column: 4,
      offset: 4,
    });
    expect(lintProse('The result is −12 and -3.')).toMatchObject({ findings: [] });
  });
  test('editorial audit detects duplicated paragraphs even when whole bodies differ', () => {
    const catalog = loadV5SkillPackages();
    const paragraph =
      'This is repeated generic guidance that belongs in a shared parent rather than every child. Preserve inputs, outputs, evidence and behavior across the selected domain boundary, without turning this editorial diagnostic into a semantic quality or qualification score.';
    const packages = catalog.packages.slice(0, 5).map((p, i) => ({
      ...p,
      instructions: `# Unique ${i}\n\n${paragraph}\n\n${paragraph}`,
      sourceContent: `${p.sourceContent}\n\nExtra\u2014aside.`,
    }));
    const report = auditV5SkillLibraryQuality({ ...catalog, packages });
    expect(report.duplicateBodyGroups).toEqual([]);
    expect(report.repeatedParagraphPackages).toHaveLength(5);
    expect(report.sharedBoilerplateGroups).toHaveLength(1);
    expect(report.proseEmDashPackages).toHaveLength(5);
    expect(instructionParagraphs(`Verification focus: ${paragraph}`)).toEqual([paragraph]);
  });
});
