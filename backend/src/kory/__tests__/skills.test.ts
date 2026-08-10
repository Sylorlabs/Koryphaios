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
  auditBundledSkillDefinitions,
  BUNDLED_SKILL_DEFINITIONS,
  createSkillDraft,
  deriveAuthoritativeTargetMedium,
  getBundledSkillContent,
  INCOMPATIBLE_EXTERNAL_SKILL_RESOURCES,
  matchesSkillTrigger,
} from '../skills';
import {
  MANAGER_OUTPUT_TOKEN_LIMIT,
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
} from '../skill-evaluations';
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
    expect(active).toHaveLength(79);
    expect(active.every((skill) => skill.validation.valid)).toBe(true);
    expect(active.every((skill) => skill.metadata.sourceScope === 'local-only')).toBe(true);
    for (const name of INCOMPATIBLE_EXTERNAL_SKILL_RESOURCES.keys()) {
      expect(existsSync(join(personalRoot(), name, 'SKILL.md'))).toBe(false);
    }
  });

  test('proves the complete 32 + 47 definition contract before deployment', () => {
    const audit = auditBundledSkillDefinitions();
    expect(audit).toEqual({
      valid: true,
      errors: [],
      definitionCount: 79,
      baseCount: 32,
      professionalCount: 47,
    });
    const names = BUNDLED_SKILL_DEFINITIONS.map((definition) => definition.name);
    expect(new Set(names).size).toBe(79);

    const activeByName = new Map(listSkills(root).map((skill) => [skill.name, skill]));
    for (const name of names) {
      const skill = activeByName.get(name)!;
      expect(skill.description).toContain('Use when ');
      expect(skill.description.length).toBeGreaterThanOrEqual(40);
      expect(skill.description.length).toBeLessThanOrEqual(360);
      expect(skill.metadata.version).toBe('3.0.0');
      expect(skill.metadata.broader[0]).toBe(skill.metadata.parent);
    }
  });

  test('pins the host-enforced Plan mode contract independently of wording', () => {
    const contract = createTaskContract('Rename this local variable');
    const result = resolveSkills(root, contract.goal, contract, { pins: ['plan-mode'] });
    const planMode = result.selected.find((item) => item.skill.name === 'plan-mode');
    expect(planMode?.skill.instructions).toContain('Ask useful questions early and throughout');
    expect(planMode?.skill.instructions).toContain('KORY_PLAN_READY');
  });

  test('loads professional playbooks only with their selected skill revision', () => {
    const skills = listSkills(root);
    const experience = skills.find((skill) => skill.name === 'human-experience')!;
    const visualDesign = skills.find((skill) => skill.name === 'visual-interface-design')!;
    const visualVerification = skills.find((skill) => skill.name === 'visual-verification')!;
    const routing = skills.find((skill) => skill.name === 'task-routing')!;
    expect(experience.instructions).toContain('Map entry, orientation, setup');
    expect(visualDesign.instructions).toContain(
      'State a concise visual read before implementation',
    );
    expect(visualDesign.instructions).toContain(
      'Run a visual pre-flight before declaring completion',
    );
    expect(visualDesign.instructions).toContain(
      'These are universal checks, not web prescriptions',
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

  test('ships deep professional playbooks for every specialist branch', () => {
    expect(PROFESSIONAL_SKILL_DEFINITIONS).toHaveLength(47);
    const definitionsWithPlaybooks = BUNDLED_SKILL_DEFINITIONS.filter(
      (definition) => definition.name !== 'plan-mode',
    );
    expect(Object.keys(SKILL_PLAYBOOKS).sort()).toEqual(
      definitionsWithPlaybooks.map((definition) => definition.name).sort(),
    );
    for (const definition of definitionsWithPlaybooks) {
      expect(SKILL_PLAYBOOKS[definition.name]?.split(/\s+/).length).toBeGreaterThan(100);
    }
    expect(PLAN_MODE_SKILL_INSTRUCTIONS.split(/\s+/).length).toBeGreaterThan(100);
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
      original.content.replace('minimum sufficient', 'smallest sufficient'),
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
      targetMedia: ['native'],
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
    expect(draft.metadata.targetMedia).toEqual(['native']);
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
          expect(stderr).toBe('');
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
      ['Design a blinded LLM evaluation benchmark', 'ml-evaluation', 'data-visualization'],
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
    expect(backend.reason).toBe('Matched trigger-example terms: build, daemon');
    expect(prompt.toLowerCase()).toContain('build');
    expect(prompt.toLowerCase()).toContain('daemon');
  });

  test('all bundled professional skills pass their visible trigger and non-trigger cases', () => {
    const results = listSkills(root)
      .filter((skill) => skill.state === 'active')
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

  test('uses a dependency-aware context budget and only blocks mandatory overflow', () => {
    const contract = createTaskContract('Build a professional accessible web interface');
    const compressed = resolveSkills(root, contract.goal, contract, { contextBudget: 16_000 });
    expect(compressed.blocked).toBe(false);
    expect(compressed.compressedByBudget.length).toBeGreaterThan(0);
    expect(compressed.totalContextCost).toBeLessThanOrEqual(16_000);
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
      const requiredCore = BUNDLED_SKILL_DEFINITIONS.find(
        (item) => item.name === name,
      )!.instructions;
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
    expect(pinned.blocked).toBe(true);
    expect(pinned.totalContextCost).toBeGreaterThan(1);
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

  test('injects exactly the advertised bounded full compact and minimal representations', () => {
    const taskContract = createTaskContract('Build a professional accessible web interface');
    const compiled = compilePrompt({
      role: 'worker',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract,
      skillSelection: { contextBudget: 16_000 },
    });
    const firstSkill = compiled.manifest.skills[0]!;
    const skillTextStart = compiled.systemPrompt.indexOf('## Active local skills');
    expect(skillTextStart).toBeGreaterThan(0);
    const actualInjectedSkills = compiled.systemPrompt.slice(skillTextStart);
    const advertisedCost = compiled.manifest.skillContextCost;
    expect(actualInjectedSkills.length).toBe(advertisedCost);
    expect(advertisedCost).toBeLessThanOrEqual(16_000);
    expect(actualInjectedSkills).toContain(`### ${firstSkill.name} v`);
    expect(compiled.manifest.skills.map((item) => item.representation)).toContain('minimal');
    expect(compiled.manifest.skills.map((item) => item.representation)).toContain('compact');
    expect(compiled.manifest.skills.map((item) => item.representation)).toContain('full');

    const roomy = resolveSkills(root, taskContract.goal, taskContract, { contextBudget: 60_000 });
    expect(roomy.selected.map((item) => item.representation)).toContain('full');
    expect(() =>
      compilePrompt({
        role: 'worker',
        mode: 'advanced',
        provider: 'openai',
        workingDirectory: root,
        taskContract,
        skillSelection: { contextBudget: 100 },
      }),
    ).toThrow('Mandatory skill guidance requires');
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
    expect(crowded.budget).toBe(1);
    expect(crowded.occupiedContextChars).toBe(78_000);
    const planning = deriveSkillContextBudget({
      requestedBudget: 12_345,
      occupiedContextTokenUpperBound: 1_000_000,
    });
    expect(planning).toMatchObject({ budget: 12_345, source: 'planning-default' });
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
    ).toThrow('context budget is 1');
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
    ).toThrow('verified context window unavailable');
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
    for (const [index, evaluator] of [
      'deterministic',
      'human-blind-review',
      'human-review',
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

  test('supports explicit keep, replace, and merge choices for bundled updates', () => {
    const original = listSkills(root).find((skill) => skill.name === 'planning')!;
    saveSkillDraft(
      root,
      'personal',
      'planning',
      original.content.replace('dependency-ordered', 'locally edited'),
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
