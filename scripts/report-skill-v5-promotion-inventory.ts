import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PromotionInventoryRow {
  skill: string;
  packageVersion: string;
  revisionHash: string | null;
  execution: {
    readyScenarios: number;
    blockedScenarios: number;
    blockers: Array<{ scenarioId: string; reasons: string[] }>;
  };
  promotion: {
    status: string;
    routingPrecision: number | null;
    routingRecall: number | null;
    fullTaskCoverage: number;
    pairedFullTaskBaselines: number;
    provenancedBlindReviews: number;
    openRegressions: number;
    reasons: string[];
  } | null;
}

export function missingGateLabels(row: PromotionInventoryRow): string[] {
  const gate = row.promotion;
  const labels = new Set<string>();
  if (!gate) return ['active revision unavailable'];
  if (
    gate.routingPrecision === null ||
    gate.routingRecall === null ||
    gate.routingPrecision < 0.95 ||
    gate.routingRecall < 0.95
  )
    labels.add('routing');
  if (gate.fullTaskCoverage < 2) labels.add('scenario execution evidence');
  if (gate.pairedFullTaskBaselines < 2) labels.add('paired full-task evidence');
  if (gate.openRegressions) labels.add('regression');
  if (!gate.provenancedBlindReviews || gate.reasons.some((r) => /blind review/iu.test(r))) {
    labels.add('independent blind review');
  }
  if (row.execution.blockedScenarios) labels.add('native/external environment');
  for (const reason of gate.reasons) {
    if (/integrity/iu.test(reason)) labels.add('integrity');
    if (/regress.*baseline|measurable.*improvement|uplift/iu.test(reason))
      labels.add('paired uplift');
    if (/pass rate|verification score/iu.test(reason)) labels.add('measured outcome quality');
    if (/infrastructure/iu.test(reason)) labels.add('evaluation infrastructure');
    if (/coverage is missing|At least three/iu.test(reason)) labels.add('benchmark coverage');
    if (/contract/iu.test(reason)) labels.add('evaluation contract');
  }
  return [...labels];
}

function priority(row: PromotionInventoryRow): number {
  if (row.promotion?.status === 'ready' && !row.execution.blockedScenarios) return 4;
  if (row.execution.blockedScenarios) return 3;
  const labels = missingGateLabels(row);
  if (
    row.promotion?.status === 'insufficient-evidence' &&
    labels.length === 1 &&
    labels[0] === 'independent blind review'
  )
    return 0;
  return row.promotion?.openRegressions || row.promotion?.status === 'blocked' ? 1 : 2;
}

export function inventoryRows(rows: PromotionInventoryRow[]): PromotionInventoryRow[] {
  if (new Set(rows.map((row) => row.skill)).size !== rows.length) {
    throw new Error('Duplicate skill rows in qualification report');
  }
  return [...rows].sort((a, b) => priority(a) - priority(b) || a.skill.localeCompare(b.skill));
}

const csv = (value: unknown): string => `"${String(value ?? '').replaceAll('"', '""')}"`;
const md = (value: unknown): string =>
  String(value ?? 'unmeasured')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/gu, ' ');

export function renderInventory(rows: PromotionInventoryRow[]) {
  const header = [
    'Skill',
    'Version',
    'Promotion',
    'Missing gate categories',
    'Execution ready',
    'Full tasks',
    'Full-task pairs',
    'Blind reviews',
    'Open regressions',
    'Exact gate reasons',
    'Environment blockers',
    'Revision',
  ];
  const values = inventoryRows(rows).map((row) => {
    const gate = row.promotion;
    return [
      row.skill,
      row.packageVersion,
      gate?.status ?? 'unavailable',
      missingGateLabels(row).join('; ') || 'none reported',
      `${row.execution.readyScenarios}/${row.execution.readyScenarios + row.execution.blockedScenarios}`,
      gate?.fullTaskCoverage,
      gate?.pairedFullTaskBaselines,
      gate?.provenancedBlindReviews,
      gate?.openRegressions,
      gate?.reasons.join('; ') || 'none reported',
      row.execution.blockers.map((b) => `${b.scenarioId}: ${b.reasons.join('; ')}`).join('; '),
      row.revisionHash,
    ];
  });
  return {
    csv: [header, ...values].map((row) => row.map(csv).join(',')).join('\n') + '\n',
    markdown:
      [header, header.map(() => '---'), ...values]
        .map((row) => `| ${row.map(md).join(' | ')} |`)
        .join('\n') + '\n',
  };
}

export function runInventoryAudit(root: string, script: string, args: string[] = []) {
  // Keep the caller's environment authoritative; Bun children must not reload .env.
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', resolve(root, 'scripts', script), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(`${script} did not complete: ${result.stderr}`);
  }
  return { exitCode: result.status, report: JSON.parse(result.stdout) };
}

function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const ledgerPath = resolve(root, '.koryphaios/skills/evaluations.json');
  const digest = () => createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');
  // A concurrent campaign can append between the two digests. Retry the
  // qualification audit until the ledger is stable on both sides instead of
  // discarding a finished snapshot or presenting mixed state as consistent.
  let qualification: ReturnType<typeof runInventoryAudit> | undefined;
  let after = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = digest();
    qualification = runInventoryAudit(root, 'audit-skill-v5-qualification.ts');
    after = digest();
    if (after === before) break;
    if (attempt === 4) {
      throw new Error('Evaluation ledger changed during audit; rerun snapshot');
    }
    pauseSync(attempt * 1_500);
  }
  if (!qualification) throw new Error('Qualification inventory did not run');
  const quality = runInventoryAudit(root, 'audit-skill-v5-quality.ts', ['--summary']);
  const rows = qualification.report.rows as PromotionInventoryRow[];
  if (!Array.isArray(rows) || rows.length !== qualification.report.packages) {
    throw new Error('Incomplete qualification inventory');
  }
  const rendered = renderInventory(rows);
  const generatedAt = new Date().toISOString();
  const directory = resolve(root, 'outputs/skill-v5-promotion');
  mkdirSync(directory, { recursive: true });
  const prefix = [
    '# V5 current-revision promotion inventory',
    '',
    `Generated: ${generatedAt}. Packages: ${rows.length}.`,
    `Evaluation ledger SHA-256: \`${after}\`.`,
    '',
    `Qualification exit: **${qualification.exitCode}**. Static quality exit: **${quality.exitCode}**.`,
    `Promotion counts: ${JSON.stringify(qualification.report.promotion.statusCounts)}.`,
    `Execution: ${qualification.report.execution.ready}/${qualification.report.execution.scenarios} ready.`,
    '',
    'This is an audit snapshot, not new model, native, or blind-review evidence. Counts are current-revision',
    'coverage, not necessarily successful tasks. Historical failures remain in the evaluation ledger.',
    'Inspect the JSON companion for the complete static-quality findings and original gate output.',
    'Priority: review-only gaps, measured failures/regressions, missing empirical evidence, unavailable',
    'environments, then ready packages (preserve their revisions). No ledger is written by this report.',
    '',
  ].join('\n');
  writeFileSync(resolve(directory, 'inventory.md'), prefix + '\n' + rendered.markdown);
  writeFileSync(resolve(directory, 'inventory.csv'), rendered.csv);
  writeFileSync(
    resolve(directory, 'audit.json'),
    JSON.stringify(
      {
        generatedAt,
        evaluationLedgerSha256: after,
        qualification,
        quality,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        directory: 'outputs/skill-v5-promotion',
        generatedAt,
        packages: rows.length,
        statusCounts: qualification.report.promotion.statusCounts,
        qualificationExitCode: qualification.exitCode,
        qualityExitCode: quality.exitCode,
      },
      null,
      2,
    ),
  );
  process.exitCode = qualification.exitCode || quality.exitCode;
}
