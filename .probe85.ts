import { resolve } from 'node:path';
import { loadV5SkillPackages } from './backend/src/kory/skill-packages';
const root = resolve(import.meta.dir);
for (const p of loadV5SkillPackages().packages) if (p.sidecar.name === 'ios-swiftui') console.log(p.sidecar.revisionHash, Object.keys(p.sidecar).slice(0,8));
