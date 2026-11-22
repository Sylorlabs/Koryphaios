#!/usr/bin/env bun
/**
 * Regenerates .kory-eval/boot-evidence.json from the supplied corpus and the
 * policy artifact, driving the unmodified simulator in src/device-sim.ts.
 *
 * Exits non-zero if any invariant fails, so a broken policy can never produce
 * evidence that looks green.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvidence,
  loadBootConfig,
  loadCorpus,
  REPO_ROOT,
  serialiseEvidence,
} from './evidence-lib.ts';

const corpus = loadCorpus();
const config = loadBootConfig();
const evidence = buildEvidence(config, corpus);

const failed = evidence.invariants.filter((invariant) => !invariant.holds);
if (failed.length > 0) {
  console.error(`FAIL: ${failed.length} invariant(s) do not hold:`);
  for (const invariant of failed) {
    console.error(`  - [${invariant.id}] ${invariant.statement} (${invariant.detail})`);
  }
  process.exit(1);
}

const outPath = join(REPO_ROOT, '.kory-eval/boot-evidence.json');
mkdirSync(join(REPO_ROOT, '.kory-eval'), { recursive: true });
writeFileSync(outPath, serialiseEvidence(evidence));

const decisionCount = Object.keys(evidence.bootDecisions).length;
const cutCount = Object.values(evidence.powerCutRecovery).reduce(
  (total, perStep) => total + Object.keys(perStep).length,
  0,
);
console.log(`wrote ${outPath}`);
console.log(`  board:            ${evidence.board}`);
console.log(`  boot decisions:   ${decisionCount} images`);
console.log(`  power-cut pairs:  ${cutCount} (candidate x step)`);
console.log(`  invariants:       ${evidence.invariants.length - failed.length}/${
  evidence.invariants.length
} hold`);
for (const invariant of evidence.invariants) {
  console.log(`  [${invariant.holds ? 'ok' : 'FAIL'}] ${invariant.id}: ${invariant.statement}`);
}
