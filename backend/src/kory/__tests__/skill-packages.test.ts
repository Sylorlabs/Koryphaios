import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadV5SkillPackages, sourceFreshness, validateV5SkillPackage } from '../skill-packages';
import { auditV5SkillLibraryQuality } from '../skill-v5-quality';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('V5 skill packages', () => {
  test('loads a first-class held-out package with source provenance and full-task evals', () => {
    const catalog = loadV5SkillPackages();
    expect(catalog.errors).toEqual([]);
    // Source-freshness warnings advisory: they depend on wall-clock time and
    // inevitably appear as verifiedAt dates age. The guard here is against
    // any non-freshness defect.
    expect(
      catalog.warnings.filter(
        (item) => !item.includes('Source is stale under its declared policy'),
      ),
    ).toEqual([]);
    expect(catalog.packages).toHaveLength(182);
    const skillPackage = catalog.packages.find(
      (item) => item.sidecar.name === 'skill-authoring-evaluation',
    )!;
    expect(skillPackage.sidecar).toMatchObject({
      name: 'skill-authoring-evaluation',
      version: JSON.parse(readFileSync(join(skillPackage.directory, 'kory.json'), 'utf8')).version,
      skillKind: 'workflow',
    });
    expect(skillPackage.sidecar.sources.length).toBeGreaterThanOrEqual(3);
    expect(
      skillPackage.evaluation.routing.filter((item) => item.category === 'positive'),
    ).toHaveLength(5);
    expect(
      skillPackage.evaluation.routing.filter((item) => item.category === 'negative'),
    ).toHaveLength(5);
    expect(
      skillPackage.evaluation.routing.filter((item) => item.category === 'ambiguous'),
    ).toHaveLength(3);
    expect(
      skillPackage.evaluation.routing.filter((item) => item.category === 'adversarial'),
    ).toHaveLength(3);
    expect(skillPackage.evaluation.tasks).toHaveLength(2);
    for (const task of skillPackage.evaluation.tasks) {
      expect(task.scorers.some((scorer) => scorer.kind === 'deterministic')).toBe(true);
      expect(task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0)).toBeCloseTo(1);
    }
  });

  test('supports universal router packages with downstream bundle assertions', () => {
    const catalog = loadV5SkillPackages();
    const router = catalog.packages.find((item) => item.sidecar.name === 'task-routing')!;
    expect(router.sidecar).toMatchObject({
      name: 'task-routing',
      skillKind: 'router',
      selectionMode: 'universal',
      invocationMode: 'model-invoked',
    });
    expect(router.evaluation.routing).toHaveLength(16);
    expect(router.evaluation.routing.every((item) => item.expectedSelection)).toBe(true);
    expect(
      router.evaluation.routing.every(
        (item) => item.expectedSkills.length > 0 || item.forbiddenSkills.length > 0,
      ),
    ).toBe(true);
    expect(router.evaluation.tasks).toHaveLength(2);
  });

  test('keeps Plan mode explicit while preserving its host readiness contract', () => {
    const catalog = loadV5SkillPackages();
    const planMode = catalog.packages.find((item) => item.sidecar.name === 'plan-mode')!;
    expect(planMode.sidecar).toMatchObject({
      name: 'plan-mode',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      invocationMode: 'user-invoked',
      activation: ['plan mode'],
    });
    expect(planMode.instructions).toContain('Ask useful questions early and throughout');
    expect(planMode.instructions).toContain('KORY_PLAN_READY');
    expect(planMode.evaluation.routing).toHaveLength(16);
    expect(planMode.evaluation.tasks).toHaveLength(2);
  });

  test('loads human experience as a thin cross-discipline orchestrator', () => {
    const catalog = loadV5SkillPackages();
    const humanExperience = catalog.packages.find(
      (item) => item.sidecar.name === 'human-experience',
    )!;
    expect(humanExperience.sidecar).toMatchObject({
      name: 'human-experience',
      skillKind: 'orchestrator',
      selectionMode: 'conditional',
      targetMedia: ['any'],
    });
    expect(humanExperience.evaluation.routing).toHaveLength(16);
    expect(humanExperience.evaluation.tasks).toHaveLength(2);
  });

  test('loads user research with decision and evidence boundaries', () => {
    const catalog = loadV5SkillPackages();
    const userResearch = catalog.packages.find((item) => item.sidecar.name === 'user-research')!;
    expect(userResearch.sidecar).toMatchObject({
      name: 'user-research',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(userResearch.instructions).toContain('Start from the decision and uncertainty');
    expect(userResearch.evaluation.routing).toHaveLength(16);
    expect(userResearch.evaluation.tasks).toHaveLength(2);
  });

  test('loads interaction design with observable state and recovery contracts', () => {
    const catalog = loadV5SkillPackages();
    const interactionDesign = catalog.packages.find(
      (item) => item.sidecar.name === 'interaction-design',
    )!;
    expect(interactionDesign.sidecar).toMatchObject({
      name: 'interaction-design',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(interactionDesign.instructions).toContain(
      'Model each consequential interaction as an explicit contract',
    );
    expect(interactionDesign.evaluation.routing).toHaveLength(16);
    expect(interactionDesign.evaluation.tasks).toHaveLength(2);
  });

  test('loads information architecture with findability and organization boundaries', () => {
    const catalog = loadV5SkillPackages();
    const informationArchitecture = catalog.packages.find(
      (item) => item.sidecar.name === 'information-architecture',
    )!;
    expect(informationArchitecture.sidecar).toMatchObject({
      name: 'information-architecture',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(informationArchitecture.instructions).toContain(
      'Model the domain people must recognize',
    );
    expect(informationArchitecture.evaluation.routing).toHaveLength(16);
    expect(informationArchitecture.evaluation.tasks).toHaveLength(2);
  });

  test('loads visual interface design with brief-specific direction and rendered-state checks', () => {
    const catalog = loadV5SkillPackages();
    const visualInterfaceDesign = catalog.packages.find(
      (item) => item.sidecar.name === 'visual-interface-design',
    )!;
    expect(visualInterfaceDesign.sidecar).toMatchObject({
      name: 'visual-interface-design',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(visualInterfaceDesign.instructions).toContain('When the task supplies screenshots');
    expect(visualInterfaceDesign.instructions).toContain('similar defaults of generated design as prompts for justification');
    expect(visualInterfaceDesign.evaluation.routing).toHaveLength(16);
    expect(visualInterfaceDesign.evaluation.tasks).toHaveLength(2);
  });

  test('loads content and error design with truthful action-oriented language boundaries', () => {
    const catalog = loadV5SkillPackages();
    const contentErrorDesign = catalog.packages.find(
      (item) => item.sidecar.name === 'content-error-design',
    )!;
    expect(contentErrorDesign.sidecar).toMatchObject({
      name: 'content-error-design',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(contentErrorDesign.instructions).toContain("reader's decision and next useful action");
    expect(contentErrorDesign.instructions).toContain('Do not blame a person for service failure');
    expect(contentErrorDesign.evaluation.routing).toHaveLength(16);
    expect(contentErrorDesign.evaluation.tasks).toHaveLength(2);
  });

  test('loads accessibility practice as cross-medium design guidance rather than a web-only audit', () => {
    const catalog = loadV5SkillPackages();
    const accessibilityPractice = catalog.packages.find(
      (item) => item.sidecar.name === 'accessibility-practice',
    )!;
    expect(accessibilityPractice.sidecar).toMatchObject({
      name: 'accessibility-practice',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(accessibilityPractice.instructions).toContain('actual medium');
    expect(accessibilityPractice.instructions).toContain(
      'Route execution and conformance evidence',
    );
    expect(accessibilityPractice.instructions).toContain('Do not assume browser mechanics apply');
    expect(accessibilityPractice.evaluation.routing).toHaveLength(24);
    expect(accessibilityPractice.evaluation.tasks).toHaveLength(2);
  });

  test('loads usability evaluation with scoped task evidence and retest discipline', () => {
    const catalog = loadV5SkillPackages();
    const usabilityEvaluation = catalog.packages.find(
      (item) => item.sidecar.name === 'usability-evaluation',
    )!;
    expect(usabilityEvaluation.sidecar).toMatchObject({
      name: 'usability-evaluation',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(usabilityEvaluation.instructions).toContain('realistic goal-framed tasks');
    expect(usabilityEvaluation.instructions).toContain(
      'Preserve the observation layer before interpretation',
    );
    expect(usabilityEvaluation.instructions).toContain(
      'Retest consequential changes under comparable tasks and conditions',
    );
    expect(usabilityEvaluation.evaluation.routing).toHaveLength(16);
    expect(usabilityEvaluation.evaluation.tasks).toHaveLength(2);
  });

  test('loads developer experience as an end-to-end developer journey workflow', () => {
    const catalog = loadV5SkillPackages();
    const developerExperience = catalog.packages.find(
      (item) => item.sidecar.name === 'developer-experience',
    )!;
    expect(developerExperience.sidecar).toMatchObject({
      name: 'developer-experience',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      broader: ['human-experience'],
    });
    expect(developerExperience.instructions).toContain("developer's actual job");
    expect(developerExperience.instructions).toContain('shorten trustworthy feedback loops');
    expect(developerExperience.instructions).toContain('rollback, and removal');
    expect(developerExperience.evaluation.routing).toHaveLength(16);
    expect(developerExperience.evaluation.tasks).toHaveLength(2);
  });

  test('loads frontend engineering as a medium-neutral presentation boundary workflow', () => {
    const catalog = loadV5SkillPackages();
    const frontendEngineering = catalog.packages.find(
      (item) => item.sidecar.name === 'frontend-engineering',
    )!;
    expect(frontendEngineering.sidecar).toMatchObject({
      name: 'frontend-engineering',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      targetMedia: ['any'],
    });
    expect(frontendEngineering.instructions).toContain('target medium');
    expect(frontendEngineering.instructions).toContain('Keep domain state distinct');
    expect(frontendEngineering.instructions).toContain('Do not import DOM');
    expect(frontendEngineering.evaluation.routing).toHaveLength(16);
    expect(frontendEngineering.evaluation.tasks).toHaveLength(2);
  });

  test('loads web interface as a browser-specific semantic and runtime workflow', () => {
    const catalog = loadV5SkillPackages();
    const webInterface = catalog.packages.find((item) => item.sidecar.name === 'web-interface')!;
    expect(webInterface.sidecar).toMatchObject({
      name: 'web-interface',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      targetMedia: ['web'],
      broader: ['visual-interface-design', 'frontend-engineering'],
    });
    expect(webInterface.instructions).toContain('URL and history behavior');
    expect(webInterface.instructions).toContain('warning signals, not permanent bans');
    expect(webInterface.instructions).toContain('real page');
    expect(webInterface.evaluation.routing).toHaveLength(16);
    expect(webInterface.evaluation.tasks).toHaveLength(2);
  });

  test('loads native interface with separate desktop and mobile platform contracts', () => {
    const catalog = loadV5SkillPackages();
    const nativeInterface = catalog.packages.find(
      (item) => item.sidecar.name === 'native-interface',
    )!;
    expect(nativeInterface.sidecar).toMatchObject({
      name: 'native-interface',
      skillKind: 'workflow',
      selectionMode: 'conditional',
      targetMedia: ['native', 'mobile'],
      broader: ['visual-interface-design', 'frontend-engineering'],
    });
    expect(nativeInterface.instructions).toContain('For native visual anti-slop');
    expect(nativeInterface.instructions).toContain('On desktop');
    expect(nativeInterface.instructions).toContain('On mobile');
    expect(nativeInterface.evaluation.routing).toHaveLength(16);
    expect(nativeInterface.evaluation.tasks).toHaveLength(2);
  });

  test('rejects a held-out suite that leaks public routing fixtures', () => {
    const source = loadV5SkillPackages().packages[0]!;
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-package-'));
    temporaryRoots.push(root);
    const copy = join(root, source.sidecar.name);
    cpSync(source.directory, copy, { recursive: true });
    const sidecar = JSON.parse(readFileSync(join(copy, 'kory.json'), 'utf8')) as {
      routing: { positive: string[] };
    };
    const routingPath = join(copy, 'evals', 'routing.jsonl');
    const lines = readFileSync(routingPath, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]!) as { prompt: string };
    first.prompt = sidecar.routing.positive[0]!;
    lines[0] = JSON.stringify(first);
    writeFileSync(routingPath, `${lines.join('\n')}\n`);

    const validation = validateV5SkillPackage(copy, { now: new Date('2026-09-01T12:00:00Z') });
    expect(validation.valid).toBe(false);
    expect(
      validation.errors.some((error) => error.includes('duplicate public package fixtures')),
    ).toBe(true);
  });

  test('computes freshness from the source-specific stale-after policy', () => {
    const source = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'skill-authoring-evaluation',
    )!.sidecar.sources[0]!;
    // Derive the probe dates from the source's own verifiedAt and policy so a
    // genuine source refresh cannot silently re-point this control at a
    // different side of the stale-after boundary.
    const verified = new Date(`${source.verifiedAt}T00:00:00.000Z`);
    const atDays = (days: number) =>
      new Date(verified.getTime() + days * 86_400_000);
    expect(sourceFreshness(source, atDays(source.staleAfterDays))).toBe('fresh');
    expect(sourceFreshness(source, atDays(source.staleAfterDays + 1))).toBe('stale');
  });

  test('keeps the complete V5 package library individually authored, fresh, portable, and non-generic', () => {
    const audit = auditV5SkillLibraryQuality(
      loadV5SkillPackages(),
      new Date('2026-09-05T00:00:00Z'),
    );
    expect(audit.packageCount).toBe(182);
    expect(audit.catalogErrors).toEqual([]);
    expect(
      audit.catalogWarnings.filter(
        (item) => !item.includes('Source is stale under its declared policy'),
      ),
    ).toEqual([]);
    expect(audit.maturityCounts).toEqual({ individual: 182, scaffold: 0 });
    expect(audit.stalePackages).toEqual([]);
    expect(audit.weakSourceAuthorityPackages).toEqual([]);
    expect(audit.missingIndividualTaskPackages).toEqual([]);
    expect(audit.evaluationCoverageGaps).toEqual([]);
    expect(audit.portabilityViolations).toEqual([]);
    expect(audit.genericBodyPackages).toEqual([]);
    expect(audit.genericTaskPackages).toEqual([]);
    expect(audit.genericRoutingPackages).toEqual([]);
    expect(audit.duplicateBodyGroups).toEqual([]);
    expect(audit.repeatedParagraphPackages).toEqual([]);
    expect(audit.sharedBoilerplateGroups).toEqual([]);
    expect(audit.proseEmDashPackages).toEqual([]);
    expect(audit.hierarchyGaps).toEqual([]);
    expect(audit.stats.heldOutRouting.min).toBeGreaterThanOrEqual(16);
    expect(audit.stats.fullTasks).toEqual({ min: 2, median: 2, p95: 2, max: 2 });
  });

  test('validates invocation mode and repository-relative path scopes', () => {
    const source = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'skill-authoring-evaluation',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-package-'));
    temporaryRoots.push(root);
    const copy = join(root, source.sidecar.name);
    cpSync(source.directory, copy, { recursive: true });
    const sidecarPath = join(copy, 'kory.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>;
    sidecar.invocationMode = 'user-invoked';
    sidecar.pathScopes = ['../outside/**'];
    sidecar.requires = ['task-routing'];
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

    const validation = validateV5SkillPackage(copy);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        'pathScopes must be repository-relative and must not traverse parents: ../outside/**',
      ]),
    );
  });

  test('prevents automatic composition from depending on an explicit-only skill', () => {
    const catalog = loadV5SkillPackages();
    const taskRouting = catalog.packages.find((item) => item.sidecar.name === 'task-routing')!;
    const planMode = catalog.packages.find((item) => item.sidecar.name === 'plan-mode')!;
    const planning = catalog.packages.find((item) => item.sidecar.name === 'planning')!;
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-catalog-'));
    temporaryRoots.push(root);
    cpSync(taskRouting.directory, join(root, 'task-routing'), { recursive: true });
    cpSync(planMode.directory, join(root, 'plan-mode'), { recursive: true });
    cpSync(planning.directory, join(root, 'planning'), { recursive: true });

    const automaticSidecarPath = join(root, 'task-routing', 'kory.json');
    const automaticSidecar = JSON.parse(readFileSync(automaticSidecarPath, 'utf8')) as {
      requires: string[];
    };
    automaticSidecar.requires = [...automaticSidecar.requires, 'plan-mode'];
    writeFileSync(automaticSidecarPath, `${JSON.stringify(automaticSidecar, null, 2)}\n`);

    expect(loadV5SkillPackages(root).errors).toContain(
      'task-routing: model-invoked composition cannot implicitly depend on user-invoked skill plan-mode',
    );
  });

  test('allows an explicit-only skill to compose ordinary model-invoked skills', () => {
    const catalog = loadV5SkillPackages();
    const taskRouting = catalog.packages.find((item) => item.sidecar.name === 'task-routing')!;
    const planMode = catalog.packages.find((item) => item.sidecar.name === 'plan-mode')!;
    const planning = catalog.packages.find((item) => item.sidecar.name === 'planning')!;
    const root = mkdtempSync(join(tmpdir(), 'kory-v5-catalog-'));
    temporaryRoots.push(root);
    cpSync(taskRouting.directory, join(root, 'task-routing'), { recursive: true });
    cpSync(planMode.directory, join(root, 'plan-mode'), { recursive: true });
    cpSync(planning.directory, join(root, 'planning'), { recursive: true });

    const explicitSidecarPath = join(root, 'plan-mode', 'kory.json');
    const explicitSidecar = JSON.parse(readFileSync(explicitSidecarPath, 'utf8')) as {
      requires: string[];
    };
    explicitSidecar.requires = [...explicitSidecar.requires, 'task-routing'];
    writeFileSync(explicitSidecarPath, `${JSON.stringify(explicitSidecar, null, 2)}\n`);

    expect(loadV5SkillPackages(root).errors).toEqual([]);
  });
});
