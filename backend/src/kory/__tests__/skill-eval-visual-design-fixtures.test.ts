import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS,
  VISUAL_DESIGN_SKILL_EVAL_SCORERS,
} from '../skill-eval-visual-design-fixtures';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function greenArtifacts(scenarioId: string): { system: unknown; verification: string } {
  if (scenarioId === 'visual-interface-design-full-task-cross-platform-editor') {
    return {
      system: {
        tokens: { accent: '#5B63FF', radius: 6, spacing: [4, 8, 12, 16, 24] },
        themes: ['light', 'dark'],
        platformAdaptations: {
          macOS: ['native titlebar spacing'],
          Windows: ['window controls spacing'],
        },
        states: ['loading', 'empty', 'normal', 'dense', 'error', 'selected', 'disabled'],
        density: { compactRow: 28, comfortableRow: 36 },
        accessibility: {
          minTextScale: 1.25,
          longLabelStrategy: 'wrap labels before truncating supporting copy',
          focusVisible: true,
          colorNotSoleSignal: true,
        },
        hierarchy: { primaryAction: 'save', secondaryTreatment: 'quiet controls' },
      },
      verification:
        '# Verification matrix\n\nVerify 640 minimum width in light and dark themes, long label handling, loading and empty states, and dense editor surfaces.\n',
    };
  }
  return {
    system: {
      tokens: { accent: '#1457D9', radius: 4, spacing: [4, 8, 12, 16] },
      themes: ['light', 'dark'],
      platformAdaptations: {},
      states: ['loading', 'empty', 'normal', 'dense', 'error', 'selected', 'disabled'],
      density: { compactRow: 28, comfortableRow: 36 },
      accessibility: { focusVisible: true, colorNotSoleSignal: true },
      hierarchy: {
        primaryAction: 'resolve-case',
        secondaryTreatment: 'lower-contrast secondary controls',
      },
      severityEncoding: {
        critical: 'icon + critical label',
        high: 'icon + high label',
        medium: 'medium label',
        low: 'low label',
        informational: 'informational label',
      },
      shadowLevels: 2,
      cardNesting: 1,
    },
    verification:
      '# Representative-state verification\n\nVerify case table and case detail in dense and sparse or empty states, critical severity, and primary action hierarchy.\n',
  };
}

describe('visual design closed-packet fixtures', () => {
  test('both design-system tasks start red and pass with complete closed-packet artifacts', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'visual-interface-design',
    )!;
    for (const scenario of buildSkillEvalSuiteV3(skill).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const root = mkdtempSync(join(tmpdir(), 'kory-visual-design-test-'));
      roots.push(root);
      const materializer = VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = VISUAL_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      await materializer.materialize(root, scenario);
      const input = {
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      };
      const red = await scorer.score(input);
      expect(red.passed, scenario.id).toBe(false);
      expect(red.integrityFailure, scenario.id).toBe(false);

      const artifacts = greenArtifacts(scenario.id);
      writeFixtureFile(
        root,
        'visual-system.json',
        `${JSON.stringify(artifacts.system, null, 2)}\n`,
      );
      writeFixtureFile(root, 'verification.md', artifacts.verification);
      const green = await scorer.score(input);
      expect(green.passed, scenario.id).toBe(true);
      expect(green.integrityFailure, scenario.id).toBe(false);
      expect(green.quality, scenario.id).toBe(1);
    }
  });

  test('tampering with the sealed packet fails integrity', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'visual-interface-design',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'visual-interface-design-full-task-cross-platform-editor',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-visual-design-tamper-'));
    roots.push(root);
    const materializer = VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = VISUAL_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);
    writeFixtureFile(root, 'evidence/editor.json', '{}\n');
    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
  });

  test('cross-platform scorer accepts equivalent structured visual-system shapes', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'visual-interface-design',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'visual-interface-design-full-task-cross-platform-editor',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-visual-design-structured-'));
    roots.push(root);
    const materializer = VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = VISUAL_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    await materializer.materialize(root, scenario);
    writeFixtureFile(
      root,
      'visual-system.json',
      `${JSON.stringify(
        {
          tokens: {
            brandAccent: '#5B63FF',
            radius: { control: 6, panel: 8 },
            spacing: [4, 8, 12, 16, 24],
          },
          themes: { light: { surface: '#fff' }, dark: { surface: '#111' } },
          platformAdaptations: {
            macOS: { chrome: 'native titlebar spacing', controls: 'platform controls' },
            Windows: { chrome: 'caption button spacing', controls: 'platform controls' },
          },
          states: {
            loading: 'stable geometry',
            empty: 'explain recovery',
            normal: 'default',
            dense: 'reduced rows',
            error: 'icon and text',
            selected: 'fill and border',
            disabled: 'readable label',
          },
          density: { dense: { rowHeight: 28 }, comfortable: { rowHeight: 36 } },
          accessibility: {
            focus: '2px ring remains visible on every keyboard focus target',
            colorIndependence: 'status uses icon, text, and border in addition to color',
            textScale: '1.25x without clipping',
            localization: 'long labels wrap or expand instead of clipping',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFixtureFile(
      root,
      'verification.md',
      '# Verification matrix\n\nVerify 640 minimum width in light and dark themes, long label handling, loading and empty states, and dense editor surfaces.\n',
    );
    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(scorer.id).toEndWith('@3');
    expect(score.passed).toBe(true);
    expect(score.quality).toBe(1);
  });

  test('malformed collection shapes score red instead of crashing', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'visual-interface-design',
    )!;
    for (const scenario of buildSkillEvalSuiteV3(skill).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const root = mkdtempSync(join(tmpdir(), 'kory-visual-design-malformed-'));
      roots.push(root);
      const materializer = VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = VISUAL_DESIGN_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      await materializer.materialize(root, scenario);
      writeFixtureFile(
        root,
        'visual-system.json',
        `${JSON.stringify({ themes: { light: true }, states: { normal: true } }, null, 2)}\n`,
      );
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scenario.id).toBe(false);
      expect(score.integrityFailure, scenario.id).toBe(false);
    }
  });
});
