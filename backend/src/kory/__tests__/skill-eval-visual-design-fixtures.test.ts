import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import { loadV5SkillPackages } from '../skill-packages';
import {
  VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS,
  VISUAL_DESIGN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-visual-design-fixtures';
import {
  DIRECTION_CONTEXTS,
  EDITOR_DIRECTION_SCENARIO,
  OPS_DIRECTION_SCENARIO,
} from '../../eval/skills/skill-eval-visual-direction-fixtures';

const roots: string[] = [];
const skill = () =>
  loadV5SkillPackages().packages.find((item) => item.sidecar.name === 'visual-interface-design')!;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function materialized(scenarioId: string) {
  const suite = buildSkillEvalSuiteV3(skill());
  const scenario = suite.scenarios.find((item) => item.id === scenarioId)!;
  const root = mkdtempSync(join(tmpdir(), 'kory-visual-direction-'));
  roots.push(root);
  const materializer = VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
  const scorer = VISUAL_DESIGN_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenario.id))!;
  await materializer.materialize(root, scenario);
  const score = (workingDirectory = root) =>
    scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
  return { root, scenario, scorer, score };
}

function truncatedIds(root: string, context: string): string[] {
  const geometry = JSON.parse(readFileSync(join(root, 'geometry', `${context}.json`), 'utf8')) as {
    elements?: Array<{ id?: string; truncated?: boolean }>;
  };
  return (geometry.elements ?? [])
    .filter((element) => element.truncated === true && typeof element.id === 'string')
    .map((element) => element.id as string)
    .sort();
}

function completeDirection(root: string) {
  const tokens = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8')) as {
    type: Record<string, unknown>;
    metrics: Record<string, unknown>;
    semanticColorRoles: string[];
  };
  const role = 'A reused role with enough text to satisfy the documented floor.';
  return {
    status: 'proposed',
    surface: 'macos-appkit-record-inspector',
    identity: {
      shared: ['title treatment', 'sidebar geometry', 'label and value rhythm'],
      adapted: [
        { platform: 'macos', decision: 'Keep the native bezel and metric spacing.', rationale: 'Platform control metrics already carry familiarity here.' },
        { platform: 'windows', decision: 'Adopt the platform dialog chrome and padding.', rationale: 'Windows users read its modal metrics as the expected affordance.' },
      ],
    },
    system: {
      typeSteps: Object.keys(tokens.type).map((token) => ({ token, role })),
      spacingSteps: Object.keys(tokens.metrics).map((token) => ({ token, role })),
      colorRoles: tokens.semanticColorRoles.map((token) => ({ token, role })),
      iconography: 'No icons are introduced; the supplied surface uses text labels only.',
      density: 'Row height and insets come from the measured token table, never from a guess.',
    },
    hierarchy: {
      primaryAction: 'Apply is the single primary action at the trailing edge.',
      secondaryControls: 'Cancel stays visually quieter than Apply.',
      contentHierarchy: 'Field labels stay secondary to their values.',
      statusSignals: 'Status text carries meaning without color alone.',
    },
    stateReviews: DIRECTION_CONTEXTS.map((context) => ({
      context: context.id,
      verdict: 'Reviewed the supplied capture and its measured geometry.',
      truncated: truncatedIds(root, context.id),
    })),
    motion: {
      introduced: false,
      rationale: 'The supplied surface introduces no motion, so none is proposed here.',
      reducedMotion: 'Any later motion must present an equivalent static state first.',
    },
    boundary: {
      visualOnly: true,
      preserved: ['window geometry', 'control order', 'field labels'],
      tradeoffs: ['Dense rows trade breathing room for scan density at the minimum width.'],
    },
  };
}

describe('visual direction real-source fixtures', () => {
  test('both design tasks are executable now that source, tokens and captures are supplied', () => {
    const readiness = auditSkillEvalExecutionReadiness(
      [skill()],
      VISUAL_DESIGN_SKILL_EVAL_MATERIALIZERS,
      VISUAL_DESIGN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    for (const scenario of readiness) {
      expect(scenario.ready, scenario.scenarioId).toBe(true);
      expect(scenario.reasons.join(' ')).not.toMatch(/synthetic requirements only/iu);
    }
  });

  test('materialization supplies real source, tokens and seven measured captures', async () => {
    const { root } = await materialized(EDITOR_DIRECTION_SCENARIO);
    expect(existsSync(join(root, 'Surface.swift'))).toBe(true);
    expect(existsSync(join(root, 'tokens.json'))).toBe(true);
    const captures = readdirSync(join(root, 'captures')).filter((name) => name.endsWith('.png'));
    expect(captures).toHaveLength(DIRECTION_CONTEXTS.length);
    for (const context of DIRECTION_CONTEXTS) {
      expect(existsSync(join(root, 'geometry', `${context.id}.json`))).toBe(true);
    }
    // The large-text German minimum width is the condition the fixture exists to expose.
    expect(truncatedIds(root, 'min-dark-de-large').length).toBeGreaterThan(0);
  });

  test('the untouched placeholder fails closed and scores no verification', async () => {
    const { score } = await materialized(EDITOR_DIRECTION_SCENARIO);
    const red = await score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);
    // Supplied-evidence integrity and the toolchain build still verify, so the score is
    // small but not zero; every authored requirement must still fail.
    expect(red.verification).toBeLessThan(0.5);
    expect(red.quality).toBeLessThan(0.3);
    expect(red.evidence).toContain('evaluator supplied source, tokens and captures: pass — all seven captures and the source are present');
    expect(red.evidence.some((line) => line.startsWith('surface identity recorded honestly: fail'))).toBe(true);
  });

  test('a complete artifact passes only when every truncation claim matches the render', async () => {
    const { root, score } = await materialized(EDITOR_DIRECTION_SCENARIO);
    const artifact = completeDirection(root);
    writeFileSync(join(root, 'direction.json'), JSON.stringify(artifact, null, 2));
    const green = await score();
    expect(green.passed).toBe(true);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);

    // Claiming fewer clipped elements than were measured must fail, not silently pass.
    const understated = {
      ...artifact,
      stateReviews: artifact.stateReviews.map((review) =>
        review.context === 'min-dark-de-large' ? { ...review, truncated: [] } : review,
      ),
    };
    writeFileSync(join(root, 'direction.json'), JSON.stringify(understated, null, 2));
    const overstated = await score();
    expect(overstated.passed).toBe(false);
    expect(
      overstated.evidence.some((line) =>
        line.startsWith('per context truncation claims match a fresh render: fail'),
      ),
    ).toBe(true);
  });

  test('a missing supplied capture is reported instead of credited', async () => {
    const { root, score } = await materialized(OPS_DIRECTION_SCENARIO);
    writeFileSync(join(root, 'direction.json'), JSON.stringify(completeDirection(root), null, 2));
    rmSync(join(root, 'captures', 'empty-selection.png'));
    const scored = await score();
    expect(scored.passed).toBe(false);
    expect(
      scored.evidence.some((line) =>
        line.startsWith('evaluator supplied source, tokens and captures: fail'),
      ),
    ).toBe(true);
  });
});
