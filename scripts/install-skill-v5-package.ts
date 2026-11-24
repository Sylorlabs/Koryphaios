/**
 * Install an authored `skills-v5/<name>/` package into a skill store in the form the loader reads.
 *
 * The authoring package keeps its metadata in `kory.json` and leaves `SKILL.md` frontmatter at `name`
 * and `description`. The store only reads metadata out of the document frontmatter, so a plain copy is
 * an invalid skill (`metadata.koryphaios is required`) and hashes differently from what was measured.
 * This renders the installed document from the sidecar and then proves it through the product's own
 * validator before writing anything.
 *
 * Usage:
 *   bun run scripts/install-skill-v5-package.ts --skill=critic-review [--skill=...] [--root=project|personal] [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateSkillContent } from '../backend/src/kory/skills';
import { homedir } from 'node:os';

interface AuthoredSidecar {
  name: string;
  version: string;
  skillKind?: string;
  selectionMode?: string;
  invocationMode?: string;
  domains?: string[];
  targetMedia?: string[];
  pathScopes?: string[];
  contextBudget?: number;
  broader?: string[];
  facets?: string[];
  requires?: string[];
  conflicts?: string[];
  activation?: string[];
  excludes?: string[];
  evidence?: string[];
  routing?: { positive?: string[]; negative?: string[] };
}

const root = resolve(import.meta.dir, '..');
const argv = process.argv.slice(2);
const skills = argv
  .filter((argument) => argument.startsWith('--skill='))
  .map((argument) => argument.slice('--skill='.length).trim())
  .filter(Boolean);
const targetRoot =
  argv
    .find((argument) => argument.startsWith('--root='))
    ?.slice('--root='.length)
    .trim() ?? 'project';
const dryRun = argv.includes('--dry-run');
if (skills.length === 0) throw new Error('Pass at least one --skill=<name>');
if (targetRoot !== 'project' && targetRoot !== 'personal') {
  throw new Error('--root must be project or personal');
}

const storeRoot =
  targetRoot === 'project'
    ? join(root, '.koryphaios', 'skills')
    : join(homedir(), '.koryphaios', 'skills');

function yamlList(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return '[]';
  return `\n${values.map((value) => `      - ${JSON.stringify(value)}`).join('\n')}`;
}

function renderInstalledDocument(
  description: string,
  body: string,
  sidecar: AuthoredSidecar,
): string {
  const positive = sidecar.routing?.positive ?? [];
  const negative = sidecar.routing?.negative ?? [];
  const frontmatter = [
    '---',
    `name: ${sidecar.name}`,
    `description: ${description}`,
    'metadata:',
    '  koryphaios:',
    `    version: ${sidecar.version}`,
    `    baseVersion: ${sidecar.version}`,
    `    baseHash: `,
    `    skillKind: ${sidecar.skillKind ?? 'general'}`,
    `    selectionMode: ${sidecar.selectionMode ?? 'conditional'}`,
    `    invocationMode: ${sidecar.invocationMode ?? 'model-invoked'}`,
    '    depth: 0',
    `    broader:${yamlList(sidecar.broader)}`,
    `    facets:${yamlList(sidecar.facets)}`,
    `    requires:${yamlList(sidecar.requires)}`,
    `    conflicts:${yamlList(sidecar.conflicts)}`,
    `    activation:${yamlList(sidecar.activation)}`,
    `    excludes:${yamlList(sidecar.excludes)}`,
    `    pathScopes:${yamlList(sidecar.pathScopes)}`,
    `    domains:${yamlList(sidecar.domains)}`,
    `    targetMedia:${yamlList(sidecar.targetMedia)}`,
    `    shouldTrigger:${yamlList(positive)}`,
    `    shouldNotTrigger:${yamlList(negative)}`,
    `    evidence:${yamlList(sidecar.evidence)}`,
    `    contextBudget: ${sidecar.contextBudget ?? 4000}`,
    '    sourceScope: local-only',
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${body.trimStart()}`;
}

for (const skill of skills) {
  const packageDirectory = join(root, 'skills-v5', skill);
  const skillPath = join(packageDirectory, 'SKILL.md');
  const sidecarPath = join(packageDirectory, 'kory.json');
  if (!existsSync(skillPath) || !existsSync(sidecarPath)) {
    throw new Error(`No authored package at ${packageDirectory}`);
  }
  const authored = readFileSync(skillPath, 'utf8');
  const match = authored.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${skill}: authored SKILL.md has no frontmatter`);
  const description = match[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description) throw new Error(`${skill}: authored SKILL.md has no description`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as AuthoredSidecar;
  if (sidecar.name !== skill) {
    throw new Error(`${skill}: kory.json names ${JSON.stringify(sidecar.name)}`);
  }
  const document = renderInstalledDocument(description, match[2]!, sidecar);
  const validation = validateSkillContent(document);
  if (!validation.valid) {
    throw new Error(`${skill}: rendered document is invalid: ${validation.errors.join('; ')}`);
  }
  const destination = join(storeRoot, skill);
  if (dryRun) {
    console.log(`[install] would write ${destination}/SKILL.md (${document.length} bytes, valid)`);
    continue;
  }
  mkdirSync(destination, { recursive: true });
  const staged = join(dirname(destination), `.${skill}.installing`);
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'SKILL.md'), document);
  for (const extra of ['references', 'evals']) {
    const from = join(packageDirectory, extra);
    if (existsSync(from)) cpSync(from, join(staged, extra), { recursive: true });
  }
  // Replace in two steps so a failure cannot leave half a package behind.
  const retired = join(dirname(destination), `.${skill}.retired`);
  if (existsSync(retired)) cpSync(retired, retired, { recursive: true });
  if (existsSync(destination) && !existsSync(retired)) {
    renameSync(destination, retired);
  }
  renameSync(staged, destination);
  console.log(`[install] wrote ${destination}/SKILL.md (${document.length} bytes, valid)`);
}
