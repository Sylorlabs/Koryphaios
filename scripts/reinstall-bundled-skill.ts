/**
 * Repair a stale personal skill copy by rewriting it from the bundled definition.
 *
 * The seeder protects edited copies, and a copy it left at an older bundled version looks identical to
 * an edit, so it never repairs itself. This drops the named skills back to their bundled definition and
 * prints the resulting revision hash, which is what a caller must check against the revision its
 * evidence was recorded under.
 *
 * Usage: bun run scripts/reinstall-bundled-skill.ts <skill> [<skill>...]
 */
import { resolve } from 'node:path';
import { reinstallBundledSkill } from '../backend/src/kory/skills';

const names = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
if (names.length === 0) throw new Error('Pass at least one bundled skill name');

for (const name of names) {
  const revision = reinstallBundledSkill(name);
  const validity = revision.validation.valid ? 'valid' : revision.validation.errors.join('; ');
  console.log(`${name} ${revision.hash.slice(0, 12)} ${validity} -> ${resolve(revision.path)}`);
}
