/**
 * Propose (draft) new personal-library revisions for the V5 skills whose
 * promotion evidence requires a fresh revision, by publishing the current
 * `skills-v5/` package instructions through the sanctioned backend draft API
 * (`saveSkillDocumentDraft`). Activation stays with the human: the project runs
 * `skillLearningMode: 'propose-then-verify'`, and this script deliberately never
 * activates.
 *
 * Usage: bun scripts/propose-v5-skill-revisions.ts <skill> [skill...]
 */
import { resolve } from 'node:path';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
import { listSkills, saveSkillDocumentDraft } from '../backend/src/kory/skills';

const projectRoot = resolve(import.meta.dir, '..');
const requested = process.argv.slice(2).filter(Boolean);
if (!requested.length) {
  console.error('usage: bun scripts/propose-v5-skill-revisions.ts <skill> [skill...]');
  process.exit(2);
}

const packages = loadV5SkillPackages(resolve(projectRoot, 'skills-v5')).packages;
const revisions = new Map(
  listSkills(projectRoot)
    .filter((skill) => skill.state === 'active' && skill.validation.valid)
    .map((skill) => [skill.name, skill]),
);

/**
 * The seeded runtime file is frontmatter + `# <name>` + the V5 package
 * instructions + the generated package-resource suffix. Recover the current
 * instructions span structurally so the replacement changes nothing else.
 */
function replacePackageInstructions(
  sourceContent: string,
  name: string,
  pkg: { instructions: string; directory: string; supportingResources: readonly unknown[] },
): string {
  const body = sourceContent.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const prefix = `# ${name}\n\n`;
  if (!body.startsWith(prefix)) {
    throw new Error(`${name} runtime body does not start with its generated heading`);
  }
  const suffix = pkg.supportingResources.length
    ? `\n\n## Kory package resources\n\nRoot: ${JSON.stringify(pkg.directory)}. Resolve links there; read selectively. The presence of scripts or other files does not grant execution authority.`
    : '';
  const tail = `${suffix}\n`;
  if (!body.endsWith(tail)) {
    throw new Error(`${name} runtime body does not end with its generated package-resource suffix`);
  }
  const span = body.slice(prefix.length, body.length - tail.length);
  if (span.trim() !== pkg.instructions.trim()) {
    throw new Error(`${name} runtime instructions span differs from the loaded V5 package instructions`);
  }
  return sourceContent.replace(span, pkg.instructions.trim());
}

const results: Array<{ skill: string; ok: boolean; detail: string; draftHash?: string }> = [];
for (const name of requested) {
  try {
    const pkg = packages.find((item) => item.sidecar.name === name);
    const current = revisions.get(name);
    if (!pkg) throw new Error(`unknown V5 package ${name}`);
    if (!current) throw new Error(`${name} has no active valid runtime revision`);

    const nextSourceContent = replacePackageInstructions(
      current.sourceContent,
      name,
      pkg as unknown as { instructions: string; directory: string; supportingResources: readonly unknown[] },
    );
    if (nextSourceContent === current.sourceContent) {
      throw new Error(`${name} runtime content did not change; package instructions already current`);
    }

    const draft = saveSkillDocumentDraft(projectRoot, 'personal', name, {
      document: { kind: 'markdown', extension: 'md', renderer: 'markdown', mediaType: 'text/markdown' },
      sourceContent: nextSourceContent,
      coreInstructions: pkg.instructions.trim(),
      expectedHash: current.hash,
    });
    results.push({ skill: name, ok: true, detail: 'draft saved', draftHash: draft.hash });
  } catch (error: unknown) {
    results.push({ skill: name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}
console.log(JSON.stringify(results, null, 2));
