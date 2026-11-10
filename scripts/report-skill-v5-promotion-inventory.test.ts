import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inventoryRows,
  missingGateLabels,
  renderInventory,
  runInventoryAudit,
  type PromotionInventoryRow,
} from './report-skill-v5-promotion-inventory';

const row = (skill: string): PromotionInventoryRow => ({
  skill,
  packageVersion: '5.1.0',
  revisionHash: 'revision',
  execution: { readyScenarios: 2, blockedScenarios: 0, blockers: [] },
  promotion: {
    status: 'ready',
    routingPrecision: 1,
    routingRecall: 1,
    fullTaskCoverage: 2,
    pairedFullTaskBaselines: 2,
    provenancedBlindReviews: 1,
    openRegressions: 0,
    reasons: [],
  },
});

test('audit children cannot acquire implicit dotenv authority or hide failed gate exits', () => {
  const root = mkdtempSync(join(tmpdir(), 'kory-inventory-audit-'));
  const key = `KORY_INVENTORY_DOTENV_${process.pid}`;
  try {
    expect(process.env[key]).toBeUndefined();
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, '.env'), `${key}=implicit-dotenv\n`);
    writeFileSync(join(root, 'scripts', 'fixture.ts'), `
      console.log(JSON.stringify({ dotenvLoaded: process.env[${JSON.stringify(key)}] !== undefined }));
      process.exitCode = Number(process.argv[2]);
    `);
    for (const exitCode of [0, 1]) {
      expect(runInventoryAudit(root, 'fixture.ts', [String(exitCode)])).toEqual({
        exitCode,
        report: { dotenvLoaded: false },
      });
    }
    expect(() => runInventoryAudit(root, 'fixture.ts', ['2'])).toThrow('did not complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ready rows are preserved, not counted as missing blind evidence', () => {
  expect(missingGateLabels(row('ready'))).toEqual([]);
});

test('failed reviews and blocked environments remain explicit despite coverage', () => {
  const failed = row('failed');
  failed.promotion!.status = 'blocked';
  failed.promotion!.reasons = ['1 active provenanced blind review(s) failed semantic evaluation.'];
  failed.execution.blockedScenarios = 1;
  expect(missingGateLabels(failed)).toEqual([
    'independent blind review',
    'native/external environment',
  ]);
});

test('unmeasured rows enumerate missing empirical gates and review-only rows sort first', () => {
  const unknown = row('unknown');
  Object.assign(unknown.promotion!, {
    status: 'unmeasured',
    routingPrecision: null,
    routingRecall: null,
    fullTaskCoverage: 0,
    pairedFullTaskBaselines: 0,
    provenancedBlindReviews: 0,
  });
  expect(missingGateLabels(unknown)).toEqual([
    'routing',
    'scenario execution evidence',
    'paired full-task evidence',
    'independent blind review',
  ]);
  const review = row('review');
  review.promotion!.status = 'insufficient-evidence';
  review.promotion!.provenancedBlindReviews = 0;
  expect(inventoryRows([row('ready'), unknown, review]).map((item) => item.skill)).toEqual([
    'review',
    'unknown',
    'ready',
  ]);
});

test('reports retain exact reasons, escape cells, and reject duplicate inventory entries', () => {
  const item = row('example');
  item.promotion!.reasons = ['Observed "failure", not a pass | retry\nunverified'];
  const result = renderInventory([item]);
  expect(result.csv).toContain('Observed ""failure"", not a pass | retry\nunverified');
  expect(result.markdown).toContain('pass \\| retry unverified');
  expect(() => inventoryRows([item, item])).toThrow('Duplicate skill');
});
