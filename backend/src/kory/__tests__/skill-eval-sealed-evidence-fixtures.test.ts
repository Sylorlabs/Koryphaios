import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SEALED_EVIDENCE_SCENARIO_IDS,
  SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS,
  scoreSealedEvidenceFixture,
} from '../skill-eval-sealed-evidence-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-sealed-evidence-'));
  roots.push(root);
  return root;
}

function scenarioById(id: string) {
  const skillPackage = loadV5SkillPackages().packages.find((candidate) =>
    candidate.evaluation.tasks.some((task) => task.id === id),
  );
  if (!skillPackage) throw new Error(`Package for scenario ${id} not found`);
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (candidate) => candidate.id === id,
  );
  if (!scenario) throw new Error(`Scenario ${id} not found`);
  return { skillPackage, scenario };
}

describe('sealed evidence professional-task fixtures', () => {
  test('covers only the explicit synthetic allowlist and keeps genuinely unavailable runtime classes blocked', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    for (const id of SEALED_EVIDENCE_SCENARIO_IDS) {
      expect(readiness.find((row) => row.scenarioId === id)?.ready, id).toBe(true);
    }

    const stillBlocked = [
      'hardware-runtime-debugging-full-task-1',
      'audio-production-full-task-1-individual',
      'research-full-task-1-individual',
    ];
    for (const id of stillBlocked) {
      expect(readiness.find((row) => row.scenarioId === id)?.ready, id).toBe(false);
    }

    const browserBacked = readiness.find(
      (row) => row.scenarioId === 'visual-verification-full-task-1',
    );
    expect(browserBacked?.ready).toBe(true);
    expect(browserBacked?.materializerId).toContain('real-browser');
  });

  test('starts red and passes only after evidence, checks, artifacts, and uncertainty are accounted for', async () => {
    const { scenario } = scenarioById('user-research-full-task-decision-linked-discovery');
    const root = workspace();
    const materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS[0]!;
    await materializer.materialize(root, scenario);
    expect(scoreSealedEvidenceFixture(scenario, root).passed).toBe(false);

    const provided = scenario.environment.requirements
      .map((text, index) => ({ text, id: `E${String(index + 1).padStart(2, '0')}` }))
      .filter(({ text }) => !/paired same-model/iu.test(text));
    writeFixtureFile(
      root,
      'result.md',
      '# Research plan\n\nUse the supplied support and analytics evidence to define the handoff decisions before recruiting. Recruit across meaningful operating conditions and access needs, preserve contradictions, and keep raw observations separate from interpretations and implications. No user finding or prevalence claim is asserted before fieldwork. The packet does not contain completed interviews, so those outcomes remain unresolved.\n',
    );
    writeFixtureFile(
      root,
      'verification.md',
      '# Verification\n\nAll supplied evidence records are traced below. Each falsifiable check is explicitly assessed from the sealed packet. Claims requiring completed interviews are unavailable rather than inferred as facts. Negative and contradictory observations will be retained during synthesis instead of collapsed into consensus.\n',
    );
    writeFixtureFile(
      root,
      'evidence-map.json',
      `${JSON.stringify(
        {
          claims: provided.map(({ id, text }) => ({
            claim: `The plan accounts for supplied evidence: ${text}`,
            evidenceIds: [id],
            confidence: 'observed',
          })),
          verification: scenario.falsifiableChecks.map(({ id }) => ({
            checkId: id,
            status: 'passed',
            evidence:
              'Addressed explicitly in result.md and bounded to the sealed evidence packet.',
          })),
          artifacts: scenario.requiredArtifacts.map((name) => ({
            name,
            status: /paired|experiment|evaluation/iu.test(name) ? 'external-evaluator' : 'produced',
            note: /paired|experiment|evaluation/iu.test(name)
              ? 'Produced by the outer matched evaluation harness.'
              : 'Represented by result.md and verification.md in this bounded fixture.',
          })),
          limitations: [
            'No completed participant sessions or prevalence evidence is present in the packet.',
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(scoreSealedEvidenceFixture(scenario, root).passed).toBe(true);
  });

  test('fails integrity when evaluator-owned packet evidence is edited', async () => {
    const { scenario } = scenarioById('user-research-full-task-decision-linked-discovery');
    const root = workspace();
    await SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS[0]!.materialize(root, scenario);
    writeFixtureFile(root, 'evidence-packet.json', '{"tampered":true}\n');
    const score = scoreSealedEvidenceFixture(scenario, root);
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
  });
});
