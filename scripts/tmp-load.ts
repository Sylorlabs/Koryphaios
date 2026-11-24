import { resolve } from 'node:path';
import { loadV5SkillPackages } from '../backend/src/kory/skill-packages';
const root = resolve(import.meta.dir, '..');
const r = loadV5SkillPackages(resolve(root, 'skills-v5'));
const names = new Set(r.packages.map((p) => p.sidecar.name));
console.log(
  'packages',
  r.packages.length,
  'has api-contract-design:',
  names.has('api-contract-design'),
  'has grpc:',
  names.has('grpc-protobuf'),
);
console.log('errors:', JSON.stringify((r as any).errors ?? []).slice(0, 500));
