#!/usr/bin/env bun
/**
 * Record independent provenance for the research full-task scenarios.
 *
 * Readiness for `research` is synchronous, but independent provenance is a network
 * observation: a CDX replay compared byte for byte with the local snapshot, or a
 * pinned Git blob compared with the API's own blob SHA. This script performs that
 * observation and persists it, which is the only way readiness can become green.
 *
 * It never writes a record for a corpus that failed verification, and it never
 * accepts a locally consistent manifest in place of the independent check.
 *
 *   bun run --no-env-file scripts/record-research-history-verification.ts [--scenario=<id>] [--corpus-root=<path>]
 */
import { resolve } from 'node:path';
import {
  RESEARCH_HISTORY_CASES,
  recordResearchHistoryVerification,
  researchHistoryLocalBlockers,
} from '../backend/src/eval/skills/skill-eval-research-history-runtime';

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--scenario='))?.split('=')[1];
const corpusRoot = resolve(
  args.find((arg) => arg.startsWith('--corpus-root='))?.split('=')[1] ??
    'backend/src/kory/__fixtures__/research-history',
);

const results: string[] = [];
for (const researchCase of RESEARCH_HISTORY_CASES) {
  if (only && researchCase.scenarioId !== only) continue;
  const scenario = {
    id: researchCase.scenarioId,
    skill: 'research',
    category: 'full-task',
    environment: {
      kind: 'synthetic',
      startingState: researchCase.startingState,
      requirements: [...researchCase.requiredEnvironment],
    },
  } as never;
  const structural = researchHistoryLocalBlockers(scenario, corpusRoot);
  if (structural.length) {
    results.push(`- ${researchCase.scenarioId}: corpus incomplete (${structural.join('; ')})`);
    continue;
  }
  const recorded = await recordResearchHistoryVerification(scenario, { corpusRoot });
  results.push(recorded.verified
    ? `- ${researchCase.scenarioId}: provenance recorded at ${recorded.path}`
    : `- ${researchCase.scenarioId}: provenance NOT recorded (${recorded.blockers.join('; ')})`);
}

console.log(JSON.stringify({
  corpusRoot,
  results,
  note: 'A record is written only after an independent archive or Git comparison succeeded.',
}, null, 2));
