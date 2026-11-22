import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { listSkills } from '../../backend/src/kory/skills';
const name = process.argv[2];
const root = process.cwd();
const skill = listSkills(root).find((s) => s.name === name && s.state === 'active');
if (!skill) throw new Error('not found');
const sidecar = readFileSync(`skills-v5/${name}/kory.json`, 'utf8');
const src = readFileSync(`skills-v5/${name}/SKILL.md`, 'utf8');
const h = (v: string) => createHash('sha256').update(v).digest('hex');
console.log(JSON.stringify({
  name,
  revisionHash: skill.hash,
  sha_sidecar_src: h(sidecar + '\n' + src),
  sha_sidecarOnly: h(sidecar),
  sha_srcOnly: h(src),
}, null, 2));
