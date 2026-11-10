import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { readFixtureText, writeFixtureFile } from '../skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SEALED_EVIDENCE_SCENARIO_IDS,
  SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS,
  scoreSealedEvidenceFixture,
} from '../skill-eval-sealed-evidence-fixtures';

const roots: string[] = [];
const REAL_BROWSER_AVAILABLE = existsSync(
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
);
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
      'android-compose-full-task-1-individual',
      'research-full-task-1-individual',
    ];
    for (const id of stillBlocked) {
      expect(readiness.find((row) => row.scenarioId === id)?.ready, id).toBe(false);
    }

    const browserBacked = readiness.find(
      (row) => row.scenarioId === 'visual-verification-full-task-1',
    );
    expect(browserBacked?.ready).toBe(REAL_BROWSER_AVAILABLE);
    expect(browserBacked?.materializerId).toContain('real-browser');
  }, 30_000);

  test('uses the current sealed-evidence generation for procurement contract revisions', () => {
    const packages = loadV5SkillPackages().packages.filter(
      (skillPackage) => skillPackage.sidecar.name === 'procurement-vendor-evaluation',
    );
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );

    for (const scenarioId of [
      'procurement-vendor-evaluation-full-task-1-individual',
      'procurement-vendor-evaluation-full-task-2-individual',
    ]) {
      const row = readiness.find((candidate) => candidate.scenarioId === scenarioId);
      expect(row?.ready, scenarioId).toBe(true);
      expect(row?.materializerId, scenarioId).toBe('sealed-evidence/professional-judgment@4');
      expect(row?.deterministicScorerId, scenarioId).toBe(
        'sealed-evidence/professional-judgment-scorer@4',
      );
    }
  });

  test('states paired-artifact ownership for information architecture and only there', async () => {
    const row = (id: string) => {
      const packages = loadV5SkillPackages().packages.filter(
        (skillPackage) => skillPackage.sidecar.name === 'information-architecture',
      );
      const readiness = auditSkillEvalExecutionReadiness(
        packages,
        BUILTIN_SKILL_EVAL_MATERIALIZERS,
        BUILTIN_SKILL_EVAL_SCORERS,
      );
      return readiness.find((candidate) => candidate.scenarioId === id);
    };
    for (const id of [
      'information-architecture-full-task-developer-platform-docs',
      'information-architecture-full-task-role-aware-settings',
    ]) {
      const readinessRow = row(id);
      expect(readinessRow?.ready, id).toBe(true);
      expect(readinessRow?.materializerId, id).toBe('sealed-evidence/paired-artifact-ownership@2');
      expect(readinessRow?.deterministicScorerId, id).toBe(
        'sealed-evidence/paired-artifact-ownership-scorer@2',
      );
    }

    const infoMaterializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/paired-artifact-ownership@2',
    );
    expect(infoMaterializer).toBeDefined();
    const infoRoot = workspace();
    await infoMaterializer!.materialize(
      infoRoot,
      scenarioById('information-architecture-full-task-role-aware-settings').scenario,
    );
    expect(readFixtureText(infoRoot, 'README.md')).toContain(
      'The paired or evaluator-owned comparison artifact always uses `external-evaluator`, never `unavailable`',
    );

    // Negative control: a v1 scenario keeps the generic README without the ownership sentence, so
    // the repair cannot have leaked to every sealed-evidence skill.
    const v1Materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/professional-judgment@1',
    )!;
    const v1Root = workspace();
    await v1Materializer.materialize(
      v1Root,
      scenarioById('user-research-full-task-decision-linked-discovery').scenario,
    );
    expect(readFixtureText(v1Root, 'README.md')).not.toContain(
      'always uses `external-evaluator`, never `unavailable`',
    );
  });

  test('only a pairing or comparison artifact is harness-owned, judged on its name segments', async () => {
    const { scenario } = scenarioById('information-architecture-full-task-role-aware-settings');
    const root = workspace();
    const materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/paired-artifact-ownership@2',
    )!;
    await materializer.materialize(root, scenario);
    const packet = JSON.parse(readFixtureText(root, 'evidence-packet.json')) as {
      requiredArtifacts: string[];
    };

    // Positive control: the candidate-owned artifact that contains the word "evaluation" is
    // accepted as produced, and the harness-owned pairing artifact is accepted as external.
    const owned = new Map(
      packet.requiredArtifacts.map((name) => [
        name,
        name.includes('paired') ? 'external-evaluator' : 'produced',
      ]),
    );
    const writeMap = (statusFor: (name: string) => string) => {
      const starter = JSON.parse(readFixtureText(root, 'evidence-map.json')) as Record<string, unknown>;
      writeFixtureFile(
        root,
        'evidence-map.json',
        `${JSON.stringify(
          {
            ...starter,
            artifacts: packet.requiredArtifacts.map((name) => ({
              name,
              status: statusFor(name),
              note: 'Represented in result.md.',
            })),
          },
          null,
          2,
        )}\n`,
      );
    };

    writeMap((name) => owned.get(name)!);
    const accepted = await scoreSealedEvidenceFixture(scenario, root);
    expect(
      accepted.evidence.find((line) => line.startsWith('required artifact accounting')),
    ).toBe('required artifact accounting: pass');

    // Negative control: marking the candidate-owned evaluation artifact as harness-owned is still
    // refused, so the repaired classifier did not simply accept every status.
    writeMap((name) => (name.includes('findability') ? 'external-evaluator' : owned.get(name)!));
    const refused = await scoreSealedEvidenceFixture(scenario, root);
    expect(
      refused.evidence.find((line) => line.startsWith('required artifact accounting')),
    ).toBe('required artifact accounting: fail');
  });

  test('keeps procurement evaluator metadata out of candidate-authored evidence guidance', async () => {
    const { scenario } = scenarioById('procurement-vendor-evaluation-full-task-1-individual');
    const root = workspace();
    const materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/professional-judgment@4',
    );
    expect(materializer).toBeDefined();
    await materializer!.materialize(root, scenario);

    const readme = readFixtureText(root, 'README.md');
    expect(readme).toContain('Records marked `evaluation-constraint` are evaluator-owned metadata');
    expect(readme).toContain(
      'Do not narrate routing, hierarchy/specialist selection, or matched-pair mechanics',
    );
    expect(readme).toContain('include only its `artifacts[]` row with status `external-evaluator`');
    expect(readme).toContain('never mark that artifact unavailable or claim an outcome for it');
  });

  test('starts red and passes only after evidence, checks, artifacts, and uncertainty are accounted for', async () => {
    const { scenario } = scenarioById('user-research-full-task-decision-linked-discovery');
    const root = workspace();
    const materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/professional-judgment@1',
    )!;
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

describe('exploratory sealed-evidence paired artifact ownership', () => {
  const exploratoryId = 'exploratory-data-analysis-full-task-1-individual';

  function exploratoryEvidence(map: { pairedStatus: string; note: string }) {
    return {
      claims: [
        {
          claim: 'The packet describes the observation unit and the missing interval.',
          evidenceIds: ['E01'],
          confidence: 'observed',
        },
      ],
      verification: [],
      artifacts: [
        {
          name: 'exploratory-data-analysis-individual-scenario-1-result',
          status: 'produced',
          note: 'Represented by result.md and verification.md in this bounded fixture.',
        },
        {
          name: 'exploratory-data-analysis-individual-scenario-1-verification',
          status: 'produced',
          note: 'Represented by result.md and verification.md in this bounded fixture.',
        },
        {
          name: 'exploratory-data-analysis-individual-scenario-1-paired-evaluation',
          status: map.pairedStatus,
          note: map.note,
        },
      ],
      limitations: ['No paired same-model outcome is present inside the sealed packet.'],
    };
  }

  test('the README states that the paired artifact is never marked unavailable', async () => {
    const { scenario } = scenarioById(exploratoryId);
    const root = workspace();
    const materializer = SEALED_EVIDENCE_SKILL_EVAL_MATERIALIZERS.find(
      (candidate) => candidate.id === 'sealed-evidence/exploratory-professional-judgment@2',
    )!;
    await materializer.materialize(root, scenario);
    const readme = readFixtureText(root, 'README.md');
    expect(readme).toContain('always uses `external-evaluator`, never `unavailable`');
    expect(readme).toContain('Candidate-owned required artifacts still use `produced`');
  });

  test('external-evaluator is accepted and unavailable is still refused for the paired artifact', async () => {
    const { scenario } = scenarioById(exploratoryId);
    const scoring = (pairedStatus: string, note: string) => {
      const root = workspace();
      writeFixtureFile(root, 'result.md', `# Exploratory analysis\n\n${'Observed ' + 'scope, units, missingness and censoring from the sealed packet only. '.repeat(4)}\n`);
      writeFixtureFile(root, 'verification.md', `# Verification\n\n${'Each falsifiable check is assessed from the sealed packet and unavailable facts stay unavailable. '.repeat(2)}\n`);
      writeFixtureFile(
        root,
        'evidence-map.json',
        `${JSON.stringify(exploratoryEvidence({ pairedStatus, note }), null, 2)}\n`,
      );
      return scoreSealedEvidenceFixture(scenario, root);
    };
    const accepted = scoring('external-evaluator', 'Produced by the outer matched evaluation harness.');
    expect(accepted.evidence.join('\n')).toContain('required artifact accounting: pass');
    const refused = scoring('unavailable', 'No paired run exists inside the sealed packet.');
    expect(refused.evidence.join('\n')).toContain('required artifact accounting: fail');
  });
});
