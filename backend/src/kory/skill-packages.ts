import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../runtime/paths';

export const V5_SKILL_KINDS = [
  'router',
  'workflow',
  'rulebook',
  'facet',
  'provider',
  'verification',
  'artifact',
  'orchestrator',
] as const;

export type V5SkillKind = (typeof V5_SKILL_KINDS)[number];

export const V5_SOURCE_TYPES = [
  'official-docs',
  'spec',
  'reference-implementation',
  'community-pattern',
] as const;

export type V5SourceType = (typeof V5_SOURCE_TYPES)[number];
export type V5SourceFreshness = 'fresh' | 'stale';

export const V5_SELECTION_MODES = ['conditional', 'universal'] as const;
export type V5SelectionMode = (typeof V5_SELECTION_MODES)[number];

export const V5_INVOCATION_MODES = ['model-invoked', 'user-invoked'] as const;
export type V5InvocationMode = (typeof V5_INVOCATION_MODES)[number];

/** Runtime control skills live alongside the V5 library but are not packages:
 *  the host injects them itself (critic auto-selection, critic review), so the
 *  package catalog, its audits, and its routing gates count exactly the
 *  authored packages and never these two. They still validate with the same
 *  sidecar schema and stay active in listSkills(). */
export const RUNTIME_CONTROL_SKILL_NAMES = [
  'critic-auto-selection',
  'critic-review',
] as const;

export function isRuntimeControlSkillName(name: string): boolean {
  return (RUNTIME_CONTROL_SKILL_NAMES as readonly string[]).includes(name);
}

export const V5_ROUTING_CATEGORIES = ['positive', 'negative', 'ambiguous', 'adversarial'] as const;

export type V5RoutingCategory = (typeof V5_ROUTING_CATEGORIES)[number];

export const V5_EVAL_ENVIRONMENT_KINDS = [
  'synthetic',
  'repository',
  'cli',
  'browser',
  'public-web',
  'device',
] as const;

export type V5EvalEnvironmentKind = (typeof V5_EVAL_ENVIRONMENT_KINDS)[number];

export const V5_EVAL_SCORER_KINDS = ['deterministic', 'blind-semantic'] as const;
export type V5EvalScorerKind = (typeof V5_EVAL_SCORER_KINDS)[number];

export interface V5SkillSourceRecord {
  url: string;
  sourceType: V5SourceType;
  versionScope: string;
  revision?: string;
  verifiedAt: string;
  staleAfterDays: number;
  license?: string;
  notes?: string;
}

export interface V5RoutingCase {
  id: string;
  prompt: string;
  expectedSelection: boolean;
  /** Bundle presence by default; direct tests ownership without forbidding inherited guidance. */
  selectionScope?: 'direct' | 'bundle';
  expectedSkills: string[];
  forbiddenSkills: string[];
  adjacentSkills: string[];
  tags: string[];
}

export interface V5HeldOutRoutingCase extends V5RoutingCase {
  category: V5RoutingCategory;
}

export interface V5EvalEnvironment {
  kind: V5EvalEnvironmentKind;
  startingState: string;
  requirements: string[];
}

export interface V5EvalScorer {
  id: string;
  kind: V5EvalScorerKind;
  weight: number;
  evidence: string[];
  blindTo?: string[];
}

export interface V5FullTaskFixture {
  id: string;
  maturity: 'scaffold' | 'individual';
  prompt: string;
  environment: V5EvalEnvironment;
  falsifiableChecks: Array<{
    id: string;
    assertion: string;
    source?: string;
  }>;
  scorers: V5EvalScorer[];
  requiredEvidence: string[];
  requiredArtifacts: string[];
}

export interface V5SkillPackageSidecar {
  schemaVersion: 1;
  name: string;
  version: string;
  /** How deliberately the package itself was authored. Qualification is tracked only in the audit/evaluation ledger. */
  authoringMaturity: 'scaffold' | 'individual';
  skillKind: V5SkillKind;
  selectionMode: V5SelectionMode;
  invocationMode: V5InvocationMode;
  domains: string[];
  targetMedia: string[];
  pathScopes: string[];
  contextBudget: number;
  broader: string[];
  facets: string[];
  requires: string[];
  conflicts: string[];
  activation: string[];
  excludes: string[];
  evidence: string[];
  routing: {
    positive: string[];
    negative: string[];
    ambiguous: V5RoutingCase[];
    adversarial: V5RoutingCase[];
  };
  sources: V5SkillSourceRecord[];
}

export interface V5CompiledSkillDefinition {
  name: string;
  description: string;
  domains: string[];
  media: string[];
  instructions: string;
  should: string[];
  shouldNot: string[];
  evidence: string[];
  broader: string[];
  facets: string[];
  requires: string[];
  conflicts: string[];
  activation: string[];
  excludes: string[];
}

export interface V5CompiledSkillPackage {
  directory: string;
  sourcePath: string;
  sidecarPath: string;
  sourceContent: string;
  instructions: string;
  sidecar: V5SkillPackageSidecar;
  supportingResources: string[];
  evaluation: {
    routing: V5HeldOutRoutingCase[];
    tasks: V5FullTaskFixture[];
  };
  definition: V5CompiledSkillDefinition;
}

export interface V5SkillPackageValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  package?: V5CompiledSkillPackage;
}

export interface V5SkillPackageCatalog {
  root: string;
  /** The authored V5 packages: counts, audits, and routing gates cover exactly
   *  these. Runtime control skills are deliberately not here. */
  packages: V5CompiledSkillPackage[];
  /** Host-owned runtime control skills (critic auto-selection, critic review).
   *  They validate with the same sidecar schema and their content still feeds
   *  the deployed definition overlay and eval contracts — they only stay out
   *  of the package inventory, its audits, and its routing gates. */
  runtimeControls: V5CompiledSkillPackage[];
  errors: string[];
  warnings: string[];
}

/**
 * Public terminology aliases for the one bundled Skills catalog. These exact
 * bare names are reserved for Kory's bundled catalog; callers with a custom
 * root should pass its path explicitly, preferably as an absolute path when
 * its name could collide with a reserved alias.
 *
 * The compatibility names intentionally resolve to the V5 directory rather
 * than creating a second tree. Keep `skills-v5` as the canonical on-disk name
 * because existing commands, exports, and evidence refer to it.
 */
export const SKILLS_PACKAGE_ROOT_ALIASES = {
  skills: 'skills-v5',
  'skills-v1': 'skills-v5',
  'skills-v5': 'skills-v5',
} as const;

export type SkillsPackageRootAlias = keyof typeof SKILLS_PACKAGE_ROOT_ALIASES;

const sourceSchema = z
  .object({
    url: z.string().url(),
    sourceType: z.enum(V5_SOURCE_TYPES),
    versionScope: z.string().trim().min(1).max(300),
    revision: z.string().trim().min(1).max(200).optional(),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    staleAfterDays: z.number().int().min(1).max(3650),
    license: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const routingCaseSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,95}$/),
    prompt: z.string().trim().min(1).max(10_000),
    expectedSelection: z.boolean(),
    selectionScope: z.enum(['direct', 'bundle']).optional(),
    expectedSkills: z.array(z.string().trim().min(1)).max(30).default([]),
    forbiddenSkills: z.array(z.string().trim().min(1)).max(30).default([]),
    adjacentSkills: z.array(z.string().trim().min(1)).max(20).default([]),
    tags: z.array(z.string().trim().min(1)).max(20).default([]),
  })
  .strict();

const heldOutRoutingCaseSchema = routingCaseSchema.extend({
  category: z.enum(V5_ROUTING_CATEGORIES),
});

const evalEnvironmentSchema = z
  .object({
    kind: z.enum(V5_EVAL_ENVIRONMENT_KINDS),
    startingState: z.string().trim().min(1).max(1000),
    requirements: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  })
  .strict();

const evalScorerSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,95}$/),
    kind: z.enum(V5_EVAL_SCORER_KINDS),
    weight: z.number().positive().max(1),
    evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    blindTo: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  })
  .strict();

const fullTaskFixtureSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,95}$/),
    maturity: z.enum(['scaffold', 'individual']).default('individual'),
    prompt: z.string().trim().min(1).max(20_000),
    environment: evalEnvironmentSchema,
    falsifiableChecks: z
      .array(
        z
          .object({
            id: z
              .string()
              .trim()
              .regex(/^[a-z0-9][a-z0-9-]{1,95}$/),
            assertion: z.string().trim().min(1).max(1_000),
            source: z.string().url().optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    scorers: z.array(evalScorerSchema).min(1).max(20),
    requiredEvidence: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
    requiredArtifacts: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict();

const sidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    authoringMaturity: z.enum(['scaffold', 'individual']).default('individual'),
    skillKind: z.enum(V5_SKILL_KINDS),
    selectionMode: z.enum(V5_SELECTION_MODES).default('conditional'),
    invocationMode: z.enum(V5_INVOCATION_MODES).default('model-invoked'),
    domains: z.array(z.string().trim().min(1)).min(1).max(30),
    targetMedia: z.array(z.string().trim().min(1)).min(1).max(20),
    pathScopes: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
    contextBudget: z.number().int().min(500).max(50_000),
    broader: z.array(z.string().trim().min(1)).max(20).default([]),
    facets: z.array(z.string().trim().min(1)).max(20).default([]),
    requires: z.array(z.string().trim().min(1)).max(20).default([]),
    conflicts: z.array(z.string().trim().min(1)).max(20).default([]),
    activation: z.array(z.string().trim().min(1)).max(30).default([]),
    excludes: z.array(z.string().trim().min(1)).max(30).default([]),
    evidence: z.array(z.string().trim().min(1)).min(1).max(30),
    routing: z
      .object({
        positive: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100),
        negative: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100),
        ambiguous: z.array(routingCaseSchema).max(100).default([]),
        adversarial: z.array(routingCaseSchema).max(100).default([]),
      })
      .strict(),
    sources: z.array(sourceSchema).min(1).max(100),
  })
  .strict();

const PORTABLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PACKAGE_RESOURCE_ROOTS = new Set(['references', 'scripts', 'assets', 'evals']);
const MAX_RESOURCE_COUNT = 256;
const MAX_RESOURCE_DEPTH = 4;

function parseJsonFile<T>(path: string, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `${label}: ${error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseRoutingJsonl(path: string): V5HeldOutRoutingCase[] {
  const source = readFileSync(path, 'utf8');
  const cases: V5HeldOutRoutingCase[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      cases.push(heldOutRoutingCaseSchema.parse(JSON.parse(line)));
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `evals/routing.jsonl line ${index + 1}: ${error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      throw new Error(
        `evals/routing.jsonl line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return cases;
}

function loadEvaluationFixtures(packageDirectory: string): {
  routing: V5HeldOutRoutingCase[];
  tasks: V5FullTaskFixture[];
  errors: string[];
} {
  const errors: string[] = [];
  const routingPath = join(packageDirectory, 'evals', 'routing.jsonl');
  let routing: V5HeldOutRoutingCase[] = [];
  if (!existsSync(routingPath)) {
    errors.push('evals/routing.jsonl is required for a V5 package');
  } else {
    try {
      routing = parseRoutingJsonl(routingPath);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const tasksDirectory = join(packageDirectory, 'evals', 'tasks');
  const tasks: V5FullTaskFixture[] = [];
  if (!existsSync(tasksDirectory)) {
    errors.push('evals/tasks is required for a V5 package');
  } else {
    for (const entry of readdirSync(tasksDirectory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        tasks.push(
          parseJsonFile(
            join(tasksDirectory, entry.name),
            fullTaskFixtureSchema,
            `evals/tasks/${entry.name}`,
          ),
        );
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { routing, tasks, errors };
}

function parsePortableScalar(frontmatter: string, key: string): string {
  const raw = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  if (!raw) return '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed : raw;
    } catch {
      return raw;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function parsePortableSkillSource(sourceContent: string): {
  name: string;
  description: string;
  instructions: string;
} {
  const match = sourceContent.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md must contain YAML frontmatter delimited by ---');
  return {
    name: parsePortableScalar(match[1], 'name'),
    description: parsePortableScalar(match[1], 'description'),
    instructions: match[2].trim(),
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function collectSupportingResources(packageDirectory: string): {
  files: string[];
  errors: string[];
} {
  const files: string[] = [];
  const errors: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (files.length >= MAX_RESOURCE_COUNT) {
      errors.push(`Package exceeds ${MAX_RESOURCE_COUNT} supporting resources`);
      return;
    }
    if (depth > MAX_RESOURCE_DEPTH) {
      errors.push(`Package resources exceed maximum depth ${MAX_RESOURCE_DEPTH}`);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        errors.push(
          `Supporting resource must not be a symlink: ${relative(packageDirectory, path)}`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        errors.push(
          `Supporting resource must be a regular file: ${relative(packageDirectory, path)}`,
        );
        continue;
      }
      if (!isPathInside(packageDirectory, path)) {
        errors.push(`Supporting resource escapes package directory: ${path}`);
        continue;
      }
      files.push(relative(packageDirectory, path).split(sep).join('/'));
    }
  };

  for (const root of PACKAGE_RESOURCE_ROOTS) {
    const directory = join(packageDirectory, root);
    if (existsSync(directory)) walk(directory, 1);
  }
  return { files: files.sort(), errors };
}

function duplicateErrors(label: string, values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].map((value) => `${label} contains duplicate ${value}`);
}

export function sourceFreshness(source: V5SkillSourceRecord, now = new Date()): V5SourceFreshness {
  const verified = new Date(`${source.verifiedAt}T00:00:00.000Z`);
  if (Number.isNaN(verified.getTime())) return 'stale';
  return now.getTime() - verified.getTime() > source.staleAfterDays * 86_400_000
    ? 'stale'
    : 'fresh';
}

export function validateV5SkillPackage(
  packageDirectory: string,
  options: { now?: Date } = {},
): V5SkillPackageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const directory = resolve(packageDirectory);
  const sourcePath = join(directory, 'SKILL.md');
  const sidecarPath = join(directory, 'kory.json');
  if (!existsSync(sourcePath)) errors.push('SKILL.md is required');
  if (!existsSync(sidecarPath)) errors.push('kory.json is required');
  if (errors.length) return { valid: false, errors, warnings };

  let sourceContent = '';
  let parsedPortable: ReturnType<typeof parsePortableSkillSource> | null = null;
  let sidecar: V5SkillPackageSidecar | null = null;
  try {
    const sourceStat = lstatSync(sourcePath);
    const sidecarStat = lstatSync(sidecarPath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      errors.push('SKILL.md must be a regular non-symlink file');
    }
    if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) {
      errors.push('kory.json must be a regular non-symlink file');
    }
    sourceContent = readFileSync(sourcePath, 'utf8');
    parsedPortable = parsePortableSkillSource(sourceContent);
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    sidecar = sidecarSchema.parse(JSON.parse(readFileSync(sidecarPath, 'utf8')));
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      errors.push(
        ...error.issues.map(
          (issue) => `kory.json ${issue.path.join('.') || '<root>'}: ${issue.message}`,
        ),
      );
    } else {
      errors.push(`kory.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!parsedPortable || !sidecar) return { valid: false, errors: [...new Set(errors)], warnings };

  const directoryName = basename(directory);
  if (!parsedPortable.name) errors.push('Agent Skills frontmatter name is required');
  if (!PORTABLE_NAME_PATTERN.test(parsedPortable.name) || parsedPortable.name.length > 64) {
    errors.push(
      'Agent Skills frontmatter name must be 1-64 lowercase letters, digits, and hyphens',
    );
  }
  if (parsedPortable.name !== directoryName) {
    errors.push(
      `Agent Skills frontmatter name ${parsedPortable.name} must match directory ${directoryName}`,
    );
  }
  if (sidecar.name !== directoryName) {
    errors.push(`kory.json name ${sidecar.name} must match directory ${directoryName}`);
  }
  if (parsedPortable.name !== sidecar.name) {
    errors.push('SKILL.md and kory.json names must match');
  }
  if (!parsedPortable.description || parsedPortable.description.length > 1024) {
    errors.push('Agent Skills description must be 1-1024 characters');
  }
  if (!parsedPortable.description.includes('Use when ')) {
    warnings.push('Description should state concrete trigger conditions using “Use when …”.');
  }
  if (!parsedPortable.instructions) errors.push('SKILL.md instructions are required');
  if (parsedPortable.instructions.length > 50_000) {
    errors.push('SKILL.md instructions must be at most 50000 characters');
  }

  errors.push(...duplicateErrors('domains', sidecar.domains));
  errors.push(...duplicateErrors('targetMedia', sidecar.targetMedia));
  errors.push(...duplicateErrors('pathScopes', sidecar.pathScopes));
  errors.push(...duplicateErrors('broader', sidecar.broader));
  errors.push(...duplicateErrors('facets', sidecar.facets));
  errors.push(...duplicateErrors('requires', sidecar.requires));
  errors.push(...duplicateErrors('conflicts', sidecar.conflicts));
  errors.push(...duplicateErrors('activation', sidecar.activation));
  errors.push(...duplicateErrors('excludes', sidecar.excludes));
  errors.push(...duplicateErrors('routing.positive', sidecar.routing.positive));
  errors.push(...duplicateErrors('routing.negative', sidecar.routing.negative));

  if (sidecar.routing.positive.length < 5) {
    errors.push('V5 packages require at least 5 realistic positive routing cases');
  }
  if (sidecar.routing.negative.length < 5) {
    errors.push('V5 packages require at least 5 realistic near-neighbor negative routing cases');
  }
  if (sidecar.routing.ambiguous.length < 3) {
    errors.push('V5 packages require at least 3 ambiguous or compound routing cases');
  }
  if (sidecar.routing.adversarial.length < 3) {
    errors.push('V5 packages require at least 3 adversarial or negated routing cases');
  }
  if (
    sidecar.selectionMode === 'conditional' &&
    sidecar.routing.ambiguous.some((item) => !item.expectedSelection)
  ) {
    warnings.push('Ambiguous routing cases normally exercise a positive but confusable selection.');
  }
  if (
    sidecar.selectionMode === 'conditional' &&
    sidecar.routing.adversarial.some((item) => item.expectedSelection)
  ) {
    warnings.push('Adversarial routing cases normally exercise a tempting false positive.');
  }
  if (sidecar.selectionMode === 'universal' && sidecar.skillKind !== 'router') {
    errors.push('Only router skills may declare universal selectionMode');
  }
  if (sidecar.selectionMode === 'universal' && sidecar.invocationMode === 'user-invoked') {
    errors.push('Universal router skills cannot be user-invoked only');
  }
  for (const scope of sidecar.pathScopes) {
    if (scope.startsWith('/') || scope.startsWith('~') || scope.includes('..')) {
      errors.push(`pathScopes must be repository-relative and must not traverse parents: ${scope}`);
    }
  }

  const authoritativeSources = sidecar.sources.filter(
    (source) => source.sourceType !== 'community-pattern',
  );
  if (!authoritativeSources.length) {
    errors.push('V5 packages require at least one authoritative official/spec/reference source');
  }
  const now = options.now ?? new Date();
  for (const source of sidecar.sources) {
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(source.url);
    } catch {
      errors.push(`Source URL is invalid: ${source.url}`);
    }
    if (parsedUrl && parsedUrl.protocol !== 'https:') {
      errors.push(`Source URL must use https: ${source.url}`);
    }
    const verified = new Date(`${source.verifiedAt}T00:00:00.000Z`);
    if (verified.getTime() > now.getTime() + 86_400_000) {
      errors.push(`Source verifiedAt is in the future: ${source.url}`);
    }
    if (sourceFreshness(source, now) === 'stale') {
      warnings.push(`Source is stale under its declared policy: ${source.url}`);
    }
  }

  const resources = collectSupportingResources(directory);
  errors.push(...resources.errors);

  const evaluation = loadEvaluationFixtures(directory);
  errors.push(...evaluation.errors);
  if (!evaluation.errors.length) {
    const routingCounts = Object.fromEntries(
      V5_ROUTING_CATEGORIES.map((category) => [
        category,
        evaluation.routing.filter((item) => item.category === category).length,
      ]),
    ) as Record<V5RoutingCategory, number>;
    if (routingCounts.positive < 5) {
      errors.push('Held-out V5 routing suite requires at least 5 positive cases');
    }
    if (routingCounts.negative < 5) {
      errors.push('Held-out V5 routing suite requires at least 5 negative cases');
    }
    if (routingCounts.ambiguous < 3) {
      errors.push('Held-out V5 routing suite requires at least 3 ambiguous cases');
    }
    if (routingCounts.adversarial < 3) {
      errors.push('Held-out V5 routing suite requires at least 3 adversarial cases');
    }
    const routingIds = evaluation.routing.map((item) => item.id);
    errors.push(...duplicateErrors('evals/routing.jsonl ids', routingIds));
    errors.push(
      ...duplicateErrors(
        'evals/routing.jsonl prompts',
        evaluation.routing.map((item) => item.prompt),
      ),
    );
    const publicRoutingPrompts = new Set([
      ...sidecar.routing.positive,
      ...sidecar.routing.negative,
      ...sidecar.routing.ambiguous.map((item) => item.prompt),
      ...sidecar.routing.adversarial.map((item) => item.prompt),
    ]);
    const leakedHeldOutPrompts = evaluation.routing
      .filter((item) => publicRoutingPrompts.has(item.prompt))
      .map((item) => item.id);
    if (leakedHeldOutPrompts.length) {
      errors.push(
        `Held-out routing cases duplicate public package fixtures: ${leakedHeldOutPrompts.join(', ')}`,
      );
    }
    for (const item of evaluation.routing) {
      if (sidecar.selectionMode === 'universal') {
        if (!item.expectedSelection) {
          errors.push(`${item.id} must expect a universal router skill to remain selected`);
        }
        if (!item.expectedSkills.length && !item.forbiddenSkills.length) {
          errors.push(
            `${item.id} must assert expectedSkills or forbiddenSkills for universal routing`,
          );
        }
        if (
          (item.category === 'positive' || item.category === 'ambiguous') &&
          !item.expectedSkills.length
        ) {
          errors.push(`${item.id} requires expectedSkills for ${item.category} universal routing`);
        }
        if (
          (item.category === 'negative' || item.category === 'adversarial') &&
          !item.forbiddenSkills.length
        ) {
          errors.push(`${item.id} requires forbiddenSkills for ${item.category} universal routing`);
        }
      } else if (item.category === 'positive' || item.category === 'ambiguous') {
        if (!item.expectedSelection) {
          errors.push(`${item.id} must expect the skill to be selected for ${item.category}`);
        }
      } else if (item.expectedSelection) {
        errors.push(`${item.id} must expect the skill not to be selected for ${item.category}`);
      }
    }

    if (evaluation.tasks.length < 2) {
      errors.push('V5 packages require at least 2 realistic full-task evaluation scenarios');
    }
    errors.push(
      ...duplicateErrors(
        'eval task ids',
        evaluation.tasks.map((item) => item.id),
      ),
    );
    for (const task of evaluation.tasks) {
      const scorerWeight = task.scorers.reduce((sum, scorer) => sum + scorer.weight, 0);
      if (Math.abs(scorerWeight - 1) > 0.000_001) {
        errors.push(`${task.id} scorer weights must sum to 1`);
      }
      if (!task.scorers.some((scorer) => scorer.kind === 'deterministic')) {
        errors.push(`${task.id} requires at least one deterministic scorer`);
      }
      for (const scorer of task.scorers.filter((item) => item.kind === 'blind-semantic')) {
        if (!scorer.blindTo?.includes('skill-variant')) {
          errors.push(
            `${task.id}/${scorer.id} blind semantic scorer must be blind to skill-variant`,
          );
        }
      }
    }
  }

  if (errors.length) {
    return { valid: false, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }

  const definition: V5CompiledSkillDefinition = {
    name: sidecar.name,
    description: parsedPortable.description,
    domains: [...sidecar.domains],
    media: [...sidecar.targetMedia],
    instructions: parsedPortable.instructions,
    should: [...sidecar.routing.positive],
    shouldNot: [...sidecar.routing.negative],
    evidence: [...sidecar.evidence],
    broader: [...sidecar.broader],
    facets: [...sidecar.facets],
    requires: [...sidecar.requires],
    conflicts: [...sidecar.conflicts],
    activation: [...sidecar.activation],
    excludes: [...sidecar.excludes],
  };

  return {
    valid: true,
    errors: [],
    warnings: [...new Set(warnings)],
    package: {
      directory,
      sourcePath,
      sidecarPath,
      sourceContent,
      instructions: parsedPortable.instructions,
      sidecar,
      supportingResources: resources.files,
      evaluation: {
        routing: evaluation.routing,
        tasks: evaluation.tasks,
      },
      definition,
    },
  };
}

export function bundledV5SkillsRoot(): string {
  const primary = join(PROJECT_ROOT, 'skills-v5');
  if (existsSync(primary)) return primary;
  const sourceRelative = join(import.meta.dir, '..', '..', '..', 'skills-v5');
  if (existsSync(sourceRelative)) return sourceRelative;
  return primary;
}

/**
 * Resolve a catalog path or a public terminology alias to the single V5 root.
 * Only the aliases' own properties are meaningful. Inherited names such as
 * `__proto__`, `constructor`, and `toString` remain ordinary custom paths.
 */
export function resolveSkillsPackageRoot(root: string = 'skills-v5'): string {
  if (Object.hasOwn(SKILLS_PACKAGE_ROOT_ALIASES, root)) {
    return resolve(bundledV5SkillsRoot());
  }
  return resolve(root);
}

export function loadV5SkillPackages(root = 'skills-v5'): V5SkillPackageCatalog {
  const resolvedRoot = resolveSkillsPackageRoot(root);
  if (!existsSync(resolvedRoot)) {
    return { root: resolvedRoot, packages: [], runtimeControls: [], errors: [], warnings: [] };
  }
  const packages: V5CompiledSkillPackage[] = [];
  const runtimeControls: V5CompiledSkillPackage[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(resolvedRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = join(resolvedRoot, entry.name);
    if (!existsSync(join(directory, 'SKILL.md')) && !existsSync(join(directory, 'kory.json')))
      continue;
    const validation = validateV5SkillPackage(directory);
    errors.push(...validation.errors.map((error) => `${entry.name}: ${error}`));
    warnings.push(...validation.warnings.map((warning) => `${entry.name}: ${warning}`));
    if (!validation.package) continue;
    // Runtime control skills validate with the same schema and their content
    // still feeds the deployed overlay, but they are host-owned: they never
    // enter the package graph, the audits, or the routing gates.
    if (!validation.package) continue;
    // Runtime control skills validate with the same schema and their content
    // still feeds the deployed overlay, but they are host-owned: they never
    // enter the package graph, the audits, or the routing gates.
    if (isRuntimeControlSkillName(validation.package.sidecar.name)) {
      runtimeControls.push(validation.package);
    } else {
      packages.push(validation.package);
    }
  }
  const byName = new Map(packages.map((skillPackage) => [skillPackage.sidecar.name, skillPackage]));
  // Validate the complete graph before any package can be used by the runtime or eval harness.
  // Per-package syntax validation cannot detect a missing parent or a cross-package cycle.
  for (const skillPackage of packages) {
    for (const kind of ['broader', 'facets', 'requires', 'conflicts'] as const) {
      for (const name of skillPackage.sidecar[kind]) {
        if (name === skillPackage.sidecar.name) errors.push(`${name}: self reference in ${kind}`);
        else if (!byName.has(name))
          errors.push(`${skillPackage.sidecar.name}: missing ${kind} skill ${name}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): void => {
    if (visiting.has(name)) {
      errors.push(
        `V5 composition cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    path.push(name);
    const sidecar = byName.get(name)?.sidecar;
    for (const relation of [...(sidecar?.broader ?? []), ...(sidecar?.requires ?? [])]) {
      if (byName.has(relation)) visit(relation);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of byName.keys()) visit(name);
  for (const skillPackage of packages) {
    for (const relation of [
      ...skillPackage.sidecar.broader,
      ...skillPackage.sidecar.facets,
      ...skillPackage.sidecar.requires,
    ]) {
      const dependency = byName.get(relation);
      if (dependency?.sidecar.invocationMode === 'user-invoked') {
        errors.push(
          `${skillPackage.sidecar.name}: ${skillPackage.sidecar.invocationMode} composition cannot implicitly depend on user-invoked skill ${relation}`,
        );
      }
    }
  }
  return {
    root: resolvedRoot,
    packages,
    runtimeControls,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}
