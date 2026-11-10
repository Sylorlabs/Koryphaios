import { resolve } from 'node:path';
import { currentV5SkillEvaluationContractsPlugin } from './build-current-v5-contracts';

// Keep the production recipe's entry, target, and output layout unchanged.
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../src/server.ts')],
  outdir: resolve(import.meta.dir, '../build'),
  target: 'bun',
  plugins: [currentV5SkillEvaluationContractsPlugin()],
});
if (!result.success) throw new AggregateError(result.logs, 'Backend build failed');
for (const output of result.outputs) console.log(`Built ${output.path} (${output.size} bytes)`);
