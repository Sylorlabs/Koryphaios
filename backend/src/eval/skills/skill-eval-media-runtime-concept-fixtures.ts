import {
  createConceptFixtures,
  type ConceptFixture,
  type ConceptVector,
} from './skill-eval-concept-fixtures';

function audioVectors(withBed: boolean): ConceptVector[] {
  return [1, 3, 9].flatMap((seed) => {
    const id = `encoded-${seed}`,
      target = -15 - seed;
    const base = {
      spec: { lufs: target, tolerance: 0.5, peakDbtp: -1, rate: 48000, codec: 'aac', duration: 30 },
      asset: { id, codec: 'aac', rate: 48000, duration: 30 },
      meters: {
        assetId: id,
        stage: 'encoded',
        lufs: target + 0.1,
        truePeak: -1.2,
        samplePeak: -1.5,
      },
      listening: {
        assetId: id,
        contexts: ['headphones', 'small-speakers', 'mono'],
        issues: [] as string[],
      },
      sourcePreserved: true,
      ...(withBed
        ? {
            gainDb: [-8, -8.5, -9, -9, -8.5],
            maxGainStepDb: 1,
            speechMusicMarginDb: [8, 9, 7],
            minSpeechMarginDb: 6,
          }
        : {}),
    };
    const verdict = (...issues: string[]) => ({
      accepted: issues.length === 0,
      issues: issues.sort(),
      scope: 'synthetic-measurements-only',
    });
    const vectors: ConceptVector[] = [
      {
        name: `final delivery within request-specific envelope ${seed}`,
        input: base,
        expected: verdict(),
      },
      {
        name: `post-encode true peak overrides clean sample peak ${seed}`,
        input: { ...base, meters: { ...base.meters, truePeak: -0.2 } },
        expected: verdict('true-peak'),
      },
      {
        name: `DAW preview is not final encoded evidence ${seed}`,
        input: { ...base, meters: { ...base.meters, stage: 'preview' } },
        expected: verdict('final-file-evidence'),
      },
      {
        name: `meter success does not erase listening artifacts ${seed}`,
        input: { ...base, listening: { ...base.listening, issues: ['metallic-consonants'] } },
        expected: verdict('listening-artifacts'),
      },
      {
        name: `missing monitoring context remains unverified ${seed}`,
        input: { ...base, listening: { ...base.listening, contexts: ['headphones'] } },
        expected: verdict('listening-coverage'),
      },
      {
        name: `measurements from another encode do not transfer ${seed}`,
        input: {
          ...base,
          meters: { ...base.meters, assetId: 'other' },
          listening: { ...base.listening, assetId: 'other' },
        },
        expected: verdict('final-file-evidence', 'listening-identity'),
      },
      {
        name: `wrong duration and codec do not satisfy delivery ${seed}`,
        input: { ...base, asset: { ...base.asset, duration: 29, codec: 'wav' } },
        expected: verdict('format', 'timing'),
      },
      {
        name: `loudness and preserved source are independent gates ${seed}`,
        input: { ...base, meters: { ...base.meters, lufs: target + 4 }, sourcePreserved: false },
        expected: verdict('loudness', 'source-preservation'),
      },
      {
        name: `missing loudness is unknown rather than zero ${seed}`,
        input: { ...base, meters: { ...base.meters, lufs: null } },
        expected: verdict('loudness'),
      },
    ];
    if (withBed)
      vectors.push(
        {
          name: `excessive phrase gain step exposes breathing ${seed}`,
          input: { ...base, gainDb: [-9, -2, -9] },
          expected: verdict('gain-jump'),
        },
        {
          name: `music cannot mask narration while meters pass ${seed}`,
          input: { ...base, speechMusicMarginDb: [9, 2, 8] },
          expected: verdict('speech-masking'),
        },
      );
    return vectors;
  });
}

function permissionVectors(): ConceptVector[] {
  return [2, 7, 41].map((seed) => {
    const config = `/workspace-${seed}/config`,
      output = `/workspace-${seed}/output`;
    const origin = `https://api-${seed}.example.invalid`,
      git = '/usr/bin/git';
    const requests = [
      { id: 'read', kind: 'read', realPath: `${config}/app.json` },
      { id: 'prefix', kind: 'read', realPath: `${config}-other/app.json` },
      { id: 'symlink', kind: 'read', path: `${config}/link`, realPath: '/private/other.json' },
      { id: 'write', kind: 'write', realPath: `${output}/result.json` },
      { id: 'wrong-write', kind: 'write', realPath: `${config}/app.json` },
      { id: 'fetch', kind: 'fetch', url: `${origin}/v1`, redirects: [] },
      {
        id: 'redirect',
        kind: 'fetch',
        url: `${origin}/v1`,
        redirects: ['https://other.example.invalid/x'],
      },
      { id: 'downgrade', kind: 'fetch', url: origin.replace('https:', 'http:'), redirects: [] },
      {
        id: 'userinfo',
        kind: 'fetch',
        url: `https://api-${seed}.example.invalid@other.example.invalid/`,
        redirects: [],
      },
      { id: 'port', kind: 'fetch', url: `${origin}:8443/`, redirects: [] },
      { id: 'status', kind: 'run', executable: git, args: ['status', '--porcelain'] },
      { id: 'revision', kind: 'run', executable: git, args: ['rev-parse', 'HEAD'] },
      { id: 'mutating-git', kind: 'run', executable: git, args: ['reset', '--hard'] },
      {
        id: 'config-injection',
        kind: 'run',
        executable: git,
        args: ['-c', 'core.fsmonitor=unexpected', 'status'],
      },
      { id: 'shell', kind: 'run', executable: '/bin/sh', args: ['-c', 'true'] },
      { id: 'env', kind: 'env', key: 'SYNTHETIC_SECRET' },
    ];
    const allowed = new Set(['read', 'write', 'fetch', 'status', 'revision']);
    return {
      name: `scoped capabilities and subprocess boundary ${seed}`,
      input: { config, output, origin, git, requests },
      expected: {
        decisions: requests.map((r) => ({ id: r.id, allowed: allowed.has(r.id) })),
        flags: [
          `--allow-net=api-${seed}.example.invalid:443`,
          `--allow-read=${config}`,
          `--allow-run=${git}`,
          `--allow-write=${output}`,
          '--no-prompt',
        ].sort(),
        subprocessConfined: false,
        scope: 'synthetic-policy-only',
      },
    };
  });
}

const audioContract = `Evaluate supplied synthetic final-file evidence, not a preferred processing chain. Input has spec{lufs,tolerance,peakDbtp,rate,codec,duration}, asset{id,codec,rate,duration}, meters{assetId,stage,lufs,truePeak,samplePeak}, listening{assetId,contexts,issues},sourcePreserved. Return {accepted,issues,scope}, where issues are sorted, accepted means no issues, and scope is synthetic-measurements-only. Issue codes: final-file-evidence for wrong meter asset/stage (must be encoded); loudness for missing/nonfinite/out-of-tolerance integrated loudness; true-peak for missing/nonfinite truePeak or above ceiling (samplePeak is not a substitute); format for codec/rate mismatch; timing for duration mismatch above 0.01 seconds; listening-identity for wrong asset; listening-coverage unless headphones, small-speakers and mono are all represented; listening-artifacts for nonempty listening issues; source-preservation unless true. Numeric targets are per-request fixture requirements, not universal mastering rules. This is a decision/evidence exercise, not actual listening or audio rendering.`;

export const MEDIA_RUNTIME_CONCEPTS: readonly ConceptFixture[] = [
  {
    id: 'audio-production-full-task-1-individual',
    skill: 'audio-production',
    blockers: [
      'Component evidence exercise only: real speech stems, processing/encoding, final-file measurements, and independent listening evaluation are not yet materialized.',
    ],
    contract: audioContract,
    vectors: () => audioVectors(false),
  },
  {
    id: 'audio-production-full-task-2-individual',
    skill: 'audio-production',
    blockers: [
      'Component evidence exercise only: real narration/music stems, AAC rendering, and representative listening evidence are not yet materialized.',
    ],
    contract: `${audioContract}\nAlso inspect gainDb (ordered automation observations), maxGainStepDb, speechMusicMarginDb and minSpeechMarginDb. Add gain-jump if any adjacent absolute gain change exceeds the stated bound, speech-masking if any speech margin falls below its bound. These are supplied test tolerances, not prescriptions for compressor settings.`,
    vectors: () => audioVectors(true),
  },
  {
    id: 'bun-deno-runtime-full-task-2-individual',
    skill: 'bun-deno-runtime',
    blockers: [
      'Component policy exercise only: add a pinned Deno executable and actual allowed/denied filesystem/network/subprocess tests before full-task execution.',
    ],
    contract: `Evaluate {config,output,origin,git,requests}. config/output are canonical absolute roots and origin is an HTTPS origin. Use the fixture-resolved realPath (not a symlink logical path): read is allowed only within config, write only within output, with directory-segment boundaries. fetch requires the exact HTTPS origin for the initial URL AND every redirect. run requires the exact git executable AND either [status,--porcelain] or [rev-parse,HEAD] exactly; all other actions including environment reads are denied. Return {decisions:[{id,allowed}],flags,subprocessConfined:false,scope:synthetic-policy-only}. Preserve request order; flags sorted: --no-prompt and scoped --allow-read, --allow-write, --allow-net=host:443, --allow-run. Deno permissions do NOT confine child-process effects; a real implementation also needs an audited wrapper/environment and appropriate OS isolation or a no-subprocess alternative. No real commands or connections should be made by this evaluator.`,
    vectors: permissionVectors,
  },
];

// Retain the synthetic media vectors as isolated unit controls; full-task dispatch
// uses actual encoded media and post-encode probes in skill-eval-audio-production-runtime.
const fixtures = createConceptFixtures(
  MEDIA_RUNTIME_CONCEPTS.filter((d) => d.skill !== 'audio-production' && d.skill !== 'bun-deno-runtime'),
);
export const MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_MATERIALIZERS = fixtures.materializers;
export const MEDIA_RUNTIME_CONCEPT_SKILL_EVAL_SCORERS = fixtures.scorers;
