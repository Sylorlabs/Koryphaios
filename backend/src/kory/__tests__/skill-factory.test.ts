import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeSkillGaps,
  buildSkillFactoryCandidate,
  createSkillFactoryDraft,
  getSkillFactoryStatePath,
  loadSkillFactoryState,
} from '../skill-factory';
import { DEFAULT_SKILL_STEWARD_MODEL } from '../skill-stewards';
import { BUNDLED_SKILL_DEFINITIONS, listSkills } from '../skills';

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-skill-factory-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-skill-factory-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

const novelSignal = {
  id: 'signal-quantum-decoder-1',
  capability: 'Quantum error-correction decoder optimization',
  proposedSkillName: 'quantum-error-correction',
  requestExamples: ['Optimize a surface-code decoder against measured syndrome latency'],
  domains: ['quantum-computing'],
  targetMedia: ['code'],
  source: 'manual' as const,
  observedAt: '2026-08-31T20:00:00.000Z',
  evidence: ['request-42'],
};

describe('Skill Factory', () => {
  test('separates covered demand from persistent evidence-backed gap proposals', () => {
    const report = analyzeSkillGaps(
      root,
      [
        {
          id: 'signal-existing-visual-design',
          capability: 'Visual interface design',
          proposedSkillName: 'visual-interface-design',
          source: 'benchmark',
          observedAt: '2026-08-31T19:00:00.000Z',
        },
        novelSignal,
      ],
      { now: '2026-08-31T20:01:00.000Z' },
    );

    expect(report.librarySkillCount).toBe(BUNDLED_SKILL_DEFINITIONS.length);
    expect(report.activeSkillCount).toBe(BUNDLED_SKILL_DEFINITIONS.length);
    expect(report.covered).toHaveLength(1);
    expect(report.covered[0]).toMatchObject({
      matchedSkill: 'visual-interface-design',
      status: 'covered',
      score: 1,
    });
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({
      proposedSkillName: 'quantum-error-correction',
      status: 'proposed',
      signalIds: ['signal-quantum-decoder-1'],
      evidence: ['request-42'],
    });
    expect(report.gaps[0].benchmarkPlan.map((item) => item.kind)).toEqual([
      'positive-trigger',
      'negative-trigger',
      'ambiguous-routing',
      'adversarial-routing',
      'realistic-full-task',
      'skill-vs-no-skill',
      'regression',
    ]);
    expect(loadSkillFactoryState(root).gaps).toHaveLength(1);
  });

  test('creates a validated draft with a ChatGPT Web steward but never activates it', () => {
    const [gap] = analyzeSkillGaps(root, [novelSignal], {
      now: '2026-08-31T20:01:00.000Z',
    }).gaps;
    const result = createSkillFactoryDraft(root, {
      gapId: gap.id,
      learningMode: 'propose-then-verify',
      now: '2026-08-31T20:02:00.000Z',
      draft: {
        description:
          'Design and optimize evidence-backed quantum error-correction decoders for realistic hardware and latency constraints.',
        instructions:
          'Establish the code family, noise model, syndrome stream, decoder objective, latency and memory budgets, hardware constraints, correctness oracle, and reproducible benchmark before changing the decoder. Compare against a baseline, preserve uncertainty, and report logical error rate, throughput, tail latency, resource cost, and failure cases.',
        domains: ['quantum-computing', 'optimization'],
        activation: ['quantum error correction', 'surface code decoder'],
        shouldTrigger: [
          'Optimize a surface-code decoder for measured syndrome latency',
          'Evaluate quantum error-correction decoder tradeoffs under a noise model',
        ],
        shouldNotTrigger: [
          'Optimize a conventional database query',
          'Explain generic parity checks without decoder engineering',
        ],
        evidence: [
          'Declared code and noise model',
          'Reproducible decoder benchmark against a baseline',
        ],
        broader: ['implementation'],
        facets: ['performance-verification'],
        targetMedia: ['code'],
        depth: 1,
      },
    });

    expect(result.draft).toMatchObject({
      name: 'quantum-error-correction',
      source: 'project',
      state: 'draft',
    });
    expect(result.steward).toMatchObject({
      displayLabel: 'ChatGPT web — quantum-error-correction',
      provider: 'chatgpt-web',
      model: DEFAULT_SKILL_STEWARD_MODEL,
    });
    expect(result.gap.status).toBe('drafted');
    expect(result.evaluation.gate.status).toBe('unmeasured');
    expect(result.promotionReady).toBe(false);

    const revisions = listSkills(root);
    expect(revisions.filter((skill) => skill.state === 'active')).toHaveLength(
      BUNDLED_SKILL_DEFINITIONS.length,
    );
    expect(
      revisions.some(
        (skill) => skill.name === 'quantum-error-correction' && skill.state === 'active',
      ),
    ).toBe(false);
    expect(buildSkillFactoryCandidate(root, gap.id).promotionReady).toBe(false);
  });

  test('rejects dash punctuation in Skill Factory authored prose', () => {
    const [gap] = analyzeSkillGaps(root, [novelSignal], {
      now: '2026-08-31T20:01:00.000Z',
    }).gaps;
    expect(() =>
      createSkillFactoryDraft(root, {
        gapId: gap.id,
        learningMode: 'propose-then-verify',
        now: '2026-08-31T20:02:00.000Z',
        draft: {
          description:
            'Design quantum decoder guidance for realistic hardware constraints and measurable evidence.',
          instructions:
            'Inspect the reader-facing guidance, preserve the correctness oracle, and compare the result against a reproducible baseline.',
          domains: ['quantum-computing'],
          activation: ['quantum error correction'],
          shouldTrigger: ['review quantum decoder guidance', 'evaluate the decoder workflow'],
          shouldNotTrigger: ['write a slogan', 'rename a variable'],
          evidence: ['Reproducible decoder evidence'],
        },
      }),
    ).toThrow(/avoid dash punctuation/);
  });

  test('honors human-only learning mode and leaves the gap as a proposal', () => {
    const [gap] = analyzeSkillGaps(root, [novelSignal], {
      now: '2026-08-31T20:01:00.000Z',
    }).gaps;
    expect(() =>
      createSkillFactoryDraft(root, {
        gapId: gap.id,
        learningMode: 'human-only',
        now: '2026-08-31T20:02:00.000Z',
        draft: {
          description:
            'Design and optimize evidence-backed quantum error-correction decoders for realistic hardware and latency constraints.',
          instructions:
            'Establish the actual decoder problem, constraints, oracle, baseline, and benchmark before proposing any implementation changes.',
          domains: ['quantum-computing'],
          activation: ['quantum error correction'],
          shouldTrigger: ['Optimize a surface-code decoder', 'Benchmark a quantum decoder'],
          shouldNotTrigger: ['Tune a SQL query', 'Write generic quantum notes'],
          evidence: ['Reproducible benchmark'],
        },
      }),
    ).toThrow('disabled in Human only mode');
    expect(loadSkillFactoryState(root).gaps[0].status).toBe('proposed');
    expect(listSkills(root).some((skill) => skill.name === 'quantum-error-correction')).toBe(false);
  });

  test('fails closed and preserves malformed factory state', () => {
    analyzeSkillGaps(root, [novelSignal], { now: '2026-08-31T20:01:00.000Z' });
    const path = getSkillFactoryStatePath(root);
    writeFileSync(path, '{ malformed factory state');
    expect(() => loadSkillFactoryState(root)).toThrow('existing file was preserved');
    expect(readFileSync(path, 'utf8')).toBe('{ malformed factory state');
  });
});
