import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS,
  DATA_PERFORMANCE_VISUALIZATION_SCORERS,
} from '../skill-eval-data-performance-visualization-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
const artifactPath = '.kory-eval/visualization-conversion.json';
const observation = { output: '', evidence: [], artifacts: [], durationMs: 0 };
const archivedPair = join(
  import.meta.dir,
  '../../../../.koryphaios/skills/eval-artifacts',
  'data-visualization-full-task-2-individual_699b32f7-2f3b-4be1-859c-3c0faf351a31',
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'data-visualization',
  )!;
  const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
    (item) => item.id === 'data-visualization-full-task-2-individual',
  )!;
  const materializer = DATA_PERFORMANCE_VISUALIZATION_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = DATA_PERFORMANCE_VISUALIZATION_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-conversion-contract-'));
  roots.push(root);
  await materializer.materialize(root, scenario);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  const source = JSON.parse(readFileSync(join(root, 'data/conversion.json'), 'utf8')) as Array<{
    region: string | null;
    regionCode?: string;
    eligibleSessions: number;
    conversions: number;
  }>;
  const rows: Array<Record<string, unknown>> = source.map((row) => {
    const rate = row.conversions / row.eligibleSessions;
    const z2 = 1.96 ** 2;
    const scale = 1 + z2 / row.eligibleSessions;
    const center = (rate + z2 / (2 * row.eligibleSessions)) / scale;
    const halfWidth =
      (1.96 *
        Math.sqrt((rate * (1 - rate) + z2 / (4 * row.eligibleSessions)) / row.eligibleSessions)) /
      scale;
    return {
      ...row,
      label: row.region ?? `Unknown region (${row.regionCode})`,
      rate,
      lower95: center - halfWidth,
      upper95: center + halfWidth,
      lowSample: row.eligibleSessions < 50,
      status:
        row.eligibleSessions < 50 ? 'Low sample: fewer than 50 eligible sessions' : 'standard',
    };
  });
  rows.sort((left, right) => Number(right.rate) - Number(left.rate));
  const artifact = {
    analyticalTask: 'rate comparison with binomial uncertainty',
    reader: 'unspecified',
    chart: {
      type: 'horizontal dot-and-interval',
      ordering: { field: 'rate', direction: 'descending' },
      x: { field: 'rate', type: 'quantitative' },
      interval: { lowerField: 'lower95', upperField: 'upper95' },
    },
    rows,
    accessibility: { table: true, textAlternative: 'Accessible table for every region' },
    narrowScreen: 'narrow mobile table fallback',
    scopeBoundary: 'Source data and pipeline stay unchanged; product strategy is out of scope.',
    verification: { status: 'unobserved', reason: 'Text-patch mode has no execution tools.' },
  };
  const write = () => writeFileSync(join(root, artifactPath), `${JSON.stringify(artifact)}\n`);
  const score = () =>
    scorer.score({ scenario, experiment: {} as never, workingDirectory: root, observation });
  write();
  return { root, artifact, rows, write, score, materializer, scorer };
}

function selfClaim(root: string) {
  const sha256 = (path: string) =>
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex');
  writeFileSync(
    join(root, '.kory-eval/visualization-conversion-verification.json'),
    JSON.stringify({
      artifactSha256: sha256(artifactPath),
      sourceSha256: sha256('data/conversion.json'),
      command: 'candidate says verification ran',
      success: { executed: true, passed: true },
      negativePath: { executed: true, mutation: 'change denominator', rejected: true },
      recovery: { executed: true, passed: true },
    }),
  );
}

describe('regional conversion public contract', () => {
  test('accepts lower95/upper95 and honest not-run evidence using host-owned checks', async () => {
    const { root, write, score } = await fixture();
    const before = readFileSync(join(root, artifactPath), 'utf8');
    const result = await score();
    expect(result.passed).toBe(true);
    expect(result.verification).toBe(1);
    expect(result.evidence).toContain(
      'all 8 denominators/rates/intervals numerically correct: yes',
    );
    expect(result.evidence.join('\n')).toContain(
      'host-owned static specification verification: success=passed',
    );
    expect(result.evidence.join('\n')).toContain('negative denominator corruption=rejected');
    expect(result.evidence.join('\n')).toContain('recovery reread=passed');
    expect(result.evidence.join('\n')).toContain(
      `artifactSha256=${createHash('sha256').update(before).digest('hex')}`,
    );
    expect(result.evidence.join('\n')).toContain(
      `sourceSha256=${createHash('sha256')
        .update(readFileSync(join(root, 'data/conversion.json')))
        .digest('hex')}`,
    );
    expect(readFileSync(join(root, artifactPath), 'utf8')).toBe(before);
    selfClaim(root);
    write();
    expect(await score()).toEqual(result);
  });

  test.each(['flat', 'array', 'nested'])('retains existing %s interval support', async (shape) => {
    const { artifact, rows, write, score } = await fixture();
    for (const row of rows) {
      const lower = row.lower95;
      const upper = row.upper95;
      delete row.lower95;
      delete row.upper95;
      if (shape === 'flat') Object.assign(row, { lower, upper });
      if (shape === 'array') row.interval95 = [lower, upper];
      if (shape === 'nested') row.interval95 = { lower, upper };
    }
    artifact.chart.interval = shape === 'flat'
      ? { lowerField: 'lower', upperField: 'upper' }
      : { field: 'interval95' } as never;
    write();
    expect((await score()).passed).toBe(true);
  });

  test.each([
    ['string lower bound', { lower95: '0.01' }],
    ['null lower bound', { lower95: null }],
    ['non-finite upper bound', { upper95: Infinity }],
    ['missing upper bound', { upper95: undefined }],
    ['reversed bounds', { lower95: 0.2, upper95: 0.1 }],
    ['zero-width bounds', { lower95: 0.15, upper95: 0.15 }],
    ['rate outside interval', { lower95: 0.16, upper95: 0.3 }],
    ['negative probability', { lower95: -0.01 }],
    ['upper probability above one', { upper95: 1.01 }],
    ['conflicting flat alias', { lower: 0.01 }],
    ['conflicting interval array', { interval95: [0.01, 0.3] }],
    ['malformed interval object', { interval95: { lower: '0.01', upper: 0.3 } }],
    ['wrong denominator', { eligibleSessions: 41 }],
    ['wrong numerator', { conversions: 7 }],
    ['wrong rate', { rate: 0.16 }],
  ])('rejects %s despite a candidate success record', async (_name, change) => {
    const { root, rows, write, score } = await fixture();
    Object.assign(rows[0]!, change);
    write();
    selfClaim(root);
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.evidence).toContain('all 8 denominators/rates/intervals numerically correct: no');
  });

  test('rejects plausible prose without a chart encoding and rejects incorrect field bindings', async () => {
    const { root, artifact, write, score } = await fixture();
    artifact.chart.interval = { lowerField: 'unusedLower', upperField: 'unusedUpper' };
    write();
    selfClaim(root);
    expect((await score()).passed).toBe(false);
    artifact.chart.interval = { lowerField: 'lower95', upperField: 'upper95' };
    artifact.chart.type = 'table of rates with Wilson intervals';
    write();
    expect((await score()).passed).toBe(false);
  });

  test('rejects intervals that enclose the rate but are not Wilson uncertainty estimates', async () => {
    const { rows, write, score } = await fixture();
    for (const row of rows) {
      row.lower95 = 0;
      row.upper95 = 1;
    }
    write();
    expect((await score()).passed).toBe(false);
  });

  test('requires per-row sample warnings and R8 resolution labels', async () => {
    const { rows, artifact, write, score } = await fixture();
    rows[0]!.lowSample = false;
    write();
    expect((await score()).passed).toBe(false);
    rows[0]!.lowSample = true;
    rows[0]!.status = 'standard';
    artifact.accessibility.textAlternative = 'Northeast and Southwest are low sample';
    write();
    expect((await score()).passed).toBe(false);
    rows[0]!.status = 'low sample';
    const unknown = rows.find((row) => row.region === null)!;
    unknown.label = 'Region 8';
    write();
    expect((await score()).passed).toBe(false);
  });

  test('retains the packet North sorting failure after accepting its interval aliases', async () => {
    const { root, rows, write, score } = await fixture();
    // 699b32f7 with-skill: North (9%) followed three 8% rows in a descending table.
    const packetOrder = [
      'Northeast',
      'South',
      'East',
      'Southwest',
      'West',
      'Central',
      'North',
      null,
    ];
    rows.sort(
      (left, right) =>
        packetOrder.indexOf(left.region as string | null) -
        packetOrder.indexOf(right.region as string | null),
    );
    write();
    selfClaim(root);
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.evidence).toContain(
      'all 8 denominators/rates/intervals numerically correct: yes',
    );
    expect(result.evidence).toContain('rows follow the declared rate ordering: no');
  });

  // The portable North-order reproduction above also runs on clean hosts without local archives.
  test.skipIf(!existsSync(archivedPair))(
    'replays both archived arms, then fixes only row order',
    async () => {
      for (const variant of ['with-skill', 'without-skill']) {
        const { root, score } = await fixture();
        const replay = JSON.parse(
          readFileSync(join(archivedPair, variant, 'files', artifactPath), 'utf8'),
        ) as { rows: Array<{ rate: number }> };
        writeFileSync(join(root, artifactPath), JSON.stringify(replay));
        const original = await score();
        expect(original.passed).toBe(false);
        expect(original.evidence).toContain(
          'all 8 denominators/rates/intervals numerically correct: yes',
        );
        expect(original.evidence).toContain('rows follow the declared rate ordering: no');
        replay.rows.sort((left, right) => right.rate - left.rate);
        writeFileSync(join(root, artifactPath), JSON.stringify(replay));
        expect((await score()).passed).toBe(true);
      }
    },
  );

  test('accepts either rate direction and arbitrary ties, but rejects a false direction declaration', async () => {
    const { artifact, rows, write, score } = await fixture();
    rows.reverse();
    write();
    expect((await score()).passed).toBe(false);
    artifact.chart.ordering.direction = 'ascending';
    write();
    expect((await score()).passed).toBe(true);
  });

  test.each(['missing', 'duplicate', 'extra'])('rejects %s rows', async (mutation) => {
    const { rows, write, score } = await fixture();
    if (mutation === 'missing') rows.pop();
    if (mutation === 'duplicate') rows[7] = { ...rows[0] };
    if (mutation === 'extra') rows.push({ ...rows[0] });
    write();
    expect((await score()).passed).toBe(false);
  });

  test('rejects changed source data even with matching candidate-authored hashes', async () => {
    const { root, score } = await fixture();
    writeFileSync(join(root, 'data/conversion.json'), '[]\n');
    selfClaim(root);
    const result = await score();
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
    expect(result.integrityFailure).toBe(true);
    expect(result.evidence).toContain('fixed conversion source integrity: changed or missing');
  });
});
