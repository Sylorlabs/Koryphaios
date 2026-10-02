import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { packageJson, readJsonArtifact, writeFixtureFile } from './skill-eval-fixture-helpers';

const SKILL_RESOLUTION = 'repository-research-full-task-1-individual';
const MCP_ENFORCEMENT = 'repository-research-full-task-2-individual';

function run(root: string, args: string[]): { passed: boolean; output: string } {
  const result = spawnSync('bun', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_000_000,
  });
  return {
    passed: result.status === 0,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim(),
  };
}

function preserved(root: string, files: Readonly<Record<string, string>>): boolean {
  return Object.entries(files).every(([path, content]) => {
    const absolute = join(root, path);
    return existsSync(absolute) && readFileSync(absolute, 'utf8') === content;
  });
}

const RESOLUTION_SKILL = `---
name: deploy-guard
description: Validate cross-owner deploy readiness, rollback ownership, and release guard evidence before cutover.
---

# Deploy guard

Own the release-guard decision. Require readiness evidence and rollback ownership before a cutover is declared ready.
`;

const RESOLUTION_KORY = `${JSON.stringify(
  {
    schemaVersion: 1,
    name: 'deploy-guard',
    version: '5.0.0',
    contextBudget: 1200,
    broader: ['deployment'],
    requires: [],
    activation: ['deploy guard', 'release guard'],
    excludes: ['do not use deploy guard'],
    authoringMaturity: 'individual',
  },
  null,
  2,
)}\n`;

const RESOLUTION_ROUTING = `${JSON.stringify(
  [
    {
      id: 'deploy-guard-positive',
      prompt: 'Run the deploy guard before cutover.',
      expectedSelection: true,
    },
    {
      id: 'deploy-guard-negated',
      prompt: 'Do not use deploy guard; just explain the historical note.',
      expectedSelection: false,
    },
  ],
  null,
  2,
)}\n`;

const RESOLUTION_TASK = `${JSON.stringify(
  {
    id: 'deploy-guard-full-task-1',
    prompt: 'Assess deploy readiness from supplied evidence.',
    environment: { kind: 'synthetic', startingState: 'fixture://deploy-guard/readiness' },
    falsifiableChecks: [{ id: 'rollback-owner', assertion: 'Rollback ownership is explicit.' }],
  },
  null,
  2,
)}\n`;

const SKILL_PACKAGES_SOURCE = `import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface V5Package {
  name: string;
  instructions: string;
  sidecar: {
    name: string;
    version: string;
    contextBudget: number;
    broader: string[];
    requires: string[];
    activation: string[];
    excludes: string[];
  };
  routing: unknown[];
  tasks: unknown[];
  supportingResources: string[];
}

function frontmatterName(source: string): string {
  return source.match(/^name:\\s*([a-z0-9-]+)$/m)?.[1] ?? '';
}

export function parseV5SkillPackage(directory: string): V5Package {
  const skillPath = join(directory, 'SKILL.md');
  const sidecarPath = join(directory, 'kory.json');
  if (!existsSync(skillPath) || !existsSync(sidecarPath)) throw new Error('missing package contract');
  const instructions = readFileSync(skillPath, 'utf8');
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as V5Package['sidecar'];
  if (!sidecar.name || frontmatterName(instructions) !== sidecar.name) {
    throw new Error('skill/package name mismatch');
  }
  if (!Number.isInteger(sidecar.contextBudget) || sidecar.contextBudget < 100) {
    throw new Error('invalid context budget');
  }
  if (!Array.isArray(sidecar.activation) || sidecar.activation.length === 0) {
    throw new Error('missing bounded activation contract');
  }
  const routingPath = join(directory, 'evals/routing.json');
  const tasksRoot = join(directory, 'evals/tasks');
  const routing = JSON.parse(readFileSync(routingPath, 'utf8')) as unknown[];
  const tasks = readdirSync(tasksRoot)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(tasksRoot, name), 'utf8')) as unknown);
  const resourcesRoot = join(directory, 'references');
  const supportingResources = existsSync(resourcesRoot)
    ? readdirSync(resourcesRoot).sort().map((name) => join('references', name))
    : [];
  return { name: sidecar.name, instructions, sidecar, routing, tasks, supportingResources };
}

export function loadV5SkillPackages(root = 'skills-v5'): V5Package[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseV5SkillPackage(join(root, entry.name)));
}
`;

const SKILLS_RUNTIME_SOURCE = `import { createHash } from 'node:crypto';
import type { V5Package } from './skill-packages';
import { loadV5SkillPackages } from './skill-packages';

interface Definition {
  name: string;
  instructions: string;
  contextBudget: number;
  broader: string[];
  requires: string[];
  activation: string[];
  excludes: string[];
  packageBacked: boolean;
}

export interface SkillRevision extends Definition {
  hash: string;
  baseHash: string;
  locallyEdited: boolean;
}

const STABLE_DEFINITIONS: Definition[] = [
  {
    name: 'deployment',
    instructions: 'General deployment lifecycle guidance.',
    contextBudget: 900,
    broader: [],
    requires: [],
    activation: ['deployment'],
    excludes: [],
    packageBacked: false,
  },
  {
    name: 'deploy-guard',
    instructions: 'Legacy TypeScript fallback for stable skill identity.',
    contextBudget: 900,
    broader: ['deployment'],
    requires: [],
    activation: ['deploy guard'],
    excludes: [],
    packageBacked: false,
  },
];

function packageDefinition(pkg: V5Package): Definition {
  return {
    name: pkg.name,
    instructions: pkg.instructions,
    contextBudget: pkg.sidecar.contextBudget,
    broader: [...pkg.sidecar.broader],
    requires: [...pkg.sidecar.requires],
    activation: [...pkg.sidecar.activation],
    excludes: [...pkg.sidecar.excludes],
    packageBacked: true,
  };
}

export function packageBackedBundledDefinitions(packages = loadV5SkillPackages()): Definition[] {
  const overlays = new Map(packages.map((pkg) => [pkg.name, packageDefinition(pkg)]));
  const names = new Set([...STABLE_DEFINITIONS.map((item) => item.name), ...overlays.keys()]);
  return [...names]
    .sort()
    .map((name) => overlays.get(name) ?? STABLE_DEFINITIONS.find((item) => item.name === name)!);
}

function hash(definition: Definition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

export function seedDefaultSkills(
  existing: SkillRevision[] = [],
  packages = loadV5SkillPackages(),
): SkillRevision[] {
  const existingByName = new Map(existing.map((item) => [item.name, item]));
  return packageBackedBundledDefinitions(packages).map((definition) => {
    const baseHash = hash(definition);
    const prior = existingByName.get(definition.name);
    // Preservation boundary: a locally edited active revision is not overwritten by a new bundle.
    if (prior?.locallyEdited) return prior;
    return { ...definition, hash: baseHash, baseHash, locallyEdited: false };
  });
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/-]+/g, ' ').trim();
}

function directMatch(skill: SkillRevision, prompt: string): boolean {
  const text = normalized(prompt);
  if (skill.excludes.some((phrase) => text.includes(normalized(phrase)))) return false;
  if (/\\b(?:do not|not|without)\\b.{0,30}\\b(?:deploy guard|release guard)\\b/.test(text)) {
    return false;
  }
  return skill.activation.some((phrase) => text.includes(normalized(phrase)));
}

export function resolveSkills(prompt: string, contextBudget = 5000, revisions = seedDefaultSkills()) {
  const byName = new Map(revisions.map((item) => [item.name, item]));
  const direct = revisions.filter((skill) => directMatch(skill, prompt));
  const expanded = new Map<string, SkillRevision>();
  const includeWithAncestors = (skill: SkillRevision): void => {
    for (const dependency of [...skill.broader, ...skill.requires]) {
      const parent = byName.get(dependency);
      if (parent) includeWithAncestors(parent);
    }
    expanded.set(skill.name, skill);
  };
  direct.forEach(includeWithAncestors);
  const ordered = [...expanded.values()];
  let remaining = contextBudget;
  const selected = ordered.map((skill) => {
    const fullCost = skill.instructions.length;
    const representation = fullCost <= remaining ? 'full' : remaining >= 120 ? 'compact' : 'minimal';
    const cost = representation === 'full' ? fullCost : representation === 'compact' ? 120 : 60;
    remaining = Math.max(0, remaining - cost);
    return { name: skill.name, representation, packageBacked: skill.packageBacked };
  });
  return { selected };
}
`;

const RESOLUTION_TEST = `import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseV5SkillPackage } from '../backend/src/kory/skill-packages';
import { packageBackedBundledDefinitions, resolveSkills, seedDefaultSkills } from '../backend/src/kory/skills';

test('package-backed definition overlays stable fallback and seeds active revision', () => {
  const definitions = packageBackedBundledDefinitions();
  const guard = definitions.find((item) => item.name === 'deploy-guard')!;
  expect(guard.packageBacked).toBe(true);
  expect(guard.instructions).toContain('Own the release-guard decision');
  const seeded = seedDefaultSkills();
  expect(seeded.find((item) => item.name === 'deploy-guard')?.baseHash).toHaveLength(64);
});

test('real resolver expands broader dependency before child and respects negation', () => {
  const selected = resolveSkills('Run the deploy guard before cutover.', 5000).selected;
  expect(selected.map((item) => item.name)).toEqual(['deployment', 'deploy-guard']);
  expect(selected.at(-1)?.packageBacked).toBe(true);
  expect(resolveSkills('Do not use deploy guard; explain the old note.', 5000).selected).toEqual([]);
});

test('context budget changes representation without dropping mandatory expansion', () => {
  const selected = resolveSkills('Run the deploy guard before cutover.', 150).selected;
  expect(selected.map((item) => item.name)).toEqual(['deployment', 'deploy-guard']);
  expect(selected.some((item) => item.representation !== 'full')).toBe(true);
});

test('invalid package definition fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-invalid-package-'));
  mkdirSync(join(root, 'evals/tasks'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '---\\nname: one\\ndescription: invalid fixture\\n---\\nbody\\n');
  writeFileSync(join(root, 'kory.json'), JSON.stringify({ name: 'two', contextBudget: 1200, activation: ['x'] }));
  writeFileSync(join(root, 'evals/routing.json'), '[]');
  writeFileSync(join(root, 'evals/tasks/a.json'), '{}');
  expect(() => parseV5SkillPackage(root)).toThrow(/name mismatch/);
});
`;

const RESOLUTION_TRACE_SCRIPT = `import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { packageBackedBundledDefinitions, resolveSkills, seedDefaultSkills } from '../backend/src/kory/skills';

const packages = loadV5SkillPackages();
const definitions = packageBackedBundledDefinitions(packages);
const revisions = seedDefaultSkills([], packages);
const result = resolveSkills('Run the deploy guard before cutover.', 150, revisions);
console.log(JSON.stringify({
  packages: packages.map((item) => item.name),
  packageBacked: definitions.find((item) => item.name === 'deploy-guard')?.packageBacked,
  seededHash: revisions.find((item) => item.name === 'deploy-guard')?.hash,
  selected: result.selected,
}));
`;

const RESOLUTION_README = `# Kory V5 skill-resolution research fixture

This is a read-only repository-research task. Do not edit source files. Trace the active path rather than assuming \`skills-v5\` is inert prompt text.

The fixture intentionally contains a stable TypeScript fallback definition and a first-class V5 package with the same stable skill ID. Trace package parsing/validation, package-backed overlay, seeding and local-edit preservation, trigger/exclusion/negation, broader/required expansion, dependency-before-dependent ordering, context-budget representation, and final resolver output.

Corroborate with \`bun test tests/skill-resolution.test.ts\` and/or \`bun run scripts/trace-skill-resolution.ts\`. Write \`.kory-eval/repository-research-skill-resolution.json\` with an ordered stage trace, file/symbol ownership, evidence class (implemented/configured/tested/observed/documented), package-vs-seeded distinction, failure-closed evidence, and any unresolved/static-only limits.
`;

const RESOLUTION_FILES: Readonly<Record<string, string>> = {
  'skills-v5/deploy-guard/SKILL.md': RESOLUTION_SKILL,
  'skills-v5/deploy-guard/kory.json': RESOLUTION_KORY,
  'skills-v5/deploy-guard/evals/routing.json': RESOLUTION_ROUTING,
  'skills-v5/deploy-guard/evals/tasks/task.json': RESOLUTION_TASK,
  'skills-v5/deploy-guard/references/sources.md': '# Sources\n\nFixture source map.\n',
  'backend/src/kory/skill-packages.ts': SKILL_PACKAGES_SOURCE,
  'backend/src/kory/skills.ts': SKILLS_RUNTIME_SOURCE,
  'tests/skill-resolution.test.ts': RESOLUTION_TEST,
  'scripts/trace-skill-resolution.ts': RESOLUTION_TRACE_SCRIPT,
  'README.md': RESOLUTION_README,
};

const resolutionMaterializer: SkillEvalFixtureMaterializer = {
  id: 'repository-research/kory-skill-resolution@1',
  matches: (scenario) => scenario.id === SKILL_RESOLUTION,
  materialize: (destination) => {
    writeFixtureFile(
      destination,
      'package.json',
      packageJson('kory-repository-research-resolution'),
    );
    for (const [path, content] of Object.entries(RESOLUTION_FILES)) {
      writeFixtureFile(destination, path, content);
    }
  },
};

const GRANT_SOURCE = `export interface BridgeGrant {
  sessionId: string;
  role: string;
  actions: string[];
  expiresAt: string;
}

export function validateGrant(
  grant: BridgeGrant | null,
  input: { sessionId: string; role: string; action: string; now?: string },
): void {
  if (!grant) throw new Error('missing bridge grant');
  if (grant.sessionId !== input.sessionId) throw new Error('grant session mismatch');
  if (grant.role !== input.role) throw new Error('grant role mismatch');
  if (!grant.actions.includes(input.action)) throw new Error('grant action denied');
  if (Date.parse(grant.expiresAt) <= Date.parse(input.now ?? new Date().toISOString())) {
    throw new Error('bridge grant expired');
  }
}
`;

const CLI_MCP_CONFIG_SOURCE = `export function buildKoryMcpConfig(grantFile: string) {
  return {
    command: 'bun',
    args: ['run', 'backend/src/providers/kory-mcp-bridge.ts'],
    env: { KORY_MCP_GRANT_FILE: grantFile },
    nativeProviderTools: 'provider-managed-and-sandboxed-separately',
  };
}
`;

const POLICY_SOURCE = `export function authorizeTool(role: string, tool: string): void {
  if (role === 'worker' && tool === 'write_marker') return;
  if (role === 'reader' && tool === 'read_status') return;
  throw new Error('permission policy denied tool');
}
`;

const REGISTRY_SOURCE = `import { authorizeTool } from './permission-policy';

export interface ToolState { marker: string | null }

export class ToolRegistry {
  constructor(private readonly state: ToolState) {}

  catalog(role: string): string[] {
    return role === 'worker' ? ['write_marker'] : ['read_status'];
  }

  execute(role: string, tool: string, input: Record<string, unknown>) {
    authorizeTool(role, tool);
    if (tool === 'write_marker') {
      this.state.marker = String(input.value ?? '');
      return { ok: true, marker: this.state.marker };
    }
    return { ok: true, marker: this.state.marker };
  }
}
`;

const MCP_ROUTE_SOURCE = `import type { BridgeGrant } from '../../providers/bridge-grant';
import { validateGrant } from '../../providers/bridge-grant';
import { ToolRegistry } from '../../tools/registry';

export function listBridgeTools(input: {
  grant: BridgeGrant | null;
  sessionId: string;
  role: string;
  registry: ToolRegistry;
}) {
  validateGrant(input.grant, { ...input, action: 'catalog', now: '2026-09-06T00:00:00Z' });
  return input.registry.catalog(input.role);
}

export function callBridgeTool(input: {
  grant: BridgeGrant | null;
  sessionId: string;
  role: string;
  tool: string;
  payload: Record<string, unknown>;
  registry: ToolRegistry;
}) {
  validateGrant(input.grant, {
    ...input,
    action: 'call:' + input.tool,
    now: '2026-09-06T00:00:00Z',
  });
  return input.registry.execute(input.role, input.tool, input.payload);
}
`;

const BRIDGE_SOURCE = `import { readFileSync } from 'node:fs';
import type { BridgeGrant } from './bridge-grant';
import { callBridgeTool, listBridgeTools } from '../routes/v1/mcp-bridge';
import { ToolRegistry, type ToolState } from '../tools/registry';

export function loadGrant(path: string | undefined): BridgeGrant | null {
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeGrant;
}

export function buildBridge(input: {
  grantFile?: string;
  sessionId: string;
  role: string;
  state: ToolState;
}) {
  const grant = loadGrant(input.grantFile);
  const registry = new ToolRegistry(input.state);
  return {
    listTools: () => listBridgeTools({ grant, sessionId: input.sessionId, role: input.role, registry }),
    callTool: (tool: string, payload: Record<string, unknown>) =>
      callBridgeTool({ grant, sessionId: input.sessionId, role: input.role, tool, payload, registry }),
  };
}
`;

const MCP_GRANT = `${JSON.stringify(
  {
    sessionId: 'session-123',
    role: 'worker',
    actions: ['catalog', 'call:write_marker', 'call:delete_project'],
    expiresAt: '2099-01-01T00:00:00Z',
  },
  null,
  2,
)}\n`;

const MCP_TEST = `import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildBridge } from '../backend/src/providers/kory-mcp-bridge';
import { buildKoryMcpConfig } from '../backend/src/providers/kory-cli-mcp-config';

const grantFile = join(process.cwd(), '.grants/worker.json');

test('provider receives only bridge config reference; native tools remain a separate provider boundary', () => {
  const config = buildKoryMcpConfig(grantFile);
  expect(config.env.KORY_MCP_GRANT_FILE).toBe(grantFile);
  expect(config.nativeProviderTools).toBe('provider-managed-and-sandboxed-separately');
});

test('valid scoped grant reaches registry policy and permitted side effect', () => {
  const state = { marker: null as string | null };
  const bridge = buildBridge({ grantFile, sessionId: 'session-123', role: 'worker', state });
  expect(bridge.listTools()).toEqual(['write_marker']);
  expect(bridge.callTool('write_marker', { value: 'observed-effect' })).toEqual({
    ok: true,
    marker: 'observed-effect',
  });
  expect(state.marker).toBe('observed-effect');
});

test('grant scope fails closed for mismatched session or missing grant', () => {
  const state = { marker: null as string | null };
  expect(() =>
    buildBridge({ grantFile, sessionId: 'wrong-session', role: 'worker', state }).listTools(),
  ).toThrow(/session mismatch/);
  expect(() =>
    buildBridge({ sessionId: 'session-123', role: 'worker', state }).listTools(),
  ).toThrow(/missing bridge grant/);
});

test('grant possession does not bypass ToolRegistry permission policy', () => {
  const state = { marker: null as string | null };
  const bridge = buildBridge({ grantFile, sessionId: 'session-123', role: 'worker', state });
  expect(() => bridge.callTool('delete_project', {})).toThrow(/permission policy denied/);
  expect(state.marker).toBeNull();
});
`;

const MCP_TRACE_SCRIPT = `import { join } from 'node:path';
import { buildBridge } from '../backend/src/providers/kory-mcp-bridge';

const state = { marker: null as string | null };
const bridge = buildBridge({
  grantFile: join(process.cwd(), '.grants/worker.json'),
  sessionId: 'session-123',
  role: 'worker',
  state,
});
const catalog = bridge.listTools();
const result = bridge.callTool('write_marker', { value: 'trace-effect' });
let denied = '';
try { bridge.callTool('delete_project', {}); } catch (error) { denied = String(error); }
console.log(JSON.stringify({ catalog, result, state, denied }));
`;

const MCP_README = `# Kory MCP enforcement research fixture

This is read-only repository research. Do not modify or weaken the security boundary.

Trace the bridge grant from provider-visible config through \`kory-mcp-bridge.ts\`, backend catalog/call routing, \`ToolRegistry.execute()\`, permission-policy authorization, and the final tool effect. The private grant authenticates and scopes bridge actions; possession of the grant does **not** bypass tool policy and does **not** mean the provider's native tools are disabled. Native tools are a separate provider/sandbox boundary.

Corroborate both success and denial with \`bun test tests/mcp-enforcement.test.ts\` and/or \`bun run scripts/trace-mcp-enforcement.ts\`. Write \`.kory-eval/repository-research-mcp-enforcement.json\` with an ordered grant→effect trace, file/symbol ownership, session/role/action scope, negative-path evidence, evidence-class labels, and any distinction between implemented/configured/tested/observed/documented claims.
`;

const MCP_FILES: Readonly<Record<string, string>> = {
  'backend/src/providers/bridge-grant.ts': GRANT_SOURCE,
  'backend/src/providers/kory-cli-mcp-config.ts': CLI_MCP_CONFIG_SOURCE,
  'backend/src/providers/kory-mcp-bridge.ts': BRIDGE_SOURCE,
  'backend/src/routes/v1/mcp-bridge.ts': MCP_ROUTE_SOURCE,
  'backend/src/tools/registry.ts': REGISTRY_SOURCE,
  'backend/src/tools/permission-policy.ts': POLICY_SOURCE,
  '.grants/worker.json': MCP_GRANT,
  'tests/mcp-enforcement.test.ts': MCP_TEST,
  'scripts/trace-mcp-enforcement.ts': MCP_TRACE_SCRIPT,
  'README.md': MCP_README,
};

const mcpMaterializer: SkillEvalFixtureMaterializer = {
  id: 'repository-research/kory-mcp-enforcement@1',
  matches: (scenario) => scenario.id === MCP_ENFORCEMENT,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-repository-research-mcp'));
    for (const [path, content] of Object.entries(MCP_FILES)) {
      writeFixtureFile(destination, path, content);
    }
  },
};

function normalized(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

const resolutionScorer: SkillEvalDeterministicScorer = {
  id: 'repository-research/kory-skill-resolution-scorer@1',
  scenarioIds: [SKILL_RESOLUTION],
  score: ({ workingDirectory }) => {
    const sourcePreserved = preserved(workingDirectory, RESOLUTION_FILES);
    const tests = run(workingDirectory, ['test', 'tests/skill-resolution.test.ts']);
    const trace = run(workingDirectory, ['run', 'scripts/trace-skill-resolution.ts']);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/repository-research-skill-resolution.json',
    );
    const body = normalized(artifact);
    const loader =
      /skill-packages\.ts/u.test(body) &&
      /loadv5skillpackages/u.test(body) &&
      /parsev5skillpackage/u.test(body) &&
      /skill\.md/u.test(body) &&
      /kory\.json/u.test(body) &&
      /routing\.json/u.test(body) &&
      /evals\/tasks|task\.json/u.test(body);
    const overlaySeed =
      /packagebackedbundleddefinitions/u.test(body) &&
      /stable|legacy|fallback/u.test(body) &&
      /seeddefaultskills/u.test(body) &&
      /local.*edit|preserv/u.test(body) &&
      /basehash|seeded|revision/u.test(body);
    const resolver =
      /resolveskills/u.test(body) &&
      /activat|trigger/u.test(body) &&
      /exclud|negat/u.test(body) &&
      /broader/u.test(body) &&
      /require/u.test(body) &&
      /dependency|parent/u.test(body) &&
      /context.*budget|representation|compact|minimal/u.test(body);
    const provenance = /implemented/u.test(body) && /tested/u.test(body) && /observed/u.test(body);
    const negative = /invalid|fail closed|name mismatch/u.test(body);
    const passed =
      sourcePreserved &&
      tests.passed &&
      trace.passed &&
      Boolean(artifact) &&
      loader &&
      overlaySeed &&
      resolver &&
      provenance &&
      negative;
    return {
      passed,
      quality: passed
        ? 1
        : tests.passed && trace.passed && loader && resolver
          ? 0.75
          : tests.passed
            ? 0.5
            : 0,
      verification: tests.passed && trace.passed ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `repository remained read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `real resolver/fail-closed tests: ${tests.passed ? 'pass' : 'fail'}`,
        `deterministic resolver trace: ${trace.passed ? 'pass' : 'fail'}`,
        `package→overlay→seed trace: ${loader && overlaySeed ? 'complete' : 'incomplete'}`,
        `trigger/dependency/context trace: ${resolver ? 'complete' : 'incomplete'}`,
        `evidence-class + negative-path labels: ${provenance && negative ? 'present' : 'missing'}`,
      ],
    };
  },
};

const mcpScorer: SkillEvalDeterministicScorer = {
  id: 'repository-research/kory-mcp-enforcement-scorer@1',
  scenarioIds: [MCP_ENFORCEMENT],
  score: ({ workingDirectory }) => {
    const sourcePreserved = preserved(workingDirectory, MCP_FILES);
    const tests = run(workingDirectory, ['test', 'tests/mcp-enforcement.test.ts']);
    const trace = run(workingDirectory, ['run', 'scripts/trace-mcp-enforcement.ts']);
    const artifact = readJsonArtifact<unknown>(
      workingDirectory,
      '.kory-eval/repository-research-mcp-enforcement.json',
    );
    const body = normalized(artifact);
    const grant =
      /bridge-grant\.ts/u.test(body) &&
      /session/u.test(body) &&
      /role/u.test(body) &&
      /action/u.test(body) &&
      /expir/u.test(body) &&
      /kory_mcp_grant_file|grant.*file/u.test(body);
    const dispatch =
      /kory-mcp-bridge\.ts/u.test(body) &&
      /mcp-bridge\.ts/u.test(body) &&
      /catalog|listtools/u.test(body) &&
      /calltool|call.*tool/u.test(body) &&
      /toolregistry|registry\.ts/u.test(body) &&
      /permission-policy|authorize/u.test(body) &&
      /write_marker|marker|side effect/u.test(body);
    const negative =
      /mismatch|missing grant|denied|negative/u.test(body) &&
      /permission/u.test(body) &&
      /does not|not bypass|cannot|separate/u.test(body);
    const nativeBoundary =
      /native.*tool/u.test(body) &&
      /separate|provider-managed|sandbox/u.test(body) &&
      !/native.*tools[^.]{0,60}(?:disabled by|disabled because).*mcp/u.test(body);
    const provenance = /implemented/u.test(body) && /tested/u.test(body) && /observed/u.test(body);
    const passed =
      sourcePreserved &&
      tests.passed &&
      trace.passed &&
      Boolean(artifact) &&
      grant &&
      dispatch &&
      negative &&
      nativeBoundary &&
      provenance;
    return {
      passed,
      quality: passed
        ? 1
        : tests.passed && trace.passed && grant && dispatch
          ? 0.75
          : tests.passed
            ? 0.5
            : 0,
      verification: tests.passed && trace.passed ? 1 : 0,
      integrityFailure: !sourcePreserved,
      evidence: [
        `security sources remained read-only: ${sourcePreserved ? 'yes' : 'no'}`,
        `positive + denied enforcement tests: ${tests.passed ? 'pass' : 'fail'}`,
        `grant→registry→effect trace: ${trace.passed ? 'pass' : 'fail'}`,
        `session/role/action grant lifecycle: ${grant ? 'complete' : 'incomplete'}`,
        `registry/policy enforcement path: ${dispatch ? 'complete' : 'incomplete'}`,
        `negative/native-tool boundary: ${negative && nativeBoundary ? 'correct' : 'missing/incorrect'}`,
      ],
    };
  },
};

export const REPOSITORY_RESEARCH_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [resolutionMaterializer, mcpMaterializer];

export const REPOSITORY_RESEARCH_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  resolutionScorer,
  mcpScorer,
];
