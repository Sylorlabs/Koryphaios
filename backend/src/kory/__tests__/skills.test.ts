import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateSkill,
  applyDefaultUpdate,
  createSkillDraft,
  listSkills,
  renderSkillInstructions,
  resolveSkills,
  saveSkillDraft,
  testSkill,
  validateSkillContent,
  enforceSkillLearningPolicy,
} from '../skills';
import { compilePrompt, createTaskContract } from '../prompts';
import { LoadSkillDetailTool } from '../../tools/skills';
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
import { PROFESSIONAL_SKILL_DEFINITIONS } from '../professional-skill-definitions';

let root = '';
let skillsHome = '';

const BASELINE_SKILL_WORD_COUNTS: Record<string, number> = {
  'accessibility-practice': 308, 'distributed-backend': 100, 'functional-verification': 173,
  'interface-usability-testing': 105, 'developer-experience': 301, 'visual-verification': 323,
  'reliability-verification': 180, 'concurrency-debugging': 180, 'release-planning': 197,
  'in-process-backend': 102, 'experimental-analysis': 241, 'operational-data-analysis': 255,
  'novel-ui-toolkit': 172, debugging: 182, research: 153, implementation: 198,
  'backend-engineering': 128, 'skill-authoring-evaluation': 202,
  'performance-verification': 185, 'instructional-communication': 194,
  'human-experience': 313, 'user-research': 308, 'interaction-design': 301,
  'terminal-interface': 128, 'security-review': 150, 'reference-communication': 198,
  'game-spatial-interface': 190, 'testing-engineering': 141,
  'visual-interface-design': 566, 'architecture-planning': 211,
  'integration-fault-testing': 87, 'deterministic-debugging': 179,
  'infrastructure-security': 269, 'integration-implementation': 195,
  'property-fuzz-differential-testing': 84, 'authorization-security': 255,
  'refactor-implementation': 202, 'hardware-runtime-debugging': 195,
  'migration-planning': 201, 'market-competitive-research': 251, verification: 179,
  'information-architecture': 292, 'performance-debugging': 191,
  'literature-research': 253, 'security-verification': 186, 'task-routing': 136,
  'web-interface': 241, 'language-runtime-security': 251,
  'accessibility-verification': 187, 'content-error-design': 309,
  'deterministic-contract-testing': 86, 'repository-environment-discovery': 142,
  'repository-research': 249, 'local-service-backend': 100,
  'simulation-device-testing': 93, 'documents-communication': 195,
  'application-security': 256, 'supply-chain-security': 253,
  'embedded-device-security': 254, 'embedded-interface': 180, 'factual-research': 252,
  'usability-evaluation': 290, 'data-visualization': 245, 'privacy-engineering': 249,
  'feature-implementation': 205, 'data-analysis': 145, 'statistical-inference': 243,
  'ml-evaluation': 254, 'performance-testing': 87, planning: 195, 'plan-mode': 180,
  'executive-communication': 200, 'compiler-runtime-backend': 103,
  'frontend-engineering': 205, 'network-service-backend': 98,
  'technical-communication': 193, 'exploratory-data-analysis': 250,
  'distributed-debugging': 180, 'native-interface': 157,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-skills-project-'));
  skillsHome = mkdtempSync(join(tmpdir(), 'kory-skills-home-'));
  process.env.KORYPHAIOS_SKILLS_HOME = skillsHome;
  mkdirSync(join(root, '.git'));
});

afterEach(() => {
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
    expect(() =>
      enforceSkillLearningPolicy('propose-then-verify', 'agent', 'activate'),
    ).toThrow();
    expect(() => enforceSkillLearningPolicy('automatic', 'agent', 'activate', false)).toThrow();
    expect(() => enforceSkillLearningPolicy('automatic', 'agent', 'activate', true)).not.toThrow();
  });
  test('seeds the complete instruction-only default library', () => {
    const active = listSkills(root).filter((skill) => skill.state === 'active');
    expect(active).toHaveLength(79);
    expect(active.every((skill) => skill.validation.valid)).toBe(true);
    expect(active.every((skill) => skill.metadata.sourceScope === 'local-only')).toBe(true);
  });

  test('keeps every bundled skill at least three times deeper than the audited baseline', () => {
    const active = listSkills(root).filter((skill) => skill.state === 'active');
    expect(Object.keys(BASELINE_SKILL_WORD_COUNTS)).toHaveLength(active.length);
    for (const skill of active) {
      const words = skill.instructions.trim().split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(BASELINE_SKILL_WORD_COUNTS[skill.name] * 3);
      expect(skill.metadata.version).toBe('3.0.0');
      expect(skill.metadata.contextBudget).toBe(16_000);
    }
  });

  test('migrates exact pre-hash bundled skills but preserves human-edited legacy copies', () => {
    const legacy = `---
name: planning
description: Create bounded, acceptance-driven implementation plans.
metadata:
  koryphaios:
    version: 1.0.0
    baseVersion: 1.0.0
    domains: ["planning"]
    targetMedia: ["any"]
    shouldTrigger: ["plan and implement a feature"]
    shouldNotTrigger: ["what is this variable"]
    evidence: ["Acceptance criteria"]
    contextBudget: 1200
    sourceScope: local-only
---
# planning

Translate the task contract into coherent dependency-ordered work with explicit acceptance criteria, risks, and verification.
`;
    const planningDir = join(skillsHome, 'planning');
    mkdirSync(planningDir, { recursive: true });
    writeFileSync(join(planningDir, 'SKILL.md'), legacy);
    let planning = listSkills(root).find((skill) => skill.name === 'planning')!;
    expect(planning.metadata.version).toBe('3.0.0');
    expect(planning.instructions.split(/\s+/).length).toBeGreaterThanOrEqual(585);

    writeFileSync(join(planningDir, 'SKILL.md'), legacy.replace('coherent', 'human-customized'));
    planning = listSkills(root).find((skill) => skill.name === 'planning')!;
    expect(planning.metadata.version).toBe('1.0.0');
    expect(planning.instructions).toContain('human-customized');
  });

  test('keeps foundational skills concise but operationally complete', () => {
    const skills = listSkills(root);
    for (const name of [
      'task-routing',
      'repository-environment-discovery',
      'research',
      'security-review',
      'data-analysis',
      'skill-authoring-evaluation',
    ]) {
      const skill = skills.find((item) => item.name === name && item.state === 'active')!;
      expect(skill.instructions.split(/\s+/).length).toBeGreaterThan(90);
    }
  });

  test('creates valid user-authored skills as inactive local drafts', () => {
    const draft = createSkillDraft(root, 'project', {
      name: 'release-notes-review',
      description: 'Review release notes when preparing a user-facing product release.',
      instructions:
        'Inspect the actual change set and audience. Map every consequential change to accurate user impact, migration guidance, compatibility limits, and reproducible verification before approving the notes.',
      domains: ['release', 'communication'],
      activation: ['release notes'],
      shouldTrigger: [
        'Review these release notes before launch',
        'Check this changelog for missing migration guidance',
      ],
      shouldNotTrigger: ['Fix this runtime crash', 'Design a settings screen'],
      evidence: ['Change-to-note traceability', 'Rendered notes reviewed'],
    });

    expect(draft.state).toBe('draft');
    expect(draft.source).toBe('project');
    expect(draft.validation.valid).toBe(true);
    expect(testSkill(draft).passed).toBe(true);
    expect(listSkills(root).some((skill) => skill.name === draft.name && skill.state === 'active')).toBe(
      false,
    );
    expect(() =>
      createSkillDraft(root, 'project', {
        name: 'release-notes-review',
        description: 'Review release notes when preparing a user-facing product release.',
        instructions:
          'Inspect the actual change set and verify every consequential statement before approving the release notes.',
        shouldTrigger: ['Review these release notes', 'Audit this changelog'],
        shouldNotTrigger: ['Fix this runtime crash', 'Design a settings screen'],
      }),
    ).toThrow('already exists');
  });

  test('loads professional playbooks only with their selected skill revision', () => {
    const skills = listSkills(root);
    const experience = skills.find((skill) => skill.name === 'human-experience')!;
    const visualDesign = skills.find((skill) => skill.name === 'visual-interface-design')!;
    const visualVerification = skills.find((skill) => skill.name === 'visual-verification')!;
    const routing = skills.find((skill) => skill.name === 'task-routing')!;
    expect(experience.instructions).toContain('Map entry, orientation, setup');
    expect(visualDesign.instructions).toContain('State a concise visual read before implementation');
    expect(visualDesign.instructions).toContain('Run a visual pre-flight before declaring completion');
    expect(visualDesign.instructions).toContain('These are universal checks, not web prescriptions');
    expect(visualVerification.instructions).toContain('Mark each visual claim passed, failed, or unavailable');
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
    for (const definition of PROFESSIONAL_SKILL_DEFINITIONS) {
      expect(SKILL_PLAYBOOKS[definition.name]?.split(/\s+/).length).toBeGreaterThan(100);
    }
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
    expect(activateSkill(root, 'personal', 'implementation').content).toContain(
      'smallest sufficient',
    );
  });

  test('rejects path identity drift and hierarchy cycles before activation', () => {
    const planning = listSkills(root).find((skill) => skill.name === 'planning')!;
    expect(() =>
      saveSkillDraft(
        root,
        'personal',
        'planning',
        planning.content.replace('name: planning', 'name: renamed-planning'),
      ),
    ).toThrow('must match its path name');

    const web = listSkills(root).find((skill) => skill.name === 'web-interface')!;
    saveSkillDraft(
      root,
      'personal',
      'web-interface',
      web.content.replace('parent: frontend-engineering', 'parent: web-interface'),
    );
    expect(() => activateSkill(root, 'personal', 'web-interface')).toThrow('cannot depend on itself');
  });

  test('selects small relevant bundles and blocks unresolved personal/project collisions', () => {
    const contract = createTaskContract('Fix the native settings crash');
    const result = resolveSkills(root, contract.goal, contract, { targetMedium: 'native' });
    expect(result.blocked).toBe(false);
    expect(result.selected.map((item) => item.skill.name)).toContain('debugging');
    expect(result.totalContextCost).toBeLessThanOrEqual(120_000);

    const personal = listSkills(root).find((skill) => skill.name === 'debugging')!;
    const directory = join(root, '.koryphaios', 'skills', 'debugging');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      personal.content.replace('version: 1.0.0', 'version: 1.0.1'),
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
    expect(web.metadata.requires).toContain('accessibility-practice');
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
      web.content.replace('parent: frontend-engineering', 'parent: missing-frontend-parent'),
    );
    expect(() => activateSkill(root, 'personal', 'web-interface')).toThrow(
      'requires missing skill missing-frontend-parent',
    );
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

  test('records context-aware skill compression in the prompt manifest', () => {
    const compiled = compilePrompt({
      role: 'worker',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('Build a professional accessible web interface'),
      skillSelection: { contextBudget: 10_000 },
    });
    expect(compiled.manifest.skillContext.budgetChars).toBe(10_000);
    expect(compiled.manifest.skillContext.compressed.length).toBeGreaterThan(0);
    expect(compiled.manifest.skills.some((skill) => skill.representation !== 'full')).toBe(true);
    expect(compiled.systemPrompt).toContain('load_skill_detail');
    expect(compiled.systemPrompt).toContain('Context disclosure:');
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

  test('compresses required skills before blocking under context pressure', () => {
    const contract = createTaskContract('Build a professional accessible web interface');
    const compressed = resolveSkills(root, contract.goal, contract, { contextBudget: 10_000 });
    expect(compressed.omittedByBudget).toEqual([]);
    expect(compressed.compressedByBudget.length).toBeGreaterThan(0);
    expect(compressed.blocked).toBe(false);
    expect(compressed.totalContextCost).toBeLessThanOrEqual(10_000);
    const names = new Set(compressed.selected.map((item) => item.skill.name));
    for (const item of compressed.selected) {
      if (item.skill.metadata.parent) expect(names.has(item.skill.metadata.parent)).toBe(true);
      if (item.representation !== 'full') {
        expect(item.renderedInstructions).toContain('Compact');
        expect(item.omittedDetailChars).toBeGreaterThan(0);
      }
    }
    const pinned = resolveSkills(root, contract.goal, contract, {
      contextBudget: 1,
      pins: ['web-interface'],
    });
    expect(pinned.blocked).toBe(true);
    expect(pinned.totalContextCost).toBeGreaterThan(1);
  });

  test('pins the detailed Plan mode skill independently of request wording', () => {
    const contract = createTaskContract('Rename this local variable');
    const result = resolveSkills(root, contract.goal, contract, { pins: ['plan-mode'] });
    const planMode = result.selected.find((item) => item.skill.name === 'plan-mode');
    expect(planMode).toBeDefined();
    expect(planMode?.renderedInstructions).toContain('Ask useful questions early and throughout');
    expect(planMode?.renderedInstructions).toContain('living planning record');
    expect(planMode?.renderedInstructions).toContain('KORY_PLAN_READY');
  });

  test('never emits a partial executable block in a shortened skill', () => {
    const skill = listSkills(root).find((item) => item.name === 'planning')!;
    const scripted = {
      ...skill,
      instructions: `${skill.instructions}\n\n\`\`\`bash\nprintf dangerous-partial\n\`\`\``,
    };
    const compact = renderSkillInstructions(scripted, 'compact');
    expect(compact).not.toContain('printf dangerous-partial');
    expect(compact).not.toContain('```');
    expect(compact).toContain('Required completion evidence');
  });

  test('recovers full skill detail on demand without granting authority', async () => {
    const skill = listSkills(root).find((item) => item.name === 'planning')!;
    const tool = new LoadSkillDetailTool();
    const result = await tool.run(
      { sessionId: 'skill-detail-test', workingDirectory: root },
      { id: 'call-1', name: tool.name, input: { name: skill.name, source: skill.source } },
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain(skill.hash);
    expect(result.output).toContain('dependency-ordered');
    expect(tool.description).toContain('never grants tools');
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
        provider: index === 0 ? 'test-provider-a' : 'test-provider-b',
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
});
