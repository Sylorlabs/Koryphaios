import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS } from '../skill-eval-edge-observability-fixtures';

test('observability sampling fixture declares its simulator and replay corpus as fixed inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-observability-fixture-'));
  try {
    const scenario = { id: 'observability-sre-full-task-2' } as never;
    const materializer = EDGE_OBSERVABILITY_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    );
    expect(materializer?.id).toBe('observability-sre/tail-sampling-cardinality@2');
    await materializer!.materialize(root, scenario);
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('src/observability-sim.ts');
    expect(readme).toContain('evidence/replay.json');
    expect(readme).toContain('fixed evaluator-owned inputs');
    expect(readme).toContain('Do not edit, replace, or regenerate them');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
