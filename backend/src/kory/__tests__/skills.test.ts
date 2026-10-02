import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateSkill,
  applyDefaultUpdate,
  compareBundledSkill,
  countBundledUpdates,
  listSkills,
  resolveSkills,
  saveSkillDraft,
  testSkill,
  validateSkillContent,
  enforceSkillLearningPolicy,
  seedDefaultSkills,
  personalRoot,
  partitionRuntimeSkillHierarchyIssues,
  auditBundledSkillDefinitions,
  BUNDLED_SKILL_DEFINITIONS,
  createFreeformSkillDraft,
  createSkillDraft,
  deriveAuthoritativeTargetMedium,
  explicitSkillPinsFromPrompt,
  getBundledSkillContent,
  INCOMPATIBLE_EXTERNAL_SKILL_RESOURCES,
  matchesSkillTrigger,
  V5_SKILL_PACKAGE_CATALOG,
} from '../skills';
import {
  MANAGER_OUTPUT_TOKEN_LIMIT,
  MIN_SKILL_CONTEXT_BUDGET,
  compilePrompt,
  createTaskContract,
  deriveSkillContextBudget,
  requiresMultiAgentDelegation,
  textTokenUpperBound,
} from '../prompts';
import { registerLiveModelResolver } from '../../providers/models';
import {
  listHarnessQualifications,
  rankHarnessCandidates,
  saveHarnessQualification,
} from '../skill-qualifications';
import {
  buildSkillEvaluationCard,
  evaluateSkillPromotion,
  recordSkillEvaluationRun,
  recordSkillEvaluationRuns,
} from '../skill-evaluations';
import { syncSkillStewardRegistry } from '../skill-stewards';
import { SKILL_PLAYBOOKS } from '../skill-playbooks';
import { PLAN_MODE_SKILL_INSTRUCTIONS } from '../plan-mode-skill';
import { PROFESSIONAL_SKILL_DEFINITIONS } from '../professional-skill-definitions';

let root = '';
let skillsHome = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-skills-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-skills-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
  registerLiveModelResolver(() => undefined);
  delete process.env.KORYPHAIOS_SKILLS_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(skillsHome, { recursive: true, force: true });
});

/**
 * A spawned writer must not report a failure on stderr. Requiring stderr to be
 * byte-empty would instead fail this suite on any unrelated startup diagnostic
 * the child happens to emit — a nested-checkout config warning, for example,
 * which is correct behavior driven by where the checkout lives. Keep the
 * assertion on errors and drop the process logger's own lines.
 */
function stderrFailures(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && !/^\[\d{2}:\d{2}:\d{2}\]\s+(TRACE|DEBUG|INFO|WARN)/.test(line),
    );
}

describe('local Koryphaios skills', () => {
  test('enforces all three learning modes without limiting human control', () => {
    expect(() => enforceSkillLearningPolicy('human-only', 'human', 'activate')).not.toThrow();
    expect(() => enforceSkillLearningPolicy('human-only', 'agent', 'save-draft')).toThrow();
    expect(() =>
      enforceSkillLearningPolicy('propose-then-verify', 'agent', 'save-draft'),
    ).not.toThrow();
    expect(() => enforceSkillLearningPolicy('propose-then-verify', 'agent', 'activate')).toThrow();
    expect(() => enforceSkillLearningPolicy('automatic', 'agent', 'activate', false)).toThrow();
    expect(() => enforceSkillLearningPolicy('automatic', 'agent', 'activate', true)).not.toThrow();
  });
  test('seeds the complete instruction-only default library', () => {
    const active = listSkills(root).filter((skill) => skill.state === 'active');
    expect(active).toHaveLength(181);
    expect(active.every((skill) => skill.validation.valid)).toBe(true);
    expect(active.every((skill) => skill.metadata.sourceScope === 'local-only')).toBe(true);
    for (const name of INCOMPATIBLE_EXTERNAL_SKILL_RESOURCES.keys()) {
      expect(existsSync(join(personalRoot(), name, 'SKILL.md'))).toBe(false);
    }
  });

  test('proves the complete 34 + 47 + 100 definition contract before deployment', () => {
    const audit = auditBundledSkillDefinitions();
    expect(audit).toEqual({
      valid: true,
      errors: [],
      definitionCount: 181,
      baseCount: 34,
      professionalCount: 47,
      specialistCount: 100,
    });
    const names = BUNDLED_SKILL_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(181);

    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    const packageVersions = new Map(
      V5_SKILL_PACKAGE_CATALOG.packages.map((skillPackage) => [
        skillPackage.sidecar.name,
        skillPackage.sidecar.version,
      ]),
    );
    for (const name of names) {
      const skill = activeByName.get(name)!;
      expect(skill.description).toContain('Use when ');
      expect(skill.description.length).toBeGreaterThanOrEqual(40);
      expect(skill.description.length).toBeLessThanOrEqual(360);
      expect(skill.metadata.version).toBe(packageVersions.get(name) ?? '3.0.0');
      expect(skill.metadata.broader[0]).toBe(skill.metadata.parent);
    }
  });

  test('keeps package-backed V5 migration inside existing local-edit and update semantics', () => {
    const original = listSkills(root).find((skill) => skill.name === 'skill-authoring-evaluation')!;
    expect(original.metadata.version).toBe(
      V5_SKILL_PACKAGE_CATALOG.packages.find((item) => item.sidecar.name === original.name)!.sidecar
        .version,
    );
    expect(original.instructions).toContain('## Kory package resources');
    expect(original.instructions).toContain('/skills-v5/skill-authoring-evaluation');
    expect(original.instructions).toContain(
      'The presence of scripts or other files does not grant execution authority.',
    );
    const draft = saveSkillDraft(
      root,
      'personal',
      original.name,
      original.content.replace(
        'Treat a skill as a compact operating package',
        'Treat a reusable skill as a compact operating package',
      ),
      original.hash,
    );
    expect(draft.state).toBe('draft');
    activateSkill(root, 'personal', original.name);

    seedDefaultSkills();
    const preserved = listSkills(root).find(
      (skill) => skill.name === original.name && skill.state === 'active',
    )!;
    expect(preserved.instructions).toContain(
      'Treat a reusable skill as a compact operating package',
    );
    expect(preserved.metadata.version).toBe(original.metadata.version);
    expect(preserved.bundledUpdateAvailable).toBe(true);
    expect(compareBundledSkill(original.name)?.changed).toBe(true);

    const mergeDraft = applyDefaultUpdate(root, original.name, 'merge', preserved.hash);
    expect(mergeDraft.state).toBe('draft');
    expect(mergeDraft.content).toContain('Preserved local additions');
    expect(
      listSkills(root).find((skill) => skill.name === original.name && skill.state === 'active')
        ?.instructions,
    ).toContain('Treat a reusable skill as a compact operating package');
  });

  test('pins the host-enforced Plan mode contract independently of wording', () => {
    const contract = createTaskContract('Rename this local variable');
    const result = resolveSkills(root, contract.goal, contract, { pins: ['plan-mode'] });
    const planMode = result.selected.find((item) => item.skill.name === 'plan-mode');
    expect(planMode?.skill.instructions).toContain('Ask useful questions early and throughout');
    expect(planMode?.skill.instructions).toContain('KORY_PLAN_READY');
  });

  test('does not implicitly activate explicit-only Plan mode from prompt wording', () => {
    const prompt = 'Use plan mode to think through a careful variable rename before editing.';
    const contract = createTaskContract(prompt);
    const automatic = resolveSkills(root, prompt, contract, { contextBudget: 60_000 });
    expect(automatic.selected.map((item) => item.skill.name)).not.toContain('plan-mode');
    expect(automatic.rejectedCandidates).toContainEqual({
      name: 'plan-mode',
      reason: 'Rejected: skill requires explicit user invocation',
    });

    const pinned = resolveSkills(root, prompt, contract, {
      pins: ['plan-mode'],
      contextBudget: 60_000,
    });
    expect(pinned.selected.map((item) => item.skill.name)).toContain('plan-mode');
  });

  test('turns user skill syntax into resolver pins without weakening explicit-only routing', () => {
    expect(
      explicitSkillPinsFromPrompt('$plan-mode /verification rename this variable', [
        'plan-mode',
        'verification',
      ]),
    ).toEqual(['plan-mode', 'verification']);
    expect(explicitSkillPinsFromPrompt('/help explain this', ['help'])).toEqual([]);
    expect(explicitSkillPinsFromPrompt('/home/user/project', ['plan-mode'])).toEqual([]);

    for (const prompt of [
      '/skill plan-mode rename this local variable',
      '$plan-mode rename this local variable',
      '/plan-mode rename this local variable',
    ]) {
      const result = resolveSkills(root, prompt, createTaskContract(prompt), {
        contextBudget: 60_000,
      });
      expect(result.blocked).toBe(false);
      expect(
        result.selected.map((item) => item.skill.name),
        prompt,
      ).toContain('plan-mode');
      expect(result.selected.find((item) => item.skill.name === 'plan-mode')?.reason).toBe(
        'Pinned explicitly for this task',
      );
    }

    const unknown = '/skill definitely-missing-skill rename this variable';
    const unknownResult = resolveSkills(root, unknown, createTaskContract(unknown), {
      contextBudget: 60_000,
    });
    expect(unknownResult.blocked).toBe(true);
    expect(unknownResult.hierarchyErrors).toContain(
      'Pinned skill definitely-missing-skill is unavailable or invalid',
    );

    const ordinary = 'Use plan mode to think through a careful variable rename before editing.';
    expect(
      resolveSkills(root, ordinary, createTaskContract(ordinary), {
        contextBudget: 60_000,
      }).selected.map((item) => item.skill.name),
    ).not.toContain('plan-mode');
  });

  test('uses repository-relative path scopes as a secondary routing signal', () => {
    const prompt = 'Please review the current file and make the smallest correct change.';
    const contract = createTaskContract(prompt);
    const nested = resolveSkills(root, prompt, contract, {
      activePaths: ['infra/main.tf'],
      contextBudget: 60_000,
    });
    const terraform = nested.selected.find((item) => item.skill.name === 'terraform-iac');
    expect(terraform?.reason).toBe('Matched active repository path scope "**/*.tf"');
    expect(nested.evidence.contextPaths).toEqual(['infra/main.tf']);

    const rootLevel = resolveSkills(root, prompt, contract, {
      activePaths: ['main.tf'],
      contextBudget: 60_000,
    });
    expect(rootLevel.selected.map((item) => item.skill.name)).toContain('terraform-iac');

    const unrelated = resolveSkills(root, prompt, contract, {
      activePaths: ['src/main.ts'],
      contextBudget: 60_000,
    });
    expect(unrelated.selected.map((item) => item.skill.name)).not.toContain('terraform-iac');

    const outside = join(root, '..', 'outside.tf');
    const outsideResult = resolveSkills(root, prompt, contract, {
      activePaths: [outside],
      contextBudget: 60_000,
    });
    expect(outsideResult.evidence.contextPaths).toEqual([]);
    expect(outsideResult.selected.map((item) => item.skill.name)).not.toContain('terraform-iac');
  });

  test('loads V5 package cores without appending retired playbooks to migrated skills', () => {
    const skills = listSkills(root);
    const experience = skills.find((skill) => skill.name === 'human-experience')!;
    const visualDesign = skills.find((skill) => skill.name === 'visual-interface-design')!;
    const visualVerification = skills.find((skill) => skill.name === 'visual-verification')!;
    const routing = skills.find((skill) => skill.name === 'task-routing')!;
    expect(experience.instructions).toContain('Own the end-to-end human outcome');
    expect(experience.instructions).toContain('[Sources](references/sources.md)');
    expect(experience.instructions).not.toContain('Map entry, orientation, setup');
    expect(visualDesign.instructions).toContain('State a concise visual direction');
    expect(visualDesign.instructions).toContain(
      'Run a visual pre-flight on representative real-content states',
    );
    expect(visualDesign.instructions).toContain(
      'This skill owns visual direction and rendered-state critique',
    );
    expect(visualVerification.instructions).toContain(
      'Mark each visual claim passed, failed, or unavailable',
    );
    expect(visualVerification.instructions).toContain('do not force browser responsiveness');
    expect(routing.instructions).not.toContain('Map entry, orientation, setup');
  });

  test('keeps medium anti-slop guidance specific without weakening web checks', () => {
    const skills = listSkills(root);
    const web = skills.find((skill) => skill.name === 'web-interface')!;
    const native = skills.find((skill) => skill.name === 'native-interface')!;
    const terminal = skills.find((skill) => skill.name === 'terminal-interface')!;
    const embedded = skills.find((skill) => skill.name === 'embedded-interface')!;
    expect(web.instructions).toContain('For web visual anti-slop');
    expect(native.instructions).toContain('For native visual anti-slop');
    expect(terminal.instructions).toContain('For terminal anti-slop');
    expect(embedded.instructions).toContain('For embedded anti-slop');
  });

  test('preserves historical playbooks without requiring one for a new V5 package', () => {
    expect(PROFESSIONAL_SKILL_DEFINITIONS).toHaveLength(47);
    const definitionsWithPlaybooks = BUNDLED_SKILL_DEFINITIONS.filter(
      (definition) =>
        !['plan-mode', 'dash-free-writing', 'response-style'].includes(definition.name),
    );
    expect(Object.keys(SKILL_PLAYBOOKS).sort()).toEqual(
      definitionsWithPlaybooks.map((definition) => definition.name).sort(),
    );
    for (const definition of definitionsWithPlaybooks) {
      expect(SKILL_PLAYBOOKS[definition.name]?.split(/\s+/).length).toBeGreaterThan(100);
    }
    expect(PLAN_MODE_SKILL_INSTRUCTIONS.split(/\s+/).length).toBeGreaterThan(100);
    const writing = BUNDLED_SKILL_DEFINITIONS.find(
      (definition) => definition.name === 'dash-free-writing',
    )!;
    expect(writing.instructions).toContain('Preserve exact material');
    expect(SKILL_PLAYBOOKS[writing.name]).toBeUndefined();
  });

  test('keeps low-reasoning cross-medium trials out of web and stack defaults', () => {
    const scenarios = [
      {
        goal: 'Design the interaction and UX direction for a desktop-native visual editor for a new custom language. It must support keyboard-first use, screen-reader compatibility, large projects, errors, interruption, and recovery. Do not assume web technologies.',
        kind: 'ui' as const,
        medium: 'native',
        expected: ['human-experience', 'interaction-design', 'accessibility-practice'],
        forbidden: ['web-interface'],
      },
      {
        goal: 'Build a backend for an unfamiliar custom language toolchain; choose topology only after examining deployment, trust, latency, state, offline operation, and user/operator needs. The task gives no language, database, or network assumption.',
        kind: 'feature' as const,
        medium: 'any',
        expected: ['backend-engineering', 'compiler-runtime-backend'],
        forbidden: ['web-interface'],
      },
      {
        goal: 'Plan a privacy and authorization review for a local-first desktop device-control system that occasionally synchronizes. We do not yet know its network, operating system, identity, or storage design.',
        kind: 'security-infra' as const,
        medium: 'native',
        expected: ['application-security', 'authorization-security', 'privacy-engineering'],
        forbidden: ['embedded-device-security'],
      },
    ];
    for (const scenario of scenarios) {
      const result = resolveSkills(
        root,
        scenario.goal,
        createTaskContract(scenario.goal, { taskKind: scenario.kind }),
        { targetMedium: scenario.medium },
      );
      const selected = result.selected.map((item) => item.skill.name);
      for (const name of scenario.expected) expect(selected).toContain(name);
      for (const name of scenario.forbidden) expect(selected).not.toContain(name);
    }
  });

  test('reports and ignores metadata that attempts to grant authority', () => {
    const content = listSkills(root)[0].content.replace(
      'metadata:',
      'allowed-tools: [bash]\nnetwork: true\nmetadata:',
    );
    const result = validateSkillContent(content);
    expect(result.valid).toBe(true);
    expect(result.ignoredAuthorityClaims).toEqual(['allowed-tools', 'network']);
  });

  test('keeps direct edits draft-only until validation and trigger tests pass', () => {
    const original = listSkills(root).find((skill) => skill.name === 'implementation')!;
    const draft = saveSkillDraft(
      root,
      'personal',
      'implementation',
      original.content.replace('smallest coherent', 'smallest sufficient'),
      original.hash,
    );
    expect(draft.state).toBe('draft');
    expect(
      listSkills(root).find((skill) => skill.name === 'implementation' && skill.state === 'active')
        ?.hash,
    ).toBe(original.hash);
    expect(testSkill(draft).passed).toBe(true);
    const activated = activateSkill(root, 'personal', 'implementation');
    expect(activated.content).toContain('smallest sufficient');
    const directory = join(personalRoot(), 'implementation');
    expect(existsSync(join(directory, 'DRAFT.md'))).toBe(false);
    const retiredDraft = readdirSync(directory).find((name) => name.startsWith('DRAFT.activated-'));
    expect(retiredDraft).toBeDefined();
    expect(readFileSync(join(directory, retiredDraft!), 'utf8')).toBe(draft.content);
  });

  test('creates a portable native-editor draft instead of calling a missing route', () => {
    const draft = createSkillDraft(root, {
      source: 'project',
      name: 'release-evidence-review',
      description:
        'Review release evidence and recovery claims. Use when a release candidate needs an independent readiness check.',
      instructions:
        'Inspect the claimed gates, reproduce the highest-risk checks, record unavailable evidence, and reject unsupported readiness claims.',
      domains: ['release', 'verification'],
      activation: ['release evidence', 'readiness review'],
      shouldTrigger: ['review this release evidence', 'check release readiness claims'],
      shouldNotTrigger: ['write a marketing headline', 'rename this local variable'],
      evidence: ['Reproduced gates', 'Explicit unavailable checks'],
      broader: ['verification'],
      facets: ['security-review'],
      requires: ['testing-engineering'],
      conflicts: ['documents-communication'],
      excludes: ['marketing only'],
      targetMedia: ['wearable display'],
      depth: 1,
      contextBudget: 2600,
    });
    expect(draft.state).toBe('draft');
    expect(draft.description.startsWith('Review release evidence')).toBe(true);
    expect(draft.metadata.broader).toEqual(['verification']);
    expect(draft.metadata.facets).toEqual(['security-review']);
    expect(draft.metadata.requires).toEqual(['testing-engineering']);
    expect(draft.metadata.conflicts).toEqual(['documents-communication']);
    expect(draft.metadata.excludes).toEqual(['marketing only']);
    expect(draft.metadata.targetMedia).toEqual(['wearable display']);
    expect(draft.metadata.depth).toBe(1);
    expect(draft.metadata.contextBudget).toBe(2600);
    expect(draft.validation.valid).toBe(true);
    expect(testSkill(draft).passed).toBe(true);
    expect(() =>
      createSkillDraft(root, {
        source: 'project',
        name: 'release-evidence-review',
        description:
          'Attempt to replace an existing draft. Use when collision behavior itself is under test.',
        instructions:
          'This content must never replace the already-created same-scope draft or any of its user data.',
        domains: ['verification'],
        activation: ['replace existing draft'],
        shouldTrigger: ['replace this existing draft', 'test same scope creation'],
        shouldNotTrigger: ['write a slogan', 'rename a variable'],
        evidence: ['Original draft remains byte-identical'],
      }),
    ).toThrow('already exists in project scope');
    expect(readFileSync(join(root, '.koryphaios', 'skills', draft.name, 'DRAFT.md'), 'utf8')).toBe(
      draft.content,
    );
  });

  test('creates a freeform draft without requiring the routing template', () => {
    const draft = createFreeformSkillDraft(root, {
      source: 'project',
      name: 'my-own-workflow',
      description: 'Follow my custom workflow exactly as written.',
      instructions: 'Do the first thing, make the user-defined decision, then verify the result.',
    });

    expect(draft.state).toBe('draft');
    expect(draft.instructions).toContain('make the user-defined decision');
    expect(draft.metadata.activation).toEqual([]);
    expect(draft.metadata.shouldTrigger).toEqual([]);
    expect(draft.metadata.targetMedia).toEqual(['any']);
    expect(draft.validation.valid).toBe(true);
    expect(testSkill(draft).passed).toBe(false);
  });

  test('publishes same-scope drafts with a process-safe no-replace CAS and bounded stale cleanup', async () => {
    seedDefaultSkills();
    const skillsModuleUrl = new URL('../skills.ts', import.meta.url).href;
    const description =
      'Audit concurrent same-scope creation. Use when process-safe no-overwrite behavior requires independent verification.';
    const baseInput = {
      source: 'project',
      description,
      domains: ['verification'],
      activation: ['concurrent creation audit'],
      shouldTrigger: ['audit concurrent skill creation', 'verify same scope race safety'],
      shouldNotTrigger: ['write a slogan', 'rename a variable'],
      evidence: ['One winner and one conflict'],
    };

    const staleName = 'stale-publication-recovery';
    const staleDirectory = join(root, '.koryphaios', 'skills', staleName);
    mkdirSync(staleDirectory, { recursive: true });
    const staleTemporary = join(staleDirectory, 'DRAFT.create-crashed-process.tmp');
    writeFileSync(staleTemporary, 'fully unpublished stale bytes');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(staleTemporary, old, old);
    createSkillDraft(root, {
      ...baseInput,
      name: staleName,
      instructions:
        'Publish a new verified draft and remove only the bounded stale temporary file left by an interrupted prior publication.',
    });
    expect(existsSync(staleTemporary)).toBe(false);

    for (let index = 0; index < 6; index += 1) {
      const name = `same-scope-process-race-${index}`;
      const barrier = join(root, `skill-create-barrier-${index}`);
      const code = `
        import { existsSync } from 'node:fs';
        import { createSkillDraft } from ${JSON.stringify(skillsModuleUrl)};
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.KORY_SKILL_CREATE_BARRIER)) Atomics.wait(sleeper, 0, 0, 2);
        const marker = process.env.KORY_SKILL_CREATE_MARKER;
        try {
          createSkillDraft(process.env.KORY_SKILL_CREATE_PROJECT, {
            ${Object.entries(baseInput)
              .map(([key, value]) => `${key}: ${JSON.stringify(value)},`)
              .join('\n')}
            name: ${JSON.stringify(name)},
            instructions: 'Preserve the first concurrent writer and reject the other without replacement. Durable writer marker: ' + marker,
          });
          console.log('OK:' + marker);
        } catch (error) {
          console.log((error?.name === 'SkillDraftConflictError' ? 'CONFLICT:' : 'ERROR:') + marker + ':' + String(error));
        }
      `;
      const spawnWriter = (marker: 'A' | 'B') =>
        Bun.spawn([process.execPath, '-e', code], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            KORYPHAIOS_SKILLS_HOME: skillsHome,
            KORY_SKILL_CREATE_PROJECT: root,
            KORY_SKILL_CREATE_BARRIER: barrier,
            KORY_SKILL_CREATE_MARKER: marker,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
      const writers = [spawnWriter('A'), spawnWriter('B')];
      writeFileSync(barrier, 'go');
      const outputs = await Promise.all(
        writers.map(async (writer) => {
          const [exitCode, stdout, stderr] = await Promise.all([
            writer.exited,
            new Response(writer.stdout).text(),
            new Response(writer.stderr).text(),
          ]);
          expect(exitCode).toBe(0);
          expect(stderrFailures(stderr)).toEqual([]);
          return stdout.trim();
        }),
      );
      expect(outputs.filter((output) => output.startsWith('OK:'))).toHaveLength(1);
      expect(outputs.filter((output) => output.startsWith('CONFLICT:'))).toHaveLength(1);
      const winner = outputs.find((output) => output.startsWith('OK:'))!.slice(3);
      const persisted = readFileSync(join(root, '.koryphaios', 'skills', name, 'DRAFT.md'), 'utf8');
      expect(persisted).toContain(`Durable writer marker: ${winner}`);
      expect(
        readdirSync(join(root, '.koryphaios', 'skills', name)).filter((entry) =>
          entry.startsWith('DRAFT.create-'),
        ),
      ).toEqual([]);
    }
  });

  test('rejects a draft whose frontmatter name diverges from its stable directory id', () => {
    const implementation = listSkills(root).find((skill) => skill.name === 'implementation')!;
    saveSkillDraft(
      root,
      'personal',
      'implementation',
      implementation.content.replace('name: implementation', 'name: forged-implementation'),
      implementation.hash,
    );
    expect(() => activateSkill(root, 'personal', 'implementation')).toThrow(
      'Skill frontmatter name must match its directory name',
    );
  });

  test('rejects unsafe structured relations before writing a draft', () => {
    const base = {
      source: 'project' as const,
      name: 'bounded-review',
      description:
        'Review bounded evidence and recovery behavior. Use when a local change needs focused independent verification.',
      instructions:
        'Inspect the claimed behavior, reproduce the relevant boundary, record exact evidence, and reject unsupported completion claims.',
      domains: ['verification'],
      activation: ['bounded review'],
      shouldTrigger: ['review this bounded change', 'verify this recovery behavior'],
      shouldNotTrigger: ['write a product slogan', 'rename a local variable'],
      evidence: ['Reproduced behavior'],
      targetMedia: ['any'],
      depth: 0,
      contextBudget: 2000,
    };
    expect(() => createSkillDraft(root, { ...base, broader: ['../verification'] })).toThrow(
      'Invalid broader skill ID',
    );
    expect(() => createSkillDraft(root, { ...base, broader: ['missing-skill'], depth: 1 })).toThrow(
      'Unknown related skill ID',
    );
    expect(() =>
      createSkillDraft(root, {
        ...base,
        name: 'verification',
        source: 'project',
        broader: ['functional-verification'],
        depth: 2,
      }),
    ).toThrow('Hierarchy cycle detected');
    expect(() =>
      createSkillDraft(root, {
        ...base,
        name: 'testing-engineering',
        source: 'project',
        requires: ['property-fuzz-differential-testing'],
      }),
    ).toThrow('Skill dependency cycle detected');
    expect(existsSync(join(root, '.koryphaios', 'skills', base.name, 'DRAFT.md'))).toBe(false);
  });

  test('selects small relevant bundles and blocks unresolved personal/project collisions', () => {
    const contract = createTaskContract('Fix the native settings crash');
    const result = resolveSkills(root, contract.goal, contract, { targetMedium: 'native' });
    expect(result.blocked).toBe(false);
    expect(result.selected.map((item) => item.skill.name)).toContain('debugging');
    expect(result.totalContextCost).toBeLessThanOrEqual(30_000);

    const personal = listSkills(root).find((skill) => skill.name === 'debugging')!;
    const directory = join(root, '.koryphaios', 'skills', 'debugging');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      personal.content.replace('version: 3.0.0', 'version: 3.0.1'),
    );
    const collision = resolveSkills(root, contract.goal, contract);
    expect(collision.blocked).toBe(true);
    expect(collision.collisions[0]?.name).toBe('debugging');
    expect(
      resolveSkills(root, contract.goal, contract, { collisionChoices: { debugging: 'project' } })
        .blocked,
    ).toBe(false);
  });

  test('walks from cross-domain frontend practice into evidence-matched medium children', () => {
    const web = createTaskContract('Build a professional accessible web interface');
    const webNames = resolveSkills(root, web.goal, web).selected.map((item) => item.skill.name);
    expect(webNames).toContain('frontend-engineering');
    expect(webNames).toContain('human-experience');
    expect(webNames).toContain('interaction-design');
    expect(webNames).toContain('accessibility-practice');
    expect(webNames).toContain('web-interface');
    expect(webNames).not.toContain('novel-ui-toolkit');

    const toolkit = createTaskContract('Build a native UI toolkit for a custom language');
    const toolkitNames = resolveSkills(root, toolkit.goal, toolkit).selected.map(
      (item) => item.skill.name,
    );
    expect(toolkitNames).toContain('frontend-engineering');
    expect(toolkitNames).toContain('novel-ui-toolkit');
    expect(toolkitNames).not.toContain('web-interface');
  });

  test('routes backend topology without importing network or storage defaults', () => {
    const inProcess = createTaskContract('Implement an in-process game simulation backend in C');
    const localNames = resolveSkills(root, inProcess.goal, inProcess).selected.map(
      (item) => item.skill.name,
    );
    expect(localNames).toContain('backend-engineering');
    expect(localNames).toContain('in-process-backend');
    expect(localNames).not.toContain('network-service-backend');
    expect(localNames).not.toContain('web-interface');

    const compiler = createTaskContract('Build a compiler runtime for a custom language');
    const compilerNames = resolveSkills(root, compiler.goal, compiler).selected.map(
      (item) => item.skill.name,
    );
    expect(compilerNames).toContain('compiler-runtime-backend');
    expect(compilerNames).not.toContain('network-service-backend');
    expect(compilerNames).not.toContain('local-service-backend');
  });

  test('selects professional evidence methods instead of a generic test-framework default', () => {
    const fuzz = createTaskContract('Add property tests and fuzz this binary parser');
    const fuzzNames = resolveSkills(root, fuzz.goal, fuzz).selected.map((item) => item.skill.name);
    expect(fuzzNames).toContain('testing-engineering');
    expect(fuzzNames).toContain('property-fuzz-differential-testing');
    expect(fuzzNames).not.toContain('interface-usability-testing');

    const device = createTaskContract('Run hardware in loop tests for this embedded controller');
    const deviceNames = resolveSkills(root, device.goal, device).selected.map(
      (item) => item.skill.name,
    );
    expect(deviceNames).toContain('simulation-device-testing');
    expect(deviceNames).not.toContain('web-interface');
  });

  test('routes professional branches across security data research debugging and communication', () => {
    const cases: Array<[string, string, string]> = [
      [
        'Threat model a custom language runtime sandbox',
        'language-runtime-security',
        'infrastructure-security',
      ],
      ['Design a blinded LLM evaluation benchmark', 'llm-evaluation', 'data-visualization'],
      [
        'Review research papers on agent routing',
        'literature-research',
        'market-competitive-research',
      ],
      ['Debug a race condition in the scheduler', 'concurrency-debugging', 'distributed-debugging'],
      [
        'Write a setup guide with recovery steps',
        'instructional-communication',
        'executive-communication',
      ],
    ];
    for (const [prompt, expected, rejected] of cases) {
      const contract = createTaskContract(prompt);
      const names = resolveSkills(root, contract.goal, contract).selected.map(
        (item) => item.skill.name,
      );
      expect(names).toContain(expected);
      expect(names).not.toContain(rejected);
    }
  });

  test('preserves actual nested hierarchy depth', () => {
    const skill = listSkills(root).find((item) => item.name === 'authorization-security')!;
    expect(skill.metadata.parent).toBe('application-security');
    expect(skill.metadata.depth).toBe(2);
    const web = listSkills(root).find((item) => item.name === 'web-interface')!;
    expect(web.metadata.parent).toBe('visual-interface-design');
    expect(web.metadata.broader).toEqual(['visual-interface-design', 'frontend-engineering']);
    expect(web.metadata.facets).toEqual(['interaction-design', 'accessibility-practice']);
  });

  test('keeps v2 single-parent skills readable through the compatibility breadcrumb', () => {
    const directory = join(root, '.koryphaios', 'skills', 'legacy-v2-review');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---
name: legacy-v2-review
description: Review legacy recovery evidence. Use when a v2 local skill must remain readable after the hierarchy migration.
metadata:
  koryphaios:
    version: 2.0.0
    baseVersion: 2.0.0
    baseHash: legacy-v2
    parent: verification
    depth: 1
    requires: []
    conflicts: []
    activation: ["legacy recovery review"]
    excludes: []
    domains: ["verification"]
    targetMedia: ["any"]
    shouldTrigger: ["review this legacy recovery", "verify this v2 evidence"]
    shouldNotTrigger: ["write a slogan", "rename a variable"]
    evidence: ["Legacy evidence reviewed"]
    contextBudget: 2000
    sourceScope: local-only
---
# legacy-v2-review

Inspect the legacy behavior, preserve the stable skill ID, and record evidence before completion.
`,
    );
    const legacy = listSkills(root).find((skill) => skill.name === 'legacy-v2-review')!;
    expect(legacy.validation.valid).toBe(true);
    expect(legacy.metadata.parent).toBe('verification');
    expect(legacy.metadata.broader).toEqual(['verification']);
    expect(legacy.metadata.facets).toEqual([]);
    const prompt = 'Please perform a legacy recovery review';
    const selected = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 10_000,
    }).selected.map((item) => item.skill.name);
    expect(selected).toContain('legacy-v2-review');
    expect(selected).toContain('verification');
  });

  test('keeps game spatial and embedded interface work out of the web branch', () => {
    const game = createTaskContract('Design a game HUD for controller and keyboard input');
    const gameNames = resolveSkills(root, game.goal, game).selected.map((item) => item.skill.name);
    expect(gameNames).toContain('game-spatial-interface');
    expect(gameNames).not.toContain('web-interface');

    const embedded = createTaskContract('Design an embedded UI for an industrial control panel');
    const embeddedNames = resolveSkills(root, embedded.goal, embedded).selected.map(
      (item) => item.skill.name,
    );
    expect(embeddedNames).toContain('embedded-interface');
    expect(embeddedNames).not.toContain('web-interface');
  });

  test('enforces declared hierarchy conflicts before prompt compilation', () => {
    const terminal = listSkills(root).find((skill) => skill.name === 'terminal-interface')!;
    saveSkillDraft(
      root,
      'personal',
      'terminal-interface',
      terminal.content.replace('conflicts: []', 'conflicts: ["web-interface"]'),
      terminal.hash,
    );
    activateSkill(root, 'personal', 'terminal-interface');
    const contract = createTaskContract('Build a web and terminal interface');
    const result = resolveSkills(root, contract.goal, contract);
    expect(result.blocked).toBe(true);
    expect(result.selectionConflicts).toEqual([
      { left: 'terminal-interface', right: 'web-interface' },
    ]);
  });

  test('rejects missing hierarchy dependencies before activation', () => {
    const web = listSkills(root).find((skill) => skill.name === 'web-interface')!;
    saveSkillDraft(
      root,
      'personal',
      'web-interface',
      web.content
        .replace('parent: visual-interface-design', 'parent: missing-design-discipline')
        .replace(
          'broader: ["visual-interface-design", "frontend-engineering"]',
          'broader: ["missing-design-discipline", "frontend-engineering"]',
        ),
      web.hash,
    );
    expect(() => activateSkill(root, 'personal', 'web-interface')).toThrow(
      'web-interface references missing broader missing-design-discipline',
    );
    const result = resolveSkills(
      root,
      'Build a web interface',
      createTaskContract('Build a web interface'),
    );
    expect(result.hierarchyErrors).toEqual([]);
  });

  test('keeps derived depth metadata drift non-blocking during normal resolution', () => {
    expect(
      partitionRuntimeSkillHierarchyIssues([
        'database-performance declares depth 3, expected 2',
        'broken-skill references missing broader missing-parent',
      ]),
    ).toEqual({
      errors: ['broken-skill references missing broader missing-parent'],
      warnings: ['Skill metadata warning: database-performance declares depth 3, expected 2'],
    });
    const contract = createTaskContract('Diagnose a slow database query');
    const result = resolveSkills(root, contract.goal, contract, { contextBudget: 60_000 });
    expect(result.hierarchyErrors.some((error) => error.includes(' declares depth '))).toBe(false);
    expect(result.blocked).toBe(false);
  });

  test('routes polyhierarchy and one-hop facets without treating technology as a discipline', () => {
    const contract = createTaskContract(
      'Design and build an accessible browser interface for a long-form research workspace',
      { taskKind: 'ui' },
    );
    const result = resolveSkills(root, contract.goal, contract, { contextBudget: 60_000 });
    const names = result.selected.map((item) => item.skill.name);
    expect(result.hierarchyErrors).toEqual([]);
    expect(names).toContain('web-interface');
    expect(names).toContain('visual-interface-design');
    expect(names).toContain('frontend-engineering');
    expect(names).toContain('human-experience');
    expect(names).toContain('interaction-design');
    expect(names).toContain('accessibility-practice');
    expect(
      result.selected.find((item) => item.skill.name === 'interaction-design')?.reason,
    ).toContain('Professional facet of web-interface');
  });

  test('surfaces broader, facet, and narrower hierarchy breadcrumbs in loaded skill guidance', () => {
    const contract = createTaskContract(
      'Design and build an accessible browser interface for a research workspace',
      { taskKind: 'ui' },
    );
    const result = resolveSkills(root, contract.goal, contract, { contextBudget: 60_000 });
    const web = result.selected.find((item) => item.skill.name === 'web-interface')!;
    expect(web.promptText).toContain(
      'Broader skills: visual-interface-design, frontend-engineering',
    );
    expect(web.promptText).toContain(
      'Cross-cutting facets: interaction-design, accessibility-practice',
    );
    const frontend = result.selected.find((item) => item.skill.name === 'frontend-engineering')!;
    expect(frontend.promptText).toContain('Narrower available skills:');
    expect(frontend.promptText).toContain('react-engineering');
    expect(frontend.promptText).toContain(
      'Prefer a narrower child when the task establishes that child boundary',
    );
  });

  test('forward-tests every non-universal definition with phrased trigger and non-trigger requests', () => {
    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    for (const definition of BUNDLED_SKILL_DEFINITIONS) {
      if (definition.name === 'task-routing') continue;
      const skill = activeByName.get(definition.name)!;
      const positive = `Please ${definition.should[0]} for the current project, and show the evidence.`;
      expect(matchesSkillTrigger(skill, positive)).toBe(true);

      const negative = `Please ${definition.shouldNot[0]} for the current project.`;
      expect(matchesSkillTrigger(skill, negative)).toBe(false);
    }
  });

  test('keeps non-prefixed adjectives from negating later routing triggers', () => {
    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    const userResearch = activeByName.get('user-research')!;
    const web = activeByName.get('web-interface')!;
    expect(
      matchesSkillTrigger(
        userResearch,
        'Create a non-leading user interview guide and recruitment plan.',
      ),
    ).toBe(true);
    expect(matchesSkillTrigger(web, 'Build a non-web interface for this tool.')).toBe(false);
  });

  test('applies exclusions only when the excluded scope is requested', () => {
    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    const skill = structuredClone(activeByName.get('release-planning')!);
    skill.metadata.activation = ['release coordination'];
    skill.metadata.excludes = ['deployment mechanics'];
    skill.metadata.shouldTrigger = ['Coordinate release coordination across owners.'];
    skill.metadata.shouldNotTrigger = [];

    expect(
      matchesSkillTrigger(
        skill,
        'Coordinate release coordination across owners without changing deployment mechanics.',
      ),
    ).toBe(true);
    expect(
      matchesSkillTrigger(
        skill,
        'Coordinate release coordination across owners and change deployment mechanics.',
      ),
    ).toBe(false);
  });

  test('treats explicitly deferred or rejected skill phrases as negative routing evidence', () => {
    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    expect(
      matchesSkillTrigger(
        activeByName.get('visual-interface-design')!,
        'Design the editor behavior and recovery states. Visual polish can come later.',
      ),
    ).toBe(false);
    expect(
      matchesSkillTrigger(
        activeByName.get('oauth-oidc')!,
        'Harden password plus MFA login. OAuth provider plumbing is not the task.',
      ),
    ).toBe(false);
    expect(
      matchesSkillTrigger(
        activeByName.get('agentic-systems')!,
        'Build a model evaluation suite. The runtime agent architecture is fixed.',
      ),
    ).toBe(false);
    expect(
      matchesSkillTrigger(
        activeByName.get('embedded-firmware')!,
        'Treat device firmware and hardware trust as an unchanged dependency.',
      ),
    ).toBe(false);

    const prompt =
      'Build an embedded job scheduler inside the host process, with no daemon and no network service.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    expect(result.selected.map((item) => item.skill.name)).toContain('in-process-backend');
    expect(
      result.selected.some(
        (item) =>
          item.skill.name === 'local-service-backend' &&
          item.reason === 'Matched collected topology:local-service evidence',
      ),
    ).toBe(false);
  });

  test('routes independent ordinary paraphrases and rejects substring/adversarial collisions', () => {
    const cases: Array<{ prompt: string; includes: string[]; excludes: string[] }> = [
      {
        prompt: 'Design navigation and recovery for a desktop clinical editor',
        includes: ['native-interface', 'information-architecture', 'content-error-design'],
        excludes: ['terminal-interface', 'web-interface', 'debugging'],
      },
      {
        prompt: 'Build an accessible browser analytics interface',
        includes: ['web-interface', 'accessibility-practice'],
        excludes: ['terminal-interface', 'native-interface'],
      },
      {
        prompt: 'Create a pipe-safe command-line client',
        includes: ['terminal-interface'],
        excludes: ['web-interface', 'native-interface'],
      },
      {
        prompt: 'Create a rendering toolkit for a custom language',
        includes: ['novel-ui-toolkit'],
        excludes: ['compiler-runtime-backend', 'web-interface'],
      },
      {
        prompt: 'Implement an in-process simulation core',
        includes: ['in-process-backend'],
        excludes: ['local-service-backend', 'network-service-backend'],
      },
      {
        prompt: 'Build a local IPC daemon',
        includes: ['local-service-backend'],
        excludes: ['compiler-runtime-backend', 'network-service-backend'],
      },
      {
        prompt: 'Fuzz a binary parser with malformed inputs',
        includes: ['property-fuzz-differential-testing'],
        excludes: ['interface-usability-testing'],
      },
      {
        prompt: 'Assess an application authorization policy',
        includes: ['application-security', 'authorization-security'],
        excludes: ['infrastructure-security'],
      },
      {
        prompt: 'Visualize experimental uncertainty',
        includes: ['data-visualization', 'statistical-inference'],
        excludes: ['exploratory-data-analysis'],
      },
      {
        prompt: 'Write an installation and recovery guide',
        includes: ['instructional-communication'],
        excludes: ['executive-communication'],
      },
      {
        prompt: 'Rename this function in the current project',
        includes: ['task-routing'],
        excludes: ['research', 'terminal-interface'],
      },
      {
        prompt: 'Implement an in-process backend',
        includes: ['in-process-backend'],
        excludes: ['local-service-backend', 'network-service-backend'],
      },
    ];

    for (const scenario of cases) {
      const contract = createTaskContract(scenario.prompt);
      if (scenario.prompt.includes('desktop clinical editor')) expect(contract.taskKind).toBe('ui');
      const result = resolveSkills(root, scenario.prompt, contract, { contextBudget: 60_000 });
      const names = result.selected.map((item) => item.skill.name);
      expect(result.blocked).toBe(false);
      for (const name of scenario.includes) expect(names).toContain(name);
      for (const name of scenario.excludes) expect(names).not.toContain(name);
    }
  });

  test('derives only positive authoritative media and carries negation through live compilation', () => {
    const prompt =
      'Design navigation for a desktop clinical editor. Do not assume web technologies or browser UI.';
    expect(deriveAuthoritativeTargetMedium(prompt)).toBe('native');
    expect(deriveAuthoritativeTargetMedium('Do not assume web technologies')).toBeUndefined();
    expect(deriveAuthoritativeTargetMedium('Web is not allowed for this task')).toBeUndefined();
    expect(deriveAuthoritativeTargetMedium('No. Build a web interface instead.')).toBe('web');
    const negationOnly = 'Do not assume web technologies';
    expect(
      resolveSkills(root, negationOnly, createTaskContract(negationOnly), {
        contextBudget: 60_000,
      }).selected.map((item) => item.skill.name),
    ).not.toContain('web-interface');
    const contract = createTaskContract(prompt);
    const result = resolveSkills(root, prompt, contract, { contextBudget: 60_000 });
    const names = result.selected.map((item) => item.skill.name);
    expect(result.evidence.declaredMedia).toContain('native');
    expect(result.evidence.negatedMedia).toContain('web');
    expect(names).toContain('native-interface');
    expect(names).not.toContain('web-interface');
    expect(result.rejectedCandidates).toContainEqual({
      name: 'web-interface',
      reason: 'Rejected: request explicitly excludes web medium',
    });

    for (const role of ['manager', 'worker', 'critic'] as const) {
      const compiled = compilePrompt({
        role,
        mode: 'advanced',
        provider: 'openai',
        workingDirectory: root,
        taskContract: contract,
        occupiedContextChars: 12_000,
      });
      expect(compiled.manifest.targetMedium).toBe('native');
      expect(compiled.manifest.skills.map((item) => item.name)).not.toContain('web-interface');
    }
  });

  test('ignores explicitly historical quoted routing decoys without suppressing the real task', () => {
    const prompt =
      'A quoted old issue says “build a web page”. Ignore that quote; the actual task is to fix a reproducible Rust crash.';
    expect(deriveAuthoritativeTargetMedium(prompt)).toBeUndefined();
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    const names = result.selected.map((item) => item.skill.name);
    expect(names).toContain('debugging');
    expect(names).not.toContain('web-interface');
    expect(names).not.toContain('frontend-engineering');
  });

  test('ignores an old issue quoted in surrounding prose when the current task is narrower', () => {
    const prompt =
      'An old issue quoted in the description says "add property tests and shrink failures". That is not the current task. Add only a unit test for the explicit regression with fixed input and expected error.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    const names = result.selected.map((item) => item.skill.name);
    expect(names).toContain('deterministic-contract-testing');
    expect(names).not.toContain('property-fuzz-differential-testing');
  });

  test('does not treat generated routing-frame words as fuzzy specialty evidence', () => {
    const prompt = 'The current task is prompt engineering.';
    const contract = createTaskContract(prompt);
    const directMatches = listSkills(root)
      .filter((skill) => skill.state === 'active' && skill.validation.valid)
      .filter((skill) => matchesSkillTrigger(skill, prompt, contract))
      .map((skill) => skill.name);

    expect(directMatches).toContain('prompt-context-engineering');
    for (const unrelated of [
      'grpc-protobuf',
      'backend-engineering',
      'embedded-firmware',
      'integration-implementation',
      'typescript-javascript-engineering',
      'pricing-monetization',
      'mysql-engineering',
      'ruby-engineering',
      'svelte-engineering',
      'nextjs-engineering',
      'python-engineering',
      'nodejs-runtime',
    ]) {
      expect(directMatches).not.toContain(unrelated);
    }
  });

  test('keeps conceptual technology explanations out of procedural skill branches', () => {
    const prompt =
      'Summarize what AWS Organizations, IAM roles, VPC ingress, KMS, CloudTrail, backups, and Kubernetes control planes do in general. Do not assess a deployment or inspect application source.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    const names = result.selected.map((item) => item.skill.name);

    expect(result.blocked).toBe(false);
    expect(names).toEqual(['task-routing']);
    expect(result.evidence.domains).not.toContain('verification');
  });

  test('keeps dependency provenance bounded so complete V5 guidance fits its package budget', () => {
    const prompt = 'The current task is prompt engineering.';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    const evaluation = result.selected.find((item) => item.skill.name === 'llm-evaluation')!;

    expect(result.blocked).toBe(false);
    expect(evaluation).toBeDefined();
    expect(evaluation.reason).toBe('Required by llm-application-engineering');
    expect(evaluation.contextCost).toBeLessThanOrEqual(evaluation.skill.metadata.contextBudget);
  });

  test('reports only the trigger, collected evidence, or declared relation actually used', () => {
    const prompt = 'Build a local IPC daemon';
    const result = resolveSkills(root, prompt, createTaskContract(prompt), {
      contextBudget: 60_000,
    });
    const localService = result.selected.find(
      (item) => item.skill.name === 'local-service-backend',
    )!;
    expect(result.evidence.topologies).toContain('local-service');
    expect(localService.reason).toBe('Matched collected topology:local-service evidence');
    expect(localService.reason).not.toContain('network-service');
    const backend = result.selected.find((item) => item.skill.name === 'backend-engineering')!;
    expect(backend.reason).toBe('Broader concept of local-service-backend');
    expect(prompt.toLowerCase()).toContain('build');
    expect(prompt.toLowerCase()).toContain('daemon');
  });

  test('all bundled professional skills pass their visible trigger and non-trigger cases', () => {
    const universalSkills = new Set(
      V5_SKILL_PACKAGE_CATALOG.packages
        .filter((skillPackage) => skillPackage.sidecar.selectionMode === 'universal')
        .map((skillPackage) => skillPackage.sidecar.name),
    );
    const results = listSkills(root)
      .filter((skill) => skill.state === 'active' && !universalSkills.has(skill.name))
      .map((skill) => ({ name: skill.name, result: testSkill(skill) }));
    expect(results.filter((item) => !item.result.passed)).toEqual([]);
  });

  test('compiles skills after immutable policy and repository instructions with stable manifest hashing', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Repository policy\nRepository instruction marker.');
    const input = {
      role: 'worker' as const,
      mode: 'advanced' as const,
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('Implement a feature'),
    };
    const first = compilePrompt(input);
    const second = compilePrompt(input);
    expect(first.manifest.skillManifestHash).toBe(second.manifest.skillManifestHash);
    expect(first.systemPrompt.indexOf('Non-negotiable execution contract')).toBeLessThan(
      first.systemPrompt.indexOf('Repository instruction marker'),
    );
    expect(first.systemPrompt.indexOf('Repository instruction marker')).toBeLessThan(
      first.systemPrompt.indexOf('Active local skills'),
    );
    expect(first.manifest.skills.length).toBeGreaterThan(0);
  });

  test('collects repository and declared-medium evidence without turning the repository stack into a default', () => {
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"react":"latest"}}');
    const custom = createTaskContract('Build a native UI toolkit for a custom language');
    const result = resolveSkills(root, custom.goal, custom);
    expect(result.evidence.repositoryMedia).toContain('web');
    expect(result.evidence.declaredMedia).toContain('native');
    expect(result.evidence.declaredMedia).toContain('novel-toolkit');
    expect(result.selected.map((item) => item.skill.name)).toContain('novel-ui-toolkit');
    expect(result.selected.map((item) => item.skill.name)).not.toContain('web-interface');
  });

  test('uses a dependency-aware context budget and warns instead of blocking mandatory overflow', () => {
    const contract = createTaskContract('Build a professional accessible web interface');
    const insufficient = resolveSkills(root, contract.goal, contract, { contextBudget: 16_000 });
    // Mandatory overflow degrades gracefully: the turn proceeds with minimal
    // guidance plus warnings instead of throwing Mandatory skill guidance.
    expect(insufficient.blocked).toBe(false);
    expect(insufficient.totalContextCost).toBeGreaterThan(16_000);
    expect(insufficient.hierarchyErrors).toEqual([]);
    expect(insufficient.warnings.join(' ')).toContain('Mandatory skill guidance requires');
    expect(insufficient.omittedByBudget.length).toBeGreaterThan(0);
    const compressed = resolveSkills(root, contract.goal, contract, { contextBudget: 22_000 });
    expect(compressed.blocked).toBe(false);
    expect(compressed.compressedByBudget.length).toBeGreaterThan(0);
    expect(compressed.totalContextCost).toBeLessThanOrEqual(22_000);
    expect(compressed.promptText.length).toBe(compressed.totalContextCost);
    expect(compressed.promptText.startsWith('## Active local skills\nManifest: ')).toBe(true);
    expect(compressed.promptText).toContain('\nManifest sha256: ');
    expect(
      compressed.selected.reduce((sum, item) => sum + item.contextCost, 0) +
        compressed.contextOverheadCost,
    ).toBe(compressed.totalContextCost);
    for (const item of compressed.selected) {
      expect(item.contextCost).toBe(item.promptText.length);
      expect(item.fullContextCost).toBeGreaterThanOrEqual(item.contextCost);
      expect(item.omittedDetailChars).toBe(item.fullContextCost - item.contextCost);
    }
    for (const name of ['task-routing', 'testing-engineering', 'verification']) {
      const selected = compressed.selected.find((item) => item.skill.name === name)!;
      const requiredCore = BUNDLED_SKILL_DEFINITIONS.find((item) => item.name === name)!
        .instructions.replace(/^#\s+[^\n]+\n+/, '')
        .trim();
      expect(selected.promptText).toContain(requiredCore);
    }
    const names = new Set(compressed.selected.map((item) => item.skill.name));
    for (const item of compressed.selected) {
      for (const broader of item.skill.metadata.broader) expect(names.has(broader)).toBe(true);
    }
    const pinned = resolveSkills(root, contract.goal, contract, {
      contextBudget: 1,
      pins: ['web-interface'],
    });
    // Tiny budgets floor at MIN_SKILL_CONTEXT_BUDGET and warn instead of blocking.
    expect(pinned.contextBudget).toBe(MIN_SKILL_CONTEXT_BUDGET);
    expect(pinned.blocked).toBe(false);
    expect(pinned.warnings.join(' ')).toContain('Mandatory skill guidance requires');
    expect(pinned.totalContextCost).toBeGreaterThan(pinned.contextBudget);
    expect(pinned.selected.map((item) => item.skill.name)).toEqual(
      expect.arrayContaining([
        'task-routing',
        'testing-engineering',
        'verification',
        'web-interface',
      ]),
    );
    expect(pinned.omittedByBudget).not.toContain('web-interface');
  });

  test('injects exactly the advertised bounded skill representations', () => {
    const taskContract = createTaskContract('Build a professional accessible web interface');
    const compiled = compilePrompt({
      role: 'worker',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract,
      skillSelection: { contextBudget: 22_000 },
    });
    const firstSkill = compiled.manifest.skills[0]!;
    const skillTextStart = compiled.systemPrompt.indexOf('## Active local skills');
    expect(skillTextStart).toBeGreaterThan(0);
    const actualInjectedSkills = compiled.systemPrompt.slice(skillTextStart);
    const advertisedCost = compiled.manifest.skillContextCost;
    expect(actualInjectedSkills.length).toBe(advertisedCost);
    expect(advertisedCost).toBeLessThanOrEqual(22_000);
    expect(actualInjectedSkills).toContain(`### ${firstSkill.name} v`);
    expect(compiled.manifest.skills.map((item) => item.representation)).toContain('minimal');

    const roomy = resolveSkills(root, taskContract.goal, taskContract, { contextBudget: 60_000 });
    expect(roomy.selected.map((item) => item.representation)).toContain('full');
    const justBelowFull = resolveSkills(root, taskContract.goal, taskContract, {
      contextBudget: roomy.totalContextCost - 1,
    });
    expect(justBelowFull.blocked).toBe(false);
    // One char less than a full fit strictly degrades the bundle without blocking it.
    expect(justBelowFull.totalContextCost).toBeLessThanOrEqual(roomy.totalContextCost - 1);
    expect(justBelowFull.totalContextCost).toBeLessThan(roomy.totalContextCost);
    // Tiny requested budgets floor instead of throwing Mandatory skill guidance.
    const pressured = compilePrompt({
      role: 'worker',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract,
      skillSelection: { contextBudget: 100 },
    });
    expect(pressured.manifest.skillContextBudget.budget).toBe(MIN_SKILL_CONTEXT_BUDGET);
    expect(pressured.warnings?.join(' ') ?? '').toContain('Mandatory skill guidance requires');
    expect(pressured.manifest.skillWarnings.join(' ')).toContain(
      'Mandatory skill guidance requires',
    );
  });

  test('derives skill capacity from verified model space and occupied context', () => {
    const open = deriveSkillContextBudget({
      requestedBudget: 30_000,
      contextWindowTokens: 32_000,
      occupiedContextChars: 6_000,
      nonSkillPromptChars: 6_000,
      reservedOutputTokens: 4_096,
    });
    const crowded = deriveSkillContextBudget({
      requestedBudget: 30_000,
      contextWindowTokens: 32_000,
      occupiedContextChars: 78_000,
      nonSkillPromptChars: 6_000,
      reservedOutputTokens: 4_096,
    });
    expect(open.source).toBe('trusted-model-window');
    expect(open.budget).toBe(15_904);
    expect(crowded.budget).toBeLessThan(open.budget);
    // Crowded windows floor at MIN_SKILL_CONTEXT_BUDGET instead of max(1, …).
    expect(crowded.budget).toBe(MIN_SKILL_CONTEXT_BUDGET);
    expect(crowded.occupiedContextChars).toBe(78_000);
    const planning = deriveSkillContextBudget({
      requestedBudget: 12_345,
      occupiedContextTokenUpperBound: 1_000_000,
    });
    expect(planning).toMatchObject({ budget: 12_345, source: 'planning-default' });
    // Window-relative default: 10% of a verified window clamped to [8_000, 30_000].
    expect(deriveSkillContextBudget({ contextWindowTokens: 200_000 }).requestedBudget).toBe(20_000);
    expect(deriveSkillContextBudget({ contextWindowTokens: 32_000 }).requestedBudget).toBe(8_000);
    expect(deriveSkillContextBudget({}).requestedBudget).toBe(30_000);
  });

  test('reserves the actual completion limit and fails closed on unknown or crowded live context', () => {
    registerLiveModelResolver((modelId, provider) =>
      modelId === 'verified-128k'
        ? {
            id: modelId,
            name: modelId,
            provider,
            contextWindow: 128_000,
            contextVerified: true,
            maxOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
            costPerMInputTokens: 0,
            costPerMOutputTokens: 0,
            canReason: true,
            supportsAttachments: false,
            supportsStreaming: true,
          }
        : modelId === 'verified-32k'
          ? {
              id: modelId,
              name: modelId,
              provider,
              contextWindow: 32_000,
              contextVerified: true,
              maxOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
              costPerMInputTokens: 0,
              costPerMOutputTokens: 0,
              canReason: true,
              supportsAttachments: false,
              supportsStreaming: true,
            }
          : undefined,
    );
    const contract = createTaskContract('Build a professional accessible web interface');
    const safe = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      model: 'verified-128k',
      occupiedContextTokenUpperBound: 12_000,
      reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: root,
      taskContract: contract,
    });
    expect(safe.manifest.skillContextBudget.reservedOutputTokens).toBe(MANAGER_OUTPUT_TOKEN_LIMIT);
    expect(safe.manifest.systemPromptTokenUpperBound).toBe(textTokenUpperBound(safe.systemPrompt));
    expect(safe.manifest.totalContextTokenUpperBound).toBe(
      12_000 + textTokenUpperBound(safe.systemPrompt) + MANAGER_OUTPUT_TOKEN_LIMIT,
    );
    expect(safe.manifest.totalContextTokenUpperBound).toBeLessThanOrEqual(128_000);

    // A crowded 32k window no longer throws Mandatory skill guidance: the skill
    // budget floors and warns, and only a genuinely overflowing rendered
    // prompt still fails closed against the verified window.
    const crowdedCompiled = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      model: 'verified-32k',
      occupiedContextTokenUpperBound: 1_000,
      reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: root,
      taskContract: contract,
    });
    expect(crowdedCompiled.manifest.skillContextBudget.budget).toBeGreaterThanOrEqual(
      MIN_SKILL_CONTEXT_BUDGET,
    );
    expect(() =>
      compilePrompt({
        role: 'manager',
        mode: 'advanced',
        provider: 'openai',
        model: 'verified-32k',
        occupiedContextTokenUpperBound: 48_000,
        reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
        requireVerifiedContextWindow: true,
        workingDirectory: root,
        taskContract: contract,
      }),
    ).toThrow('exceeding the verified 32000-token window');
    expect(() =>
      compilePrompt({
        role: 'manager',
        mode: 'advanced',
        provider: 'openai',
        model: 'unknown-window',
        occupiedContextTokenUpperBound: 1,
        reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
        requireVerifiedContextWindow: true,
        workingDirectory: root,
        taskContract: contract,
      }),
    ).not.toThrow();
    // The warning is surfaced via the CompiledPrompt.warnings field instead
    // of throwing — the agent proceeds with an unverified context window.
    const warned = compilePrompt({
      role: 'manager',
      mode: 'advanced',
      provider: 'openai',
      model: 'unknown-window',
      occupiedContextTokenUpperBound: 1,
      reservedOutputTokens: MANAGER_OUTPUT_TOKEN_LIMIT,
      requireVerifiedContextWindow: true,
      workingDirectory: root,
      taskContract: contract,
    });
    expect(warned.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Context window unverified for openai/unknown-window'),
      ]),
    );
  });

  test('classifies exact fuzzing and authorization requests with proportional risk and evidence', () => {
    const fuzz = createTaskContract('Fuzz a binary parser with malformed inputs');
    expect(fuzz).toMatchObject({ taskKind: 'feature', risk: 'medium' });
    expect(fuzz.requiredEvidence).toContain('Exact verification commands or inspected artifacts');
    expect(requiresMultiAgentDelegation(fuzz.goal)).toBe(true);
    const fuzzSkills = resolveSkills(root, fuzz.goal, fuzz, { contextBudget: 60_000 }).selected.map(
      (item) => item.skill.name,
    );
    expect(fuzzSkills).toEqual(
      expect.arrayContaining([
        'testing-engineering',
        'property-fuzz-differential-testing',
        'verification',
      ]),
    );

    const authorization = createTaskContract('Assess an application authorization policy');
    expect(authorization).toMatchObject({ taskKind: 'security-infra', risk: 'high' });
    expect(authorization.requiredEvidence).toContain(
      'Reproducible findings with explicit unavailable limits',
    );
    expect(authorization.requiredEvidence).not.toContain('Actual diff');
    expect(requiresMultiAgentDelegation(authorization.goal)).toBe(true);
  });

  test('ranks only measured eligible harness candidates and preserves unknown order', () => {
    const base = {
      harnessVersion: '1',
      skill: 'frontend-engineering',
      role: 'worker' as const,
      medium: 'web',
      sampleSize: 10,
      updatedAt: '2026-07-18T00:00:00Z',
      evidence: ['eval-1'],
    };
    saveHarnessQualification(root, {
      ...base,
      provider: 'a',
      model: 'weak',
      successes: 5,
      quality: 0.5,
      verification: 0.5,
    });
    saveHarnessQualification(root, {
      ...base,
      provider: 'b',
      model: 'strong',
      successes: 9,
      quality: 0.9,
      verification: 0.9,
    });
    expect(listHarnessQualifications(root)).toHaveLength(2);
    const candidates = [
      { provider: 'a', model: 'weak' },
      { provider: 'b', model: 'strong' },
      { provider: 'c', model: 'unknown' },
    ];
    expect(
      rankHarnessCandidates(root, candidates, 'worker', ['frontend-engineering'], 'web'),
    ).toEqual([candidates[1], candidates[0], candidates[2]]);
    expect(
      rankHarnessCandidates(root, candidates, 'critic', ['frontend-engineering'], 'web'),
    ).toEqual(candidates);
  });

  test('promotes skills only from observed cross-run evidence, never a fabricated score', () => {
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const card = buildSkillEvaluationCard(root, skill);
    expect(card.gate.status).toBe('unmeasured');
    expect(card.cases.length).toBeGreaterThan(1);
    expect(card.suite.requiredCategories).toEqual([
      'positive',
      'negative',
      'ambiguous',
      'adversarial',
      'full-task',
    ]);
    for (const category of card.suite.requiredCategories) {
      expect(card.suite.categories[category].length).toBeGreaterThan(0);
    }
    for (const [index, evaluator] of [
      'deterministic',
      'deterministic',
      'deterministic',
      'human-blind-review',
    ].entries()) {
      recordSkillEvaluationRun(root, {
        id: `run-${index}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: card.cases[index].id,
        provider: 'test-provider',
        model: `test-model-${index}`,
        harnessVersion: 'test',
        role: 'worker',
        evaluator: evaluator as 'deterministic' | 'human-blind-review' | 'human-review',
        passed: true,
        quality: 0.9,
        verification: 0.9,
        integrityFailure: false,
        evidence: [`artifact-${index}`],
        recordedAt: '2026-07-18T00:00:00.000Z',
      });
    }
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).status).toBe('ready');
    recordSkillEvaluationRun(root, {
      id: 'run-integrity-failure',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: card.cases[0].id,
      provider: 'test-provider',
      model: 'test-model-4',
      harnessVersion: 'test',
      role: 'worker',
      evaluator: 'human-blind-review',
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: true,
      evidence: ['negative-artifact'],
      recordedAt: '2026-07-18T00:00:01.000Z',
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).status).toBe('blocked');
  });

  test('records large evaluation batches atomically with stable-id replacement', () => {
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const base = {
      skill: skill.name,
      revisionHash: skill.hash,
      provider: 'kory-resolver',
      model: 'deterministic-v5',
      harnessVersion: 'batch-test',
      role: 'worker' as const,
      evaluator: 'deterministic' as const,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      recordedAt: '2026-09-06T00:00:00.000Z',
      protocolVersion: 2 as const,
      caseCategory: 'positive' as const,
      variant: 'with-skill' as const,
      routing: { expectedSelection: true, selected: true },
    };
    recordSkillEvaluationRuns(root, [
      {
        ...base,
        id: 'batch-a',
        caseId: 'case-a',
        comparisonId: 'pair-a',
        passed: true,
        evidence: ['first-a'],
      },
      {
        ...base,
        id: 'batch-b',
        caseId: 'case-b',
        comparisonId: 'pair-b',
        passed: true,
        evidence: ['first-b'],
      },
    ]);
    recordSkillEvaluationRuns(root, [
      {
        ...base,
        id: 'batch-a',
        caseId: 'case-a',
        comparisonId: 'pair-a',
        passed: false,
        quality: 0,
        evidence: ['replacement-a'],
      },
    ]);
    const runs = buildSkillEvaluationCard(root, skill).runs;
    expect(runs.map((run) => run.id).sort()).toEqual(['batch-a', 'batch-b']);
    expect(runs.find((run) => run.id === 'batch-a')).toMatchObject({
      passed: false,
      quality: 0,
      evidence: ['replacement-a'],
    });
    expect(() =>
      recordSkillEvaluationRuns(root, [
        {
          ...base,
          id: 'duplicate',
          caseId: 'case-c',
          comparisonId: 'pair-c',
          passed: true,
          evidence: ['one'],
        },
        {
          ...base,
          id: 'duplicate',
          caseId: 'case-d',
          comparisonId: 'pair-d',
          passed: true,
          evidence: ['two'],
        },
      ]),
    ).toThrow('duplicate run IDs');
  });

  test('serializes concurrent evaluation ledger writers without losing distinct runs', async () => {
    const evaluationModule = join(import.meta.dir, '..', 'skill-evaluations.ts');
    const writerPath = join(root, 'evaluation-ledger-writer.ts');
    const barrierPath = join(root, 'evaluation-ledger-go');
    const writerIds = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);
    writeFileSync(
      writerPath,
      `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordSkillEvaluationRun } from ${JSON.stringify(evaluationModule)};

const [projectRoot, runId] = process.argv.slice(2);
if (!projectRoot || !runId) throw new Error('missing writer arguments');
writeFileSync(join(projectRoot, runId + '.ready'), 'ready');
while (!existsSync(join(projectRoot, 'evaluation-ledger-go'))) await Bun.sleep(2);
recordSkillEvaluationRun(projectRoot, {
  id: runId,
  skill: 'evaluation-ledger-concurrency-test',
  revisionHash: 'revision-a',
  caseId: runId,
  provider: 'test-provider',
  model: 'test-model',
  harnessVersion: 'concurrent-writer-test',
  role: 'worker',
  evaluator: 'deterministic',
  passed: true,
  quality: 1,
  verification: 1,
  integrityFailure: false,
  evidence: ['writer completed'],
  recordedAt: '2026-09-13T00:00:00.000Z',
  protocolVersion: 2,
  caseCategory: 'positive',
  variant: 'with-skill',
  comparisonId: runId + ':pair',
  routing: { expectedSelection: true, selected: true },
});
`,
      'utf8',
    );

    const writers = writerIds.map((runId) =>
      Bun.spawn([process.execPath, writerPath, root, runId], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    );
    const readyDeadline = Date.now() + 10_000;
    while (!writerIds.every((runId) => existsSync(join(root, `${runId}.ready`)))) {
      if (Date.now() >= readyDeadline)
        throw new Error('concurrent evaluation writers did not start');
      await Bun.sleep(5);
    }
    writeFileSync(barrierPath, 'go', 'utf8');

    const exitCodes = await Promise.all(writers.map((writer) => writer.exited));
    const stderr = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()));
    expect(exitCodes, stderr.filter(Boolean).join('\n')).toEqual(writerIds.map(() => 0));

    const ledger = JSON.parse(
      readFileSync(join(root, '.koryphaios', 'skills', 'evaluations.json'), 'utf8'),
    ) as Array<{ id?: unknown }>;
    expect(
      ledger
        .map((run) => run.id)
        .filter((id): id is string => typeof id === 'string')
        .sort(),
    ).toEqual([...writerIds].sort());
    expect(existsSync(join(root, '.koryphaios', 'skills', 'evaluations.json.lock'))).toBe(false);
  });

  test('gates evidence protocol v2 on blinded provenance, routing, baselines, and regressions', () => {
    syncSkillStewardRegistry(root);
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const card = buildSkillEvaluationCard(root, skill);
    const positiveCase = card.suite.categories.positive[0]!;
    const benchmarkCases = card.suite.requiredCategories.flatMap((category) =>
      card.suite.categories[category]
        .slice(0, category === 'full-task' ? 2 : 1)
        .map((benchmarkCase) => ({ category, benchmarkCase })),
    );

    expect(() =>
      recordSkillEvaluationRun(root, {
        id: 'missing-blind-provenance',
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: positiveCase.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'v2',
        role: 'worker',
        evaluator: 'blind-review',
        passed: true,
        quality: 0.9,
        verification: 0.9,
        integrityFailure: false,
        evidence: ['blind-review-artifact'],
        recordedAt: '2026-07-18T00:00:00.000Z',
        protocolVersion: 2,
        variant: 'with-skill',
        caseCategory: 'positive',
        comparisonId: 'missing-provenance',
        routing: { expectedSelection: true, selected: true },
      }),
    ).toThrow('Blind review requires evaluator provenance');

    for (const [index, { category, benchmarkCase }] of benchmarkCases.entries()) {
      recordSkillEvaluationRun(root, {
        id: `v2-candidate-${category}-${index}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: benchmarkCase.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'v2',
        role: 'worker',
        evaluator: 'deterministic',
        passed: true,
        quality: 0.9,
        verification: 0.9,
        integrityFailure: false,
        evidence: [`candidate-${category}`],
        recordedAt: `2026-07-18T00:00:0${index}.000Z`,
        protocolVersion: 2,
        variant: 'with-skill',
        caseCategory: category,
        comparisonId: `pair-${category}-${index}`,
        routing: {
          expectedSelection: benchmarkCase.expectedSelection,
          selected: benchmarkCase.expectedSelection,
        },
      });
    }

    const firstBenchmark = benchmarkCases[0]!;
    recordSkillEvaluationRun(root, {
      id: 'v2-self-blind-review',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: firstBenchmark.benchmarkCase.id,
      provider: 'chatgpt-web',
      model: 'chatgpt-web/pro',
      harnessVersion: 'v2-blind',
      role: 'critic',
      evaluator: 'blind-review',
      passed: true,
      quality: 0.9,
      verification: 0.9,
      integrityFailure: false,
      evidence: ['self-review-artifact'],
      recordedAt: '2026-07-18T00:00:20.000Z',
      protocolVersion: 2,
      variant: 'with-skill',
      caseCategory: firstBenchmark.category,
      comparisonId: `pair-${firstBenchmark.category}-0`,
      routing: {
        expectedSelection: firstBenchmark.benchmarkCase.expectedSelection,
        selected: firstBenchmark.benchmarkCase.expectedSelection,
      },
      evaluatorProvenance: {
        evaluatorId: 'self-blind-evaluator',
        kind: 'model',
        provider: 'chatgpt-web',
        model: 'chatgpt-web/pro',
        agentId: 'skill-steward:web-interface',
        displayLabel: 'ChatGPT web — web-interface',
        assignmentId: 'self-blind-assignment',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['self-blind-assignment-record'],
      },
    });
    expect(evaluateSkillPromotion(root, skill.name, skill.hash).provenancedBlindReviews).toBe(0);

    recordSkillEvaluationRun(root, {
      id: 'v2-primary-blind-review',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: firstBenchmark.benchmarkCase.id,
      provider: 'chatgpt-web',
      model: 'chatgpt-web/pro',
      harnessVersion: 'v2-blind',
      role: 'critic',
      evaluator: 'blind-review',
      passed: true,
      quality: 0.9,
      verification: 0.9,
      integrityFailure: false,
      evidence: ['blind-review-artifact'],
      recordedAt: '2026-07-18T00:00:30.000Z',
      protocolVersion: 2,
      variant: 'with-skill',
      caseCategory: firstBenchmark.category,
      comparisonId: `pair-${firstBenchmark.category}-0`,
      routing: {
        expectedSelection: firstBenchmark.benchmarkCase.expectedSelection,
        selected: firstBenchmark.benchmarkCase.expectedSelection,
      },
      evaluatorProvenance: {
        evaluatorId: 'blind-evaluator-1',
        kind: 'model',
        provider: 'chatgpt-web',
        model: 'chatgpt-web/pro',
        agentId: 'reviewer-agent-1',
        displayLabel: 'ChatGPT web — web-interface',
        assignmentId: 'assignment-1',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['blind-assignment-record'],
      },
    });

    const withoutBaselines = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(withoutBaselines.status).toBe('insufficient-evidence');
    expect(withoutBaselines.provenancedBlindReviews).toBe(1);
    expect(withoutBaselines.routingPrecision).toBe(1);
    expect(withoutBaselines.routingRecall).toBe(1);
    expect(withoutBaselines.reasons).toContain(
      'Skill-vs-no-skill baselines are missing for: positive, negative, ambiguous, adversarial, full-task.',
    );

    for (const [index, { category, benchmarkCase }] of benchmarkCases.entries()) {
      recordSkillEvaluationRun(root, {
        id: `v2-baseline-${category}-${index}`,
        skill: skill.name,
        revisionHash: skill.hash,
        caseId: benchmarkCase.id,
        provider: 'test-provider',
        model: 'subject-model',
        harnessVersion: 'v2',
        role: 'worker',
        evaluator: 'deterministic',
        passed: false,
        quality: 0.4,
        verification: 0.4,
        integrityFailure: false,
        evidence: [`baseline-${category}`],
        recordedAt: `2026-07-18T00:01:0${index}.000Z`,
        protocolVersion: 2,
        variant: 'without-skill',
        caseCategory: category,
        comparisonId: `pair-${category}-${index}`,
        routing: {
          expectedSelection: benchmarkCase.expectedSelection,
          selected: benchmarkCase.expectedSelection,
        },
      });
    }

    const ready = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(ready.status).toBe('ready');
    expect(ready.baselineRuns).toBe(6);
    expect(ready.pairedBaselineCases).toBe(6);
    expect(ready.pairedBaselineCategories).toEqual(card.suite.requiredCategories);
    expect(ready.pairedBaselineCategoryCounts['full-task']).toBe(2);
    expect(ready.skillBaselinePassRateDelta).toBe(1);
    expect(ready.skillBaselineQualityDelta).toBeCloseTo(0.5);
    expect(ready.skillBaselineVerificationDelta).toBeCloseTo(0.5);

    const firstFullTask = benchmarkCases.find((item) => item.category === 'full-task')!;
    const firstFullTaskIndex = benchmarkCases.findIndex((item) => item === firstFullTask);
    recordSkillEvaluationRun(root, {
      id: 'v2-duplicate-full-task-blind-review',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: firstFullTask.benchmarkCase.id,
      provider: 'blind-provider',
      model: 'blind-model',
      harnessVersion: 'v2-blind',
      role: 'critic',
      evaluator: 'blind-review',
      passed: true,
      quality: 0.95,
      verification: 0.95,
      integrityFailure: false,
      evidence: ['independent blind review of the existing full-task pair'],
      recordedAt: '2026-07-18T00:02:00.000Z',
      protocolVersion: 2,
      variant: 'with-skill',
      caseCategory: 'full-task',
      comparisonId: `pair-full-task-${firstFullTaskIndex}`,
      routing: { expectedSelection: true, selected: true },
      evaluatorProvenance: {
        evaluatorId: 'blind-evaluator-2',
        kind: 'model',
        provider: 'blind-provider',
        model: 'blind-model',
        assignmentId: 'full-task-blind-assignment',
        blindTo: ['skill-variant', 'expected-outcome'],
        evidence: ['randomized full-task artifacts'],
      },
    });
    const deduplicatedCoverage = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(deduplicatedCoverage.categoryCoverage['full-task']).toBe(2);
    expect(deduplicatedCoverage.pairedBaselineCategoryCounts['full-task']).toBe(2);

    const secondPositiveCase = card.suite.categories.positive[1] ?? positiveCase;
    recordSkillEvaluationRun(root, {
      id: 'v2-regression-source',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: secondPositiveCase.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v2',
      role: 'worker',
      evaluator: 'deterministic',
      passed: false,
      quality: 0.9,
      verification: 0.9,
      integrityFailure: false,
      evidence: ['regression-source-artifact'],
      recordedAt: '2026-07-18T00:02:00.000Z',
      protocolVersion: 2,
      variant: 'with-skill',
      caseCategory: 'positive',
      comparisonId: 'regression-source-unpaired',
      routing: { expectedSelection: true, selected: true },
    });

    const blocked = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(blocked.status).toBe('blocked');
    expect(blocked.openRegressions).toBe(1);

    const regressionCard = buildSkillEvaluationCard(root, skill);
    const regressionCase = regressionCard.suite.categories.regression.find(
      (item) => item.regressionOfRunId === 'v2-regression-source',
    )!;
    expect(regressionCase.originCaseId).toBe(secondPositiveCase.id);

    recordSkillEvaluationRun(root, {
      id: 'v2-regression-retest',
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: regressionCase.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v2',
      role: 'worker',
      evaluator: 'deterministic',
      passed: true,
      quality: 0.9,
      verification: 0.9,
      integrityFailure: false,
      evidence: ['regression-retest-artifact'],
      recordedAt: '2026-07-18T00:03:00.000Z',
      protocolVersion: 2,
      variant: 'with-skill',
      caseCategory: 'regression',
      comparisonId: 'regression-retest-unpaired',
      routing: {
        expectedSelection: regressionCase.expectedSelection,
        selected: regressionCase.expectedSelection,
      },
      regressionId: 'v2-regression-source',
    });

    const regressionClosed = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(regressionClosed.status).toBe('ready');
    expect(regressionClosed.regressionCases).toBe(1);
    expect(regressionClosed.openRegressions).toBe(0);
  });

  test('uses the latest complete paired retry for skill-vs-no-skill uplift', () => {
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const fullTask = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    const base = {
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: fullTask.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'retry-v2',
      role: 'worker' as const,
      evaluator: 'deterministic' as const,
      passed: true,
      quality: 1,
      integrityFailure: false,
      evidence: ['paired retry'],
      protocolVersion: 2 as const,
      caseCategory: 'full-task' as const,
    };
    recordSkillEvaluationRuns(root, [
      {
        ...base,
        id: 'retry-old-with',
        verification: 0,
        recordedAt: '2026-07-18T00:00:00.000Z',
        variant: 'with-skill',
        comparisonId: 'retry-old',
        routing: { expectedSelection: true, selected: true },
      },
      {
        ...base,
        id: 'retry-old-without',
        verification: 1,
        recordedAt: '2026-07-18T00:00:01.000Z',
        variant: 'without-skill',
        comparisonId: 'retry-old',
        routing: { expectedSelection: true, selected: false },
      },
      {
        ...base,
        id: 'retry-new-with',
        verification: 1,
        recordedAt: '2026-07-18T00:01:00.000Z',
        variant: 'with-skill',
        comparisonId: 'retry-new',
        routing: { expectedSelection: true, selected: true },
      },
      {
        ...base,
        id: 'retry-new-without',
        verification: 1,
        recordedAt: '2026-07-18T00:01:01.000Z',
        variant: 'without-skill',
        comparisonId: 'retry-new',
        routing: { expectedSelection: true, selected: false },
      },
    ]);

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.pairedBaselineCategoryCounts['full-task']).toBe(1);
    expect(gate.skillBaselineVerificationDelta).toBe(0);
  });

  test('closes a protocol-v3 regression with a later passing equivalent evaluator rerun across revisions', () => {
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const fullTask = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    const contractHash = 'b'.repeat(64);
    const base = {
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: fullTask.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3-retry@1',
      role: 'worker' as const,
      evaluator: 'deterministic' as const,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: ['same-contract retry'],
      protocolVersion: 3 as const,
      variant: 'with-skill' as const,
      caseCategory: 'full-task' as const,
      routing: { expectedSelection: true, selected: true },
      suiteId: 'test-suite',
      scenarioId: fullTask.id,
      evaluationContractHash: contractHash,
      evaluationContractVersion: 3,
      materializerId: 'test-materializer@1',
      deterministicScorerId: 'test-scorer@1',
    };
    recordSkillEvaluationRuns(root, [
      {
        ...base,
        id: 'v3-regression-source',
        revisionHash: 'c'.repeat(64),
        experimentId: 'v3-regression-source-experiment',
        passed: false,
        recordedAt: '2026-09-10T00:00:00.000Z',
      },
      {
        ...base,
        id: 'v3-regression-rerun',
        evaluationContractHash: 'd'.repeat(64),
        harnessVersion: 'v3-retry@2',
        experimentId: 'v3-regression-rerun-experiment',
        passed: true,
        recordedAt: '2026-09-10T00:01:00.000Z',
      },
    ]);

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.regressionCases).toBe(1);
    expect(gate.openRegressions).toBe(0);
  });

  test('does not carry a protocol-v3 regression forward when the evaluator generation is superseded', () => {
    const skill = listSkills(root).find((item) => item.name === 'web-interface')!;
    const fullTask = buildSkillEvaluationCard(root, skill).suite.categories['full-task'][0]!;
    const base = {
      skill: skill.name,
      revisionHash: skill.hash,
      caseId: fullTask.id,
      provider: 'test-provider',
      model: 'subject-model',
      harnessVersion: 'v3-retry@1',
      role: 'worker' as const,
      evaluator: 'deterministic' as const,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: ['evaluator generation retry'],
      protocolVersion: 3 as const,
      variant: 'with-skill' as const,
      caseCategory: 'full-task' as const,
      routing: { expectedSelection: true, selected: true },
      suiteId: 'test-suite',
      scenarioId: fullTask.id,
      evaluationContractVersion: 3,
      materializerId: 'test-materializer@1',
    };
    recordSkillEvaluationRuns(root, [
      {
        ...base,
        id: 'v3-generation-regression-source',
        revisionHash: 'c'.repeat(64),
        evaluationContractHash: 'b'.repeat(64),
        deterministicScorerId: 'test-scorer@1',
        experimentId: 'v3-generation-regression-source-experiment',
        passed: false,
        recordedAt: '2026-09-10T00:00:00.000Z',
      },
      {
        ...base,
        id: 'v3-generation-regression-rerun',
        evaluationContractHash: 'd'.repeat(64),
        deterministicScorerId: 'test-scorer@2',
        experimentId: 'v3-generation-regression-rerun-experiment',
        passed: true,
        recordedAt: '2026-09-10T00:01:00.000Z',
      },
    ]);

    const gate = evaluateSkillPromotion(root, skill.name, skill.hash);
    expect(gate.regressionCases).toBe(0);
    expect(gate.openRegressions).toBe(0);
  });

  test('supports explicit keep, replace, and merge choices for bundled updates', () => {
    const original = listSkills(root).find((skill) => skill.name === 'planning')!;
    saveSkillDraft(
      root,
      'personal',
      'planning',
      original.content.replace('dependency-ordered', 'locally edited'),
      original.hash,
    );
    activateSkill(root, 'personal', 'planning');
    expect(applyDefaultUpdate(root, 'planning', 'keep-local').content).toContain('locally edited');
    expect(applyDefaultUpdate(root, 'planning', 'merge').state).toBe('draft');
    expect(applyDefaultUpdate(root, 'planning', 'replace').content).toContain('dependency-ordered');
  });

  test('preserves but fail-closes Codex-only bundled resources instead of seeding them active', () => {
    for (const [name, unavailableReason] of INCOMPATIBLE_EXTERNAL_SKILL_RESOURCES) {
      const bundled = getBundledSkillContent(name);
      expect(bundled).not.toBeNull();
      const directory = join(personalRoot(), name);
      mkdirSync(directory, { recursive: true });
      const localPath = join(directory, 'SKILL.md');
      const customized = `${bundled!.trim()}\n\n<!-- preserved user note: ${name} -->\n`;
      writeFileSync(localPath, customized);

      seedDefaultSkills();
      expect(readFileSync(localPath, 'utf8')).toBe(customized);
      const revision = listSkills(root).find(
        (skill) => skill.name === name && skill.state === 'active',
      )!;
      expect(revision.validation.valid).toBe(false);
      expect(revision.compatibility).toMatchObject({
        status: 'unavailable',
        reason: unavailableReason,
      });
      // supportingResources uses path.join(), which produces backslashes on
      // Windows. Normalize to forward slashes so the substring check is
      // platform-independent.
      expect(revision.compatibility?.supportingResources[0]?.replaceAll('\\', '/')).toContain(
        `/skills/${name}`,
      );
    }
    const preview = resolveSkills(
      root,
      'Install a Codex skill',
      createTaskContract('Install a Codex skill'),
    );
    expect(preview.selected.map((item) => item.skill.name)).not.toContain('skill-installer');
    expect(preview.rejectedCandidates.map((item) => item.name)).toContain('skill-installer');
    expect(compareBundledSkill('skill-creator')?.changed).toBe(true);
    expect(compareBundledSkill('nonexistent-skill')).toBeNull();
  });

  test('countBundledUpdates tracks edited Kory-native defaults only', () => {
    seedDefaultSkills();
    expect(countBundledUpdates()).toBe(0);

    for (const [index, name] of ['planning', 'research'].entries()) {
      const skillPath = join(personalRoot(), name, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf8');
      writeFileSync(skillPath, `${content.trim()}\n\n<!-- local edit ${name} -->\n`);
      expect(countBundledUpdates()).toBe(index + 1);
    }
  });

  test('applyDefaultUpdate merge-with-agent falls through to keep-local (LLM call is route-only)', () => {
    // The merge-with-agent choice in applyDefaultUpdate should NOT create a
    // placeholder draft — the route handler handles the LLM call separately.
    // So it should behave like keep-local: return the active revision unchanged.
    // First, replace to clear any leftover draft from prior tests
    applyDefaultUpdate(root, 'planning', 'replace');
    const original = listSkills(root).find(
      (skill) => skill.name === 'planning' && skill.state === 'active',
    )!;
    saveSkillDraft(
      root,
      'personal',
      'planning',
      original.content.replace('dependency-ordered', 'locally edited'),
      original.hash,
    );
    activateSkill(root, 'personal', 'planning');
    expect(existsSync(join(personalRoot(), 'planning', 'DRAFT.md'))).toBe(false);
    const result = applyDefaultUpdate(root, 'planning', 'merge-with-agent');
    expect(result.state).toBe('active');
    expect(result.content).toContain('locally edited');
    // No draft should have been created by merge-with-agent
    const drafts = listSkills(root).filter(
      (skill) => skill.name === 'planning' && skill.state === 'draft',
    );
    expect(drafts).toHaveLength(0);
  });
});
