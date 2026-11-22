import { listSkills } from '../../backend/src/kory/skills';
for (const s of listSkills(process.cwd())) {
  if (s.name.startsWith('critic-')) {
    console.log(s.name, s.source, s.hash.slice(0, 12), 'valid=' + s.validation.valid, s.validation.errors.slice(0, 2).join('|'));
  }
}
