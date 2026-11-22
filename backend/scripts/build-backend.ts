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

// The packaged backend must ship the Kory MCP bridge as a runnable sibling of
// server.js: CLI providers resolve it from import.meta.dir, which is build/ in
// the bundle, and fail closed when it is absent.
for (const name of ['kory-mcp-bridge', 'kory-hook-bridge'] as const) {
  const bridgeResult = await Bun.build({
    entrypoints: [resolve(import.meta.dir, `../src/providers/${name}.ts`)],
    outdir: resolve(import.meta.dir, '../build'),
    target: 'bun',
    naming: `${name}.js`,
  });
  if (!bridgeResult.success)
    throw new AggregateError(bridgeResult.logs, `${name} build failed`);
  for (const output of bridgeResult.outputs)
    console.log(`Built ${output.path} (${output.size} bytes)`);
}
