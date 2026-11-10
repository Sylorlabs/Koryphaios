import { resolve } from 'node:path';
import { listSkills } from '../backend/src/kory/skills';
const root = resolve(import.meta.dir, '..');
for (const s of listSkills(root).filter(s=>['api-contract-design','grpc-protobuf','http-rest-engineering'].includes(s.name))) {
  console.log(s.name, 'state=',s.state, 'valid=',s.validation.valid, 'hash=',s.hash.slice(0,8), JSON.stringify(s.validation).slice(0,300));
}
