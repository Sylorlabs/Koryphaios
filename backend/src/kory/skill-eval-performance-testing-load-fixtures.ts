import { hostOS } from '../runtime/platform';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpus, release } from 'node:os';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  packageJson,
  readFixtureText,
  readJsonArtifact,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

// Open-model performance-testing fixture. The service under test is fixed and evaluator-owned;
// the subject's only deliverable is load-plan.json. The evaluator's own harness executes that
// plan against the fixed service, validates every response against a fixed oracle, and emits the
// machine-readable result. Candidate-authored measurements are never read.

const SCENARIO_ID = 'performance-testing-full-task-1';
const HARNESS_VERSION = 'kory-open-model-load-harness@1';
const RESULT_ARTIFACT = 'evaluation/performance-testing-scenario-1-result.json';
const VERIFICATION_ARTIFACT = 'evaluation/performance-testing-scenario-1-verification.json';
const LOAD_RUN_TIMEOUT_MS = 30_000;
const FIXTURE_RECORDS = 1_000_000;

const BOUNDS = {
  minArrivalRatePerSecond: 50,
  maxArrivalRatePerSecond: 1_000,
  requiredArrivalRatePerSecond: 300,
  minWarmupMs: 500,
  maxWarmupMs: 3_000,
  minMeasuredMs: 1_000,
  maxMeasuredMs: 3_000,
  requiredRepetitions: 3,
  minMaxDroppedFraction: 0,
  maxMaxDroppedFraction: 0.5,
} as const;

const DATASET_SOURCE = `import { createHash } from 'node:crypto';

// Data only. This module never contains a search/ranking implementation: it owns the
// deterministic corpus, the compact columnar accessors, the inverted-index builder, and
// the corpus fingerprint. The service and the evaluator's reference search both read it.

export const SPEC = Object.freeze({
  records: 1_000_000,
  seed: 0x5eed1234,
  tokensPerRecord: 2,
  vocabularySize: 64,
  scoreModulus: 1_000_000,
  idPrefix: 'doc-',
  idPad: 7,
});

const RECORDS = SPEC.records;
const TOKENS_PER_RECORD = SPEC.tokensPerRecord;
const VOCABULARY_SIZE = SPEC.vocabularySize;

// Deterministic xorshift32 so the corpus is identical on every machine and every run.
let randomState = SPEC.seed >>> 0;
function nextRandom() {
  randomState ^= (randomState << 13) >>> 0;
  randomState >>>= 0;
  randomState ^= randomState >>> 17;
  randomState ^= (randomState << 5) >>> 0;
  randomState >>>= 0;
  return randomState;
}

// Compact columnar storage: two uint32 token ids plus one uint32 score per record.
// 1,000,000 records costs ~12 MB here instead of ~150-250 MB of JS objects.
const tokenColumn = new Uint32Array(RECORDS * TOKENS_PER_RECORD);
const scoreColumn = new Uint32Array(RECORDS);
for (let index = 0; index < RECORDS; index += 1) {
  const first = nextRandom() % VOCABULARY_SIZE;
  let second = nextRandom() % VOCABULARY_SIZE;
  if (second === first) second = (second + 1) % VOCABULARY_SIZE;
  tokenColumn[index * TOKENS_PER_RECORD] = first;
  tokenColumn[index * TOKENS_PER_RECORD + 1] = second;
  scoreColumn[index] = nextRandom() % SPEC.scoreModulus;
}

export function recordCount() {
  return RECORDS;
}

export function scoreOf(index) {
  return scoreColumn[index];
}

export function tokenAOf(index) {
  return tokenColumn[index * TOKENS_PER_RECORD];
}

export function tokenBOf(index) {
  return tokenColumn[index * TOKENS_PER_RECORD + 1];
}

export function tokensOf(index) {
  return [tokenAOf(index), tokenBOf(index)];
}

export function idOf(index) {
  return SPEC.idPrefix + String(index).padStart(SPEC.idPad, '0');
}

export function termForTokenId(tokenId) {
  return tokenId >= 0 && tokenId < VOCABULARY_SIZE
    ? 'term-' + String(tokenId).padStart(2, '0')
    : null;
}

export function tokenIdForTerm(term) {
  const match = /^term-(\\d{2})$/u.exec(term);
  if (!match) return -1;
  const value = Number(match[1]);
  return value >= 0 && value < VOCABULARY_SIZE ? value : -1;
}

export function fingerprint() {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(SPEC));
  let checksum = 0;
  for (let index = 0; index < RECORDS; index += 4096) {
    checksum =
      (Math.imul(checksum, 31) +
        scoreColumn[index] +
        Math.imul(tokenAOf(index), 7) +
        Math.imul(tokenBOf(index), 13)) >>>
      0;
  }
  hash.update('|sampled-checksum:' + String(checksum));
  return hash.digest('hex');
}

// Token id -> Uint32Array posting list of record ids ordered by score desc then id asc.
export function buildIndex() {
  const counts = new Uint32Array(VOCABULARY_SIZE + 1);
  for (let index = 0; index < RECORDS; index += 1) {
    counts[tokenAOf(index) + 1] += 1;
    counts[tokenBOf(index) + 1] += 1;
  }
  for (let token = 0; token < VOCABULARY_SIZE; token += 1) counts[token + 1] += counts[token];
  const starts = counts.slice();
  const cursors = counts.slice();
  const flat = new Uint32Array(RECORDS * TOKENS_PER_RECORD);
  for (let index = 0; index < RECORDS; index += 1) {
    flat[cursors[tokenAOf(index)]++] = index;
    flat[cursors[tokenBOf(index)]++] = index;
  }
  const postingLists = new Map();
  for (let token = 0; token < VOCABULARY_SIZE; token += 1) {
    const slice = flat.subarray(starts[token], cursors[token]);
    slice.sort((left, right) => scoreColumn[right] - scoreColumn[left] || left - right);
    postingLists.set(token, slice);
  }
  return { postingLists, flat };
}`;

const REFERENCE_SEARCH_SOURCE = `import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  idOf,
  recordCount,
  scoreOf,
  tokenAOf,
  tokenBOf,
  tokenIdForTerm,
} from '../corpus/dataset.js';

// Independent reference search: a full brute-force scan over the columnar accessors.
// It deliberately shares no code path with src/service.ts (which answers from the
// evaluator-owned inverted index), so a service ranking defect cannot agree with it
// silently. The oracle in corpus/oracle.json is generated from this implementation.

export const ORACLE_LIMIT = 20;

export const QUERIES = Object.freeze([
  'term-00',
  'term-01',
  'term-02',
  'term-03',
  'term-04',
  'term-05',
  'term-06',
  'term-07',
  'term-08',
  'term-09',
  'term-10',
  'term-11',
  'term-12',
  'term-13',
  'term-14',
  'term-15',
  'term-16',
  'term-17',
  'term-18',
  'term-19',
  'term-20',
  'term-21',
  'term-22',
  'term-23',
  'absent-alpha',
  'absent-beta',
  'absent-gamma',
]);

export function searchReference(term, limit) {
  const tokenId = tokenIdForTerm(term);
  if (tokenId < 0) return { query: term, total: 0, results: [] };
  const hits = [];
  for (let index = 0; index < recordCount(); index += 1) {
    if (tokenAOf(index) === tokenId || tokenBOf(index) === tokenId) hits.push(index);
  }
  hits.sort((left, right) => scoreOf(right) - scoreOf(left) || left - right);
  const bounded = Math.max(0, Math.min(limit, hits.length));
  const results = [];
  for (let position = 0; position < bounded; position += 1) {
    const index = hits[position];
    results.push({ id: idOf(index), score: scoreOf(index) });
  }
  return { query: term, total: hits.length, results };
}

export function buildOracle() {
  const queries = {};
  for (const term of QUERIES) queries[term] = searchReference(term, ORACLE_LIMIT);
  return { limit: ORACLE_LIMIT, queries };
}

if (import.meta.main) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('usage: reference-search.mjs <oracle-output-path>');
  mkdirSync(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, JSON.stringify(buildOracle(), null, 2) + '\\n');
  process.stdout.write(JSON.stringify({ ok: true, queries: QUERIES.length }) + '\\n');
}`;

const ORACLE_JSON = `{
  "limit": 20,
  "queries": {
    "term-00": {
      "query": "term-00",
      "total": 31081,
      "results": [
        {
          "id": "doc-0938684",
          "score": 999918
        },
        {
          "id": "doc-0372420",
          "score": 999898
        },
        {
          "id": "doc-0766127",
          "score": 999877
        },
        {
          "id": "doc-0578430",
          "score": 999820
        },
        {
          "id": "doc-0114606",
          "score": 999803
        },
        {
          "id": "doc-0509133",
          "score": 999779
        },
        {
          "id": "doc-0363582",
          "score": 999774
        },
        {
          "id": "doc-0625750",
          "score": 999763
        },
        {
          "id": "doc-0035112",
          "score": 999666
        },
        {
          "id": "doc-0100151",
          "score": 999585
        },
        {
          "id": "doc-0820062",
          "score": 999572
        },
        {
          "id": "doc-0410841",
          "score": 999550
        },
        {
          "id": "doc-0570290",
          "score": 999541
        },
        {
          "id": "doc-0654769",
          "score": 999445
        },
        {
          "id": "doc-0052104",
          "score": 999413
        },
        {
          "id": "doc-0484187",
          "score": 999320
        },
        {
          "id": "doc-0045113",
          "score": 999196
        },
        {
          "id": "doc-0032435",
          "score": 999185
        },
        {
          "id": "doc-0319540",
          "score": 999176
        },
        {
          "id": "doc-0279989",
          "score": 999128
        }
      ]
    },
    "term-01": {
      "query": "term-01",
      "total": 31035,
      "results": [
        {
          "id": "doc-0962145",
          "score": 999959
        },
        {
          "id": "doc-0001073",
          "score": 999920
        },
        {
          "id": "doc-0496009",
          "score": 999883
        },
        {
          "id": "doc-0906930",
          "score": 999797
        },
        {
          "id": "doc-0630639",
          "score": 999796
        },
        {
          "id": "doc-0076056",
          "score": 999791
        },
        {
          "id": "doc-0590294",
          "score": 999785
        },
        {
          "id": "doc-0732404",
          "score": 999747
        },
        {
          "id": "doc-0635680",
          "score": 999710
        },
        {
          "id": "doc-0323774",
          "score": 999630
        },
        {
          "id": "doc-0157876",
          "score": 999549
        },
        {
          "id": "doc-0800400",
          "score": 999490
        },
        {
          "id": "doc-0718280",
          "score": 999483
        },
        {
          "id": "doc-0775435",
          "score": 999419
        },
        {
          "id": "doc-0067767",
          "score": 999405
        },
        {
          "id": "doc-0729228",
          "score": 999329
        },
        {
          "id": "doc-0430784",
          "score": 999298
        },
        {
          "id": "doc-0031223",
          "score": 999293
        },
        {
          "id": "doc-0436721",
          "score": 999291
        },
        {
          "id": "doc-0093775",
          "score": 999271
        }
      ]
    },
    "term-02": {
      "query": "term-02",
      "total": 31402,
      "results": [
        {
          "id": "doc-0518202",
          "score": 999990
        },
        {
          "id": "doc-0368075",
          "score": 999929
        },
        {
          "id": "doc-0855089",
          "score": 999923
        },
        {
          "id": "doc-0346175",
          "score": 999899
        },
        {
          "id": "doc-0537862",
          "score": 999818
        },
        {
          "id": "doc-0482943",
          "score": 999775
        },
        {
          "id": "doc-0616183",
          "score": 999774
        },
        {
          "id": "doc-0200503",
          "score": 999770
        },
        {
          "id": "doc-0241456",
          "score": 999770
        },
        {
          "id": "doc-0836539",
          "score": 999747
        },
        {
          "id": "doc-0870486",
          "score": 999731
        },
        {
          "id": "doc-0291184",
          "score": 999681
        },
        {
          "id": "doc-0650647",
          "score": 999676
        },
        {
          "id": "doc-0278513",
          "score": 999669
        },
        {
          "id": "doc-0047532",
          "score": 999611
        },
        {
          "id": "doc-0633296",
          "score": 999596
        },
        {
          "id": "doc-0590613",
          "score": 999572
        },
        {
          "id": "doc-0248434",
          "score": 999542
        },
        {
          "id": "doc-0624587",
          "score": 999503
        },
        {
          "id": "doc-0305289",
          "score": 999485
        }
      ]
    },
    "term-03": {
      "query": "term-03",
      "total": 31100,
      "results": [
        {
          "id": "doc-0001073",
          "score": 999920
        },
        {
          "id": "doc-0793864",
          "score": 999910
        },
        {
          "id": "doc-0283193",
          "score": 999868
        },
        {
          "id": "doc-0808423",
          "score": 999855
        },
        {
          "id": "doc-0838670",
          "score": 999851
        },
        {
          "id": "doc-0803583",
          "score": 999789
        },
        {
          "id": "doc-0489754",
          "score": 999767
        },
        {
          "id": "doc-0788269",
          "score": 999749
        },
        {
          "id": "doc-0793337",
          "score": 999738
        },
        {
          "id": "doc-0539657",
          "score": 999724
        },
        {
          "id": "doc-0135364",
          "score": 999655
        },
        {
          "id": "doc-0808749",
          "score": 999646
        },
        {
          "id": "doc-0295091",
          "score": 999643
        },
        {
          "id": "doc-0942449",
          "score": 999642
        },
        {
          "id": "doc-0206900",
          "score": 999636
        },
        {
          "id": "doc-0608952",
          "score": 999626
        },
        {
          "id": "doc-0213507",
          "score": 999547
        },
        {
          "id": "doc-0135191",
          "score": 999531
        },
        {
          "id": "doc-0804963",
          "score": 999525
        },
        {
          "id": "doc-0812040",
          "score": 999524
        }
      ]
    },
    "term-04": {
      "query": "term-04",
      "total": 30990,
      "results": [
        {
          "id": "doc-0832243",
          "score": 999996
        },
        {
          "id": "doc-0308789",
          "score": 999963
        },
        {
          "id": "doc-0402251",
          "score": 999920
        },
        {
          "id": "doc-0094436",
          "score": 999893
        },
        {
          "id": "doc-0804249",
          "score": 999880
        },
        {
          "id": "doc-0865811",
          "score": 999835
        },
        {
          "id": "doc-0212655",
          "score": 999826
        },
        {
          "id": "doc-0147771",
          "score": 999808
        },
        {
          "id": "doc-0940701",
          "score": 999771
        },
        {
          "id": "doc-0189675",
          "score": 999721
        },
        {
          "id": "doc-0202367",
          "score": 999638
        },
        {
          "id": "doc-0282084",
          "score": 999490
        },
        {
          "id": "doc-0250187",
          "score": 999479
        },
        {
          "id": "doc-0369875",
          "score": 999436
        },
        {
          "id": "doc-0764432",
          "score": 999429
        },
        {
          "id": "doc-0226018",
          "score": 999405
        },
        {
          "id": "doc-0170326",
          "score": 999348
        },
        {
          "id": "doc-0323739",
          "score": 999348
        },
        {
          "id": "doc-0100028",
          "score": 999313
        },
        {
          "id": "doc-0349438",
          "score": 999289
        }
      ]
    },
    "term-05": {
      "query": "term-05",
      "total": 31060,
      "results": [
        {
          "id": "doc-0830482",
          "score": 999943
        },
        {
          "id": "doc-0808423",
          "score": 999855
        },
        {
          "id": "doc-0829182",
          "score": 999849
        },
        {
          "id": "doc-0181029",
          "score": 999843
        },
        {
          "id": "doc-0836680",
          "score": 999728
        },
        {
          "id": "doc-0080003",
          "score": 999687
        },
        {
          "id": "doc-0042085",
          "score": 999682
        },
        {
          "id": "doc-0479666",
          "score": 999674
        },
        {
          "id": "doc-0619684",
          "score": 999648
        },
        {
          "id": "doc-0564865",
          "score": 999612
        },
        {
          "id": "doc-0201266",
          "score": 999560
        },
        {
          "id": "doc-0718280",
          "score": 999483
        },
        {
          "id": "doc-0736133",
          "score": 999309
        },
        {
          "id": "doc-0987710",
          "score": 999302
        },
        {
          "id": "doc-0169577",
          "score": 999271
        },
        {
          "id": "doc-0559817",
          "score": 999251
        },
        {
          "id": "doc-0523754",
          "score": 999225
        },
        {
          "id": "doc-0243570",
          "score": 999188
        },
        {
          "id": "doc-0799068",
          "score": 999168
        },
        {
          "id": "doc-0131470",
          "score": 999094
        }
      ]
    },
    "term-06": {
      "query": "term-06",
      "total": 31315,
      "results": [
        {
          "id": "doc-0838443",
          "score": 999945
        },
        {
          "id": "doc-0728233",
          "score": 999922
        },
        {
          "id": "doc-0729777",
          "score": 999907
        },
        {
          "id": "doc-0002768",
          "score": 999905
        },
        {
          "id": "doc-0503316",
          "score": 999874
        },
        {
          "id": "doc-0202250",
          "score": 999772
        },
        {
          "id": "doc-0175242",
          "score": 999673
        },
        {
          "id": "doc-0990274",
          "score": 999669
        },
        {
          "id": "doc-0105982",
          "score": 999614
        },
        {
          "id": "doc-0213507",
          "score": 999547
        },
        {
          "id": "doc-0270213",
          "score": 999435
        },
        {
          "id": "doc-0915221",
          "score": 999414
        },
        {
          "id": "doc-0052104",
          "score": 999413
        },
        {
          "id": "doc-0727638",
          "score": 999391
        },
        {
          "id": "doc-0032299",
          "score": 999367
        },
        {
          "id": "doc-0009988",
          "score": 999361
        },
        {
          "id": "doc-0195474",
          "score": 999342
        },
        {
          "id": "doc-0578246",
          "score": 999338
        },
        {
          "id": "doc-0100028",
          "score": 999313
        },
        {
          "id": "doc-0217498",
          "score": 999269
        }
      ]
    },
    "term-07": {
      "query": "term-07",
      "total": 31214,
      "results": [
        {
          "id": "doc-0398524",
          "score": 999942
        },
        {
          "id": "doc-0511833",
          "score": 999934
        },
        {
          "id": "doc-0791287",
          "score": 999899
        },
        {
          "id": "doc-0270883",
          "score": 999865
        },
        {
          "id": "doc-0080386",
          "score": 999817
        },
        {
          "id": "doc-0662631",
          "score": 999799
        },
        {
          "id": "doc-0918827",
          "score": 999791
        },
        {
          "id": "doc-0560248",
          "score": 999784
        },
        {
          "id": "doc-0253005",
          "score": 999777
        },
        {
          "id": "doc-0983678",
          "score": 999721
        },
        {
          "id": "doc-0557028",
          "score": 999576
        },
        {
          "id": "doc-0763386",
          "score": 999574
        },
        {
          "id": "doc-0504238",
          "score": 999555
        },
        {
          "id": "doc-0826300",
          "score": 999541
        },
        {
          "id": "doc-0814761",
          "score": 999451
        },
        {
          "id": "doc-0369875",
          "score": 999436
        },
        {
          "id": "doc-0446483",
          "score": 999379
        },
        {
          "id": "doc-0767158",
          "score": 999364
        },
        {
          "id": "doc-0993160",
          "score": 999326
        },
        {
          "id": "doc-0295378",
          "score": 999274
        }
      ]
    },
    "term-08": {
      "query": "term-08",
      "total": 31121,
      "results": [
        {
          "id": "doc-0366022",
          "score": 999993
        },
        {
          "id": "doc-0340365",
          "score": 999894
        },
        {
          "id": "doc-0906886",
          "score": 999757
        },
        {
          "id": "doc-0717187",
          "score": 999719
        },
        {
          "id": "doc-0675487",
          "score": 999647
        },
        {
          "id": "doc-0787912",
          "score": 999608
        },
        {
          "id": "doc-0814441",
          "score": 999606
        },
        {
          "id": "doc-0476610",
          "score": 999605
        },
        {
          "id": "doc-0759832",
          "score": 999588
        },
        {
          "id": "doc-0763386",
          "score": 999574
        },
        {
          "id": "doc-0409449",
          "score": 999522
        },
        {
          "id": "doc-0245743",
          "score": 999465
        },
        {
          "id": "doc-0220573",
          "score": 999402
        },
        {
          "id": "doc-0595894",
          "score": 999386
        },
        {
          "id": "doc-0643574",
          "score": 999378
        },
        {
          "id": "doc-0008698",
          "score": 999370
        },
        {
          "id": "doc-0326899",
          "score": 999354
        },
        {
          "id": "doc-0361909",
          "score": 999332
        },
        {
          "id": "doc-0093775",
          "score": 999271
        },
        {
          "id": "doc-0338056",
          "score": 999213
        }
      ]
    },
    "term-09": {
      "query": "term-09",
      "total": 31616,
      "results": [
        {
          "id": "doc-0366022",
          "score": 999993
        },
        {
          "id": "doc-0052451",
          "score": 999982
        },
        {
          "id": "doc-0890648",
          "score": 999948
        },
        {
          "id": "doc-0881268",
          "score": 999864
        },
        {
          "id": "doc-0181029",
          "score": 999843
        },
        {
          "id": "doc-0431193",
          "score": 999832
        },
        {
          "id": "doc-0760059",
          "score": 999830
        },
        {
          "id": "doc-0537862",
          "score": 999818
        },
        {
          "id": "doc-0625401",
          "score": 999801
        },
        {
          "id": "doc-0583898",
          "score": 999799
        },
        {
          "id": "doc-0185590",
          "score": 999678
        },
        {
          "id": "doc-0832429",
          "score": 999629
        },
        {
          "id": "doc-0105250",
          "score": 999593
        },
        {
          "id": "doc-0853514",
          "score": 999586
        },
        {
          "id": "doc-0704135",
          "score": 999583
        },
        {
          "id": "doc-0791212",
          "score": 999559
        },
        {
          "id": "doc-0292609",
          "score": 999547
        },
        {
          "id": "doc-0237897",
          "score": 999537
        },
        {
          "id": "doc-0804963",
          "score": 999525
        },
        {
          "id": "doc-0273223",
          "score": 999524
        }
      ]
    },
    "term-10": {
      "query": "term-10",
      "total": 31743,
      "results": [
        {
          "id": "doc-0404654",
          "score": 999979
        },
        {
          "id": "doc-0011986",
          "score": 999974
        },
        {
          "id": "doc-0756384",
          "score": 999960
        },
        {
          "id": "doc-0511833",
          "score": 999934
        },
        {
          "id": "doc-0767978",
          "score": 999894
        },
        {
          "id": "doc-0503316",
          "score": 999874
        },
        {
          "id": "doc-0714375",
          "score": 999846
        },
        {
          "id": "doc-0087675",
          "score": 999810
        },
        {
          "id": "doc-0843983",
          "score": 999770
        },
        {
          "id": "doc-0836539",
          "score": 999747
        },
        {
          "id": "doc-0365218",
          "score": 999650
        },
        {
          "id": "doc-0078253",
          "score": 999603
        },
        {
          "id": "doc-0759832",
          "score": 999588
        },
        {
          "id": "doc-0314649",
          "score": 999500
        },
        {
          "id": "doc-0300558",
          "score": 999475
        },
        {
          "id": "doc-0939872",
          "score": 999450
        },
        {
          "id": "doc-0821027",
          "score": 999435
        },
        {
          "id": "doc-0010282",
          "score": 999372
        },
        {
          "id": "doc-0122248",
          "score": 999360
        },
        {
          "id": "doc-0430059",
          "score": 999359
        }
      ]
    },
    "term-11": {
      "query": "term-11",
      "total": 31162,
      "results": [
        {
          "id": "doc-0380241",
          "score": 999978
        },
        {
          "id": "doc-0756384",
          "score": 999960
        },
        {
          "id": "doc-0549109",
          "score": 999876
        },
        {
          "id": "doc-0753086",
          "score": 999789
        },
        {
          "id": "doc-0793832",
          "score": 999786
        },
        {
          "id": "doc-0711525",
          "score": 999779
        },
        {
          "id": "doc-0447250",
          "score": 999736
        },
        {
          "id": "doc-0091008",
          "score": 999647
        },
        {
          "id": "doc-0478115",
          "score": 999628
        },
        {
          "id": "doc-0504423",
          "score": 999575
        },
        {
          "id": "doc-0584517",
          "score": 999512
        },
        {
          "id": "doc-0360781",
          "score": 999502
        },
        {
          "id": "doc-0890691",
          "score": 999497
        },
        {
          "id": "doc-0158180",
          "score": 999489
        },
        {
          "id": "doc-0894989",
          "score": 999462
        },
        {
          "id": "doc-0044974",
          "score": 999460
        },
        {
          "id": "doc-0087024",
          "score": 999445
        },
        {
          "id": "doc-0698253",
          "score": 999376
        },
        {
          "id": "doc-0301605",
          "score": 999339
        },
        {
          "id": "doc-0211904",
          "score": 999337
        }
      ]
    },
    "term-12": {
      "query": "term-12",
      "total": 31331,
      "results": [
        {
          "id": "doc-0830343",
          "score": 999864
        },
        {
          "id": "doc-0941779",
          "score": 999829
        },
        {
          "id": "doc-0852756",
          "score": 999815
        },
        {
          "id": "doc-0257318",
          "score": 999785
        },
        {
          "id": "doc-0560182",
          "score": 999774
        },
        {
          "id": "doc-0885192",
          "score": 999684
        },
        {
          "id": "doc-0172482",
          "score": 999680
        },
        {
          "id": "doc-0639112",
          "score": 999672
        },
        {
          "id": "doc-0658662",
          "score": 999657
        },
        {
          "id": "doc-0188406",
          "score": 999646
        },
        {
          "id": "doc-0879559",
          "score": 999625
        },
        {
          "id": "doc-0978435",
          "score": 999609
        },
        {
          "id": "doc-0242372",
          "score": 999582
        },
        {
          "id": "doc-0504423",
          "score": 999575
        },
        {
          "id": "doc-0271319",
          "score": 999560
        },
        {
          "id": "doc-0094526",
          "score": 999533
        },
        {
          "id": "doc-0708902",
          "score": 999524
        },
        {
          "id": "doc-0523380",
          "score": 999478
        },
        {
          "id": "doc-0074554",
          "score": 999415
        },
        {
          "id": "doc-0165918",
          "score": 999409
        }
      ]
    },
    "term-13": {
      "query": "term-13",
      "total": 31151,
      "results": [
        {
          "id": "doc-0268702",
          "score": 999977
        },
        {
          "id": "doc-0604607",
          "score": 999929
        },
        {
          "id": "doc-0729777",
          "score": 999907
        },
        {
          "id": "doc-0546384",
          "score": 999854
        },
        {
          "id": "doc-0040594",
          "score": 999848
        },
        {
          "id": "doc-0714375",
          "score": 999846
        },
        {
          "id": "doc-0167973",
          "score": 999835
        },
        {
          "id": "doc-0645464",
          "score": 999826
        },
        {
          "id": "doc-0616183",
          "score": 999774
        },
        {
          "id": "doc-0797843",
          "score": 999672
        },
        {
          "id": "doc-0594190",
          "score": 999619
        },
        {
          "id": "doc-0678161",
          "score": 999548
        },
        {
          "id": "doc-0939978",
          "score": 999524
        },
        {
          "id": "doc-0505590",
          "score": 999504
        },
        {
          "id": "doc-0180724",
          "score": 999422
        },
        {
          "id": "doc-0668483",
          "score": 999416
        },
        {
          "id": "doc-0770629",
          "score": 999366
        },
        {
          "id": "doc-0895820",
          "score": 999356
        },
        {
          "id": "doc-0326899",
          "score": 999354
        },
        {
          "id": "doc-0961249",
          "score": 999298
        }
      ]
    },
    "term-14": {
      "query": "term-14",
      "total": 31081,
      "results": [
        {
          "id": "doc-0997090",
          "score": 999983
        },
        {
          "id": "doc-0256468",
          "score": 999917
        },
        {
          "id": "doc-0067094",
          "score": 999907
        },
        {
          "id": "doc-0639227",
          "score": 999888
        },
        {
          "id": "doc-0655695",
          "score": 999855
        },
        {
          "id": "doc-0058548",
          "score": 999728
        },
        {
          "id": "doc-0931299",
          "score": 999699
        },
        {
          "id": "doc-0020737",
          "score": 999635
        },
        {
          "id": "doc-0137295",
          "score": 999548
        },
        {
          "id": "doc-0537581",
          "score": 999499
        },
        {
          "id": "doc-0808983",
          "score": 999402
        },
        {
          "id": "doc-0512073",
          "score": 999296
        },
        {
          "id": "doc-0409558",
          "score": 999284
        },
        {
          "id": "doc-0100423",
          "score": 999265
        },
        {
          "id": "doc-0509697",
          "score": 999256
        },
        {
          "id": "doc-0909856",
          "score": 999243
        },
        {
          "id": "doc-0977791",
          "score": 999239
        },
        {
          "id": "doc-0617558",
          "score": 999178
        },
        {
          "id": "doc-0340503",
          "score": 999100
        },
        {
          "id": "doc-0886481",
          "score": 999058
        }
      ]
    },
    "term-15": {
      "query": "term-15",
      "total": 31239,
      "results": [
        {
          "id": "doc-0894878",
          "score": 999991
        },
        {
          "id": "doc-0713341",
          "score": 999968
        },
        {
          "id": "doc-0447966",
          "score": 999906
        },
        {
          "id": "doc-0321128",
          "score": 999872
        },
        {
          "id": "doc-0283193",
          "score": 999868
        },
        {
          "id": "doc-0868728",
          "score": 999867
        },
        {
          "id": "doc-0535408",
          "score": 999843
        },
        {
          "id": "doc-0865811",
          "score": 999835
        },
        {
          "id": "doc-0078890",
          "score": 999832
        },
        {
          "id": "doc-0431193",
          "score": 999832
        },
        {
          "id": "doc-0940701",
          "score": 999771
        },
        {
          "id": "doc-0999020",
          "score": 999645
        },
        {
          "id": "doc-0140647",
          "score": 999561
        },
        {
          "id": "doc-0137295",
          "score": 999548
        },
        {
          "id": "doc-0324268",
          "score": 999473
        },
        {
          "id": "doc-0342011",
          "score": 999322
        },
        {
          "id": "doc-0271041",
          "score": 999312
        },
        {
          "id": "doc-0350854",
          "score": 999260
        },
        {
          "id": "doc-0536153",
          "score": 999196
        },
        {
          "id": "doc-0264746",
          "score": 999136
        }
      ]
    },
    "term-16": {
      "query": "term-16",
      "total": 30889,
      "results": [
        {
          "id": "doc-0034875",
          "score": 999948
        },
        {
          "id": "doc-0729256",
          "score": 999941
        },
        {
          "id": "doc-0001707",
          "score": 999928
        },
        {
          "id": "doc-0950760",
          "score": 999909
        },
        {
          "id": "doc-0110664",
          "score": 999888
        },
        {
          "id": "doc-0321128",
          "score": 999872
        },
        {
          "id": "doc-0215606",
          "score": 999870
        },
        {
          "id": "doc-0838670",
          "score": 999851
        },
        {
          "id": "doc-0405441",
          "score": 999845
        },
        {
          "id": "doc-0513877",
          "score": 999841
        },
        {
          "id": "doc-0296625",
          "score": 999834
        },
        {
          "id": "doc-0467322",
          "score": 999803
        },
        {
          "id": "doc-0246710",
          "score": 999769
        },
        {
          "id": "doc-0011233",
          "score": 999753
        },
        {
          "id": "doc-0836680",
          "score": 999728
        },
        {
          "id": "doc-0266194",
          "score": 999704
        },
        {
          "id": "doc-0479666",
          "score": 999674
        },
        {
          "id": "doc-0826471",
          "score": 999642
        },
        {
          "id": "doc-0927772",
          "score": 999535
        },
        {
          "id": "doc-0273223",
          "score": 999524
        }
      ]
    },
    "term-17": {
      "query": "term-17",
      "total": 31482,
      "results": [
        {
          "id": "doc-0894878",
          "score": 999991
        },
        {
          "id": "doc-0518202",
          "score": 999990
        },
        {
          "id": "doc-0888629",
          "score": 999963
        },
        {
          "id": "doc-0081983",
          "score": 999948
        },
        {
          "id": "doc-0303693",
          "score": 999914
        },
        {
          "id": "doc-0754311",
          "score": 999903
        },
        {
          "id": "doc-0483667",
          "score": 999850
        },
        {
          "id": "doc-0122176",
          "score": 999745
        },
        {
          "id": "doc-0743266",
          "score": 999720
        },
        {
          "id": "doc-0012725",
          "score": 999676
        },
        {
          "id": "doc-0836163",
          "score": 999649
        },
        {
          "id": "doc-0091008",
          "score": 999647
        },
        {
          "id": "doc-0964240",
          "score": 999620
        },
        {
          "id": "doc-0046550",
          "score": 999557
        },
        {
          "id": "doc-0027596",
          "score": 999510
        },
        {
          "id": "doc-0159575",
          "score": 999498
        },
        {
          "id": "doc-0522606",
          "score": 999477
        },
        {
          "id": "doc-0487893",
          "score": 999455
        },
        {
          "id": "doc-0372612",
          "score": 999397
        },
        {
          "id": "doc-0362591",
          "score": 999372
        }
      ]
    },
    "term-18": {
      "query": "term-18",
      "total": 31311,
      "results": [
        {
          "id": "doc-0317152",
          "score": 999964
        },
        {
          "id": "doc-0793003",
          "score": 999902
        },
        {
          "id": "doc-0031944",
          "score": 999846
        },
        {
          "id": "doc-0296625",
          "score": 999834
        },
        {
          "id": "doc-0986090",
          "score": 999807
        },
        {
          "id": "doc-0195416",
          "score": 999792
        },
        {
          "id": "doc-0115442",
          "score": 999790
        },
        {
          "id": "doc-0363582",
          "score": 999774
        },
        {
          "id": "doc-0202250",
          "score": 999772
        },
        {
          "id": "doc-0656001",
          "score": 999772
        },
        {
          "id": "doc-0278120",
          "score": 999768
        },
        {
          "id": "doc-0683827",
          "score": 999766
        },
        {
          "id": "doc-0476007",
          "score": 999633
        },
        {
          "id": "doc-0026805",
          "score": 999623
        },
        {
          "id": "doc-0613129",
          "score": 999618
        },
        {
          "id": "doc-0872547",
          "score": 999610
        },
        {
          "id": "doc-0518278",
          "score": 999585
        },
        {
          "id": "doc-0398835",
          "score": 999532
        },
        {
          "id": "doc-0770856",
          "score": 999524
        },
        {
          "id": "doc-0363346",
          "score": 999449
        }
      ]
    },
    "term-19": {
      "query": "term-19",
      "total": 31095,
      "results": [
        {
          "id": "doc-0886107",
          "score": 999975
        },
        {
          "id": "doc-0456243",
          "score": 999896
        },
        {
          "id": "doc-0804249",
          "score": 999880
        },
        {
          "id": "doc-0109435",
          "score": 999869
        },
        {
          "id": "doc-0410772",
          "score": 999869
        },
        {
          "id": "doc-0881268",
          "score": 999864
        },
        {
          "id": "doc-0614585",
          "score": 999846
        },
        {
          "id": "doc-0507106",
          "score": 999809
        },
        {
          "id": "doc-0246710",
          "score": 999769
        },
        {
          "id": "doc-0983678",
          "score": 999721
        },
        {
          "id": "doc-0323774",
          "score": 999630
        },
        {
          "id": "doc-0067324",
          "score": 999616
        },
        {
          "id": "doc-0116072",
          "score": 999611
        },
        {
          "id": "doc-0692366",
          "score": 999553
        },
        {
          "id": "doc-0426409",
          "score": 999528
        },
        {
          "id": "doc-0157474",
          "score": 999525
        },
        {
          "id": "doc-0814761",
          "score": 999451
        },
        {
          "id": "doc-0982504",
          "score": 999446
        },
        {
          "id": "doc-0269736",
          "score": 999434
        },
        {
          "id": "doc-0775477",
          "score": 999268
        }
      ]
    },
    "term-20": {
      "query": "term-20",
      "total": 31373,
      "results": [
        {
          "id": "doc-0997090",
          "score": 999983
        },
        {
          "id": "doc-0093046",
          "score": 999965
        },
        {
          "id": "doc-0056056",
          "score": 999957
        },
        {
          "id": "doc-0180439",
          "score": 999800
        },
        {
          "id": "doc-0870486",
          "score": 999731
        },
        {
          "id": "doc-0635680",
          "score": 999710
        },
        {
          "id": "doc-0610760",
          "score": 999695
        },
        {
          "id": "doc-0068876",
          "score": 999654
        },
        {
          "id": "doc-0052048",
          "score": 999621
        },
        {
          "id": "doc-0116072",
          "score": 999611
        },
        {
          "id": "doc-0362909",
          "score": 999605
        },
        {
          "id": "doc-0088128",
          "score": 999600
        },
        {
          "id": "doc-0434280",
          "score": 999593
        },
        {
          "id": "doc-0443863",
          "score": 999578
        },
        {
          "id": "doc-0537195",
          "score": 999557
        },
        {
          "id": "doc-0858959",
          "score": 999556
        },
        {
          "id": "doc-0841994",
          "score": 999504
        },
        {
          "id": "doc-0387629",
          "score": 999480
        },
        {
          "id": "doc-0790653",
          "score": 999470
        },
        {
          "id": "doc-0939872",
          "score": 999450
        }
      ]
    },
    "term-21": {
      "query": "term-21",
      "total": 31297,
      "results": [
        {
          "id": "doc-0083156",
          "score": 999917
        },
        {
          "id": "doc-0490414",
          "score": 999912
        },
        {
          "id": "doc-0410772",
          "score": 999869
        },
        {
          "id": "doc-0081840",
          "score": 999825
        },
        {
          "id": "doc-0147771",
          "score": 999808
        },
        {
          "id": "doc-0583898",
          "score": 999799
        },
        {
          "id": "doc-0539657",
          "score": 999724
        },
        {
          "id": "doc-0583630",
          "score": 999694
        },
        {
          "id": "doc-0787912",
          "score": 999608
        },
        {
          "id": "doc-0201266",
          "score": 999560
        },
        {
          "id": "doc-0158180",
          "score": 999489
        },
        {
          "id": "doc-0143327",
          "score": 999433
        },
        {
          "id": "doc-0251116",
          "score": 999428
        },
        {
          "id": "doc-0648775",
          "score": 999424
        },
        {
          "id": "doc-0010282",
          "score": 999372
        },
        {
          "id": "doc-0037458",
          "score": 999355
        },
        {
          "id": "doc-0830442",
          "score": 999345
        },
        {
          "id": "doc-0528977",
          "score": 999306
        },
        {
          "id": "doc-0228931",
          "score": 999241
        },
        {
          "id": "doc-0571606",
          "score": 999184
        }
      ]
    },
    "term-22": {
      "query": "term-22",
      "total": 31371,
      "results": [
        {
          "id": "doc-0955954",
          "score": 999968
        },
        {
          "id": "doc-0777428",
          "score": 999964
        },
        {
          "id": "doc-0034875",
          "score": 999948
        },
        {
          "id": "doc-0911679",
          "score": 999920
        },
        {
          "id": "doc-0337634",
          "score": 999907
        },
        {
          "id": "doc-0515168",
          "score": 999902
        },
        {
          "id": "doc-0225104",
          "score": 999853
        },
        {
          "id": "doc-0436961",
          "score": 999840
        },
        {
          "id": "doc-0578430",
          "score": 999820
        },
        {
          "id": "doc-0296031",
          "score": 999760
        },
        {
          "id": "doc-0171052",
          "score": 999751
        },
        {
          "id": "doc-0112938",
          "score": 999670
        },
        {
          "id": "doc-0629992",
          "score": 999596
        },
        {
          "id": "doc-0404619",
          "score": 999577
        },
        {
          "id": "doc-0518209",
          "score": 999525
        },
        {
          "id": "doc-0473969",
          "score": 999511
        },
        {
          "id": "doc-0151356",
          "score": 999469
        },
        {
          "id": "doc-0120832",
          "score": 999346
        },
        {
          "id": "doc-0657678",
          "score": 999337
        },
        {
          "id": "doc-0729228",
          "score": 999329
        }
      ]
    },
    "term-23": {
      "query": "term-23",
      "total": 31460,
      "results": [
        {
          "id": "doc-0895853",
          "score": 999968
        },
        {
          "id": "doc-0126196",
          "score": 999959
        },
        {
          "id": "doc-0696897",
          "score": 999959
        },
        {
          "id": "doc-0974960",
          "score": 999944
        },
        {
          "id": "doc-0623337",
          "score": 999937
        },
        {
          "id": "doc-0793864",
          "score": 999910
        },
        {
          "id": "doc-0485209",
          "score": 999881
        },
        {
          "id": "doc-0728236",
          "score": 999854
        },
        {
          "id": "doc-0467322",
          "score": 999803
        },
        {
          "id": "doc-0115442",
          "score": 999790
        },
        {
          "id": "doc-0882419",
          "score": 999781
        },
        {
          "id": "doc-0509133",
          "score": 999779
        },
        {
          "id": "doc-0907441",
          "score": 999763
        },
        {
          "id": "doc-0266194",
          "score": 999704
        },
        {
          "id": "doc-0085680",
          "score": 999684
        },
        {
          "id": "doc-0423012",
          "score": 999666
        },
        {
          "id": "doc-0613129",
          "score": 999618
        },
        {
          "id": "doc-0066052",
          "score": 999608
        },
        {
          "id": "doc-0242372",
          "score": 999582
        },
        {
          "id": "doc-0443863",
          "score": 999578
        }
      ]
    },
    "absent-alpha": {
      "query": "absent-alpha",
      "total": 0,
      "results": []
    },
    "absent-beta": {
      "query": "absent-beta",
      "total": 0,
      "results": []
    },
    "absent-gamma": {
      "query": "absent-gamma",
      "total": 0,
      "results": []
    }
  }
}`;

const SERVICE_SOURCE = `import {
  buildIndex,
  fingerprint,
  idOf,
  recordCount,
  scoreOf,
  tokenIdForTerm,
} from '../corpus/dataset.js';

export interface SearchResultRow {
  id: string;
  score: number;
}

export interface SearchResponseBody {
  query: string;
  total: number;
  results: SearchResultRow[];
}

export interface RunningService {
  port: number;
  pid: number;
  datasetRecords: number;
  datasetFingerprint: string;
  indexBuildMs: number;
  stop: () => void;
}

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 10;

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function search(tokenId: number, limit: number, index: { postingLists: Map<number, Uint32Array> }): {
  total: number;
  results: SearchResultRow[];
} {
  const postingList = index.postingLists.get(tokenId);
  if (!postingList) return { total: 0, results: [] };
  const bounded = Math.min(limit, postingList.length);
  const results: SearchResultRow[] = new Array(bounded);
  for (let position = 0; position < bounded; position += 1) {
    const record = postingList[position]!;
    results[position] = { id: idOf(record), score: scoreOf(record) };
  }
  return { total: postingList.length, results };
}

// The fixed, correct service under test. It is evaluator-owned: candidates only author the
// load plan, never this file. The server always binds an ephemeral port on 127.0.0.1.
export function startService(): RunningService {
  const buildStarted = performance.now();
  const index = buildIndex();
  const indexBuildMs = performance.now() - buildStarted;
  let totalRequests = 0;
  let inFlightRequests = 0;
  let maxConcurrentRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request: Request): Response {
      totalRequests += 1;
      inFlightRequests += 1;
      if (inFlightRequests > maxConcurrentRequests) maxConcurrentRequests = inFlightRequests;
      try {
        const url = new URL(request.url);
        if (url.pathname === '/health') return Response.json({ ok: true, status: 'healthy' });
        if (url.pathname !== '/search') return new Response('not found', { status: 404 });
        const query = url.searchParams.get('q') ?? '';
        const limit = parseLimit(url.searchParams.get('limit'));
        const tokenId = tokenIdForTerm(query);
        if (tokenId < 0) return Response.json({ query, total: 0, results: [] });
        const body = search(tokenId, limit, index);
        return Response.json({ query, total: body.total, results: body.results });
      } finally {
        inFlightRequests -= 1;
      }
    },
  });
  return {
    port: server.port,
    pid: process.pid,
    datasetRecords: recordCount(),
    datasetFingerprint: fingerprint(),
    indexBuildMs,
    stats: () => ({ totalRequests, maxConcurrentRequests, inFlightRequests }),
    resetStats: () => {
      totalRequests = 0;
      maxConcurrentRequests = 0;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const service = startService();
  process.stdout.write(
    JSON.stringify({ port: service.port, pid: service.pid, indexBuildMs: service.indexBuildMs }) +
      '\\n',
  );
}`;

const SERVICE_RUNNER_SOURCE = `import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Boots the fixed service under test in its own bounded child process, reports the ephemeral
// port plus the child pid on stdout, and stays alive until the evaluator kills it. Keeping the
// service out of the load-generator process is what makes per-side resource accounting real.

const serviceUrl = pathToFileURL(process.cwd() + '/src/service.ts').href;
const imported = await import(serviceUrl + '?boot=' + Date.now());
if (typeof imported.startService !== 'function') {
  throw new Error('src/service.ts must export startService()');
}
const service = imported.startService();
if (!service || typeof service.port !== 'number' || !(service.port > 0)) {
  throw new Error('src/service.ts did not expose a bound ephemeral port');
}

process.stdout.write(
  JSON.stringify({
    type: 'ready',
    port: service.port,
    pid: process.pid,
    indexBuildMs: service.indexBuildMs,
    datasetRecords: service.datasetRecords,
    datasetFingerprint: service.datasetFingerprint,
  }) + '\\n',
);

// The evaluator samples this process's own CPU and memory over stdin so that service-side
// resources are accounted separately from load-generator resources.
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const command = line.trim();
  if (command === 'reset') {
    service.resetStats();
    process.stdout.write(JSON.stringify({ type: 'reset-ok', pid: process.pid }) + '\\n');
    return;
  }
  if (command !== 'metrics') return;
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  process.stdout.write(
    JSON.stringify({
      type: 'metrics',
      pid: process.pid,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      uptimeMs: performance.now(),
      requests: service.stats(),
    }) + '\\n',
  );
});

// Bun.serve already refs the event loop; this keeps the child alive even if the server is
// stopped, so the evaluator always observes an explicit SIGKILL rather than an early exit.
const keepAlive = setInterval(() => {}, 1 << 30);
const shutdown = () => {
  clearInterval(keepAlive);
  try {
    service.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);`;

const LOAD_CORE_SOURCE = `import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fingerprint as datasetFingerprint, recordCount } from '../corpus/dataset.js';
import { ORACLE_LIMIT, QUERIES, searchReference } from './reference-search.mjs';

// Evaluator-owned open-model load engine. The candidate authors only load-plan.json; this
// process owns the arrival schedule, the fixed service child, the correctness oracle, the
// resource accounting, and the machine-readable result. Candidate-authored measurements are
// never read.

const SCENARIO_ID = 'performance-testing-full-task-1';
const HARNESS_VERSION = 'kory-open-model-load-harness@1';
const READY_TIMEOUT_MS = 8_000;
const METRICS_TIMEOUT_MS = 5_000;
const MAX_TOTAL_MS = 25_000;
// An iteration that cannot be dispatched within this lag of its scheduled time is counted as
// dropped instead of being silently sent late (which would hide coordinated omission).
const DROP_LAG_MS = 250;
const REQUEST_LIMITS = [5, 10, 20];

const BOUNDS = {
  minArrivalRatePerSecond: 50,
  maxArrivalRatePerSecond: 1_000,
  requiredArrivalRatePerSecond: 300,
  minWarmupMs: 500,
  maxWarmupMs: 3_000,
  minMeasuredMs: 1_000,
  maxMeasuredMs: 3_000,
  requiredRepetitions: 3,
  minMaxDroppedFraction: 0,
  maxMaxDroppedFraction: 0.5,
};

const sha = (value) => createHash('sha256').update(value).digest('hex');

const [planArg, outputArg] = process.argv.slice(2);
if (!planArg || !outputArg) throw new Error('usage: load-core.mjs <load-plan.json> <output-path>');
const root = process.cwd();
const planPath = resolve(root, planArg);
const outputPath = resolve(root, outputArg);
const receipt = process.env.KORY_PERF_LOAD_RECEIPT || '';
if (!receipt) throw new Error('missing evaluator load receipt');

function boundedNumber(plan, field, min, max) {
  const value = plan[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('load plan field ' + field + ' must be a finite number');
  }
  if (value < min || value > max) {
    throw new Error('load plan field ' + field + ' must be within [' + min + ', ' + max + ']');
  }
  return value;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('load-plan.json must contain a JSON object');
  }
  if (plan.arrivalModel !== 'open') {
    throw new Error(
      'load plan must use an open arrival-rate model (arrivalModel must be "open"); a closed model couples dispatch to response time and cannot expose coordinated omission',
    );
  }
  const rate = boundedNumber(
    plan,
    'arrivalRatePerSecond',
    BOUNDS.minArrivalRatePerSecond,
    BOUNDS.maxArrivalRatePerSecond,
  );
  if (rate !== BOUNDS.requiredArrivalRatePerSecond) {
    throw new Error(
      'load plan must model exactly ' +
        BOUNDS.requiredArrivalRatePerSecond +
        ' new requests/second independent of response time (received ' +
        rate +
        ')',
    );
  }
  boundedNumber(plan, 'warmupMs', BOUNDS.minWarmupMs, BOUNDS.maxWarmupMs);
  boundedNumber(plan, 'measuredMs', BOUNDS.minMeasuredMs, BOUNDS.maxMeasuredMs);
  boundedNumber(plan, 'maxDroppedFraction', BOUNDS.minMaxDroppedFraction, BOUNDS.maxMaxDroppedFraction);
  if (plan.repetitions !== BOUNDS.requiredRepetitions) {
    throw new Error('load plan must request exactly ' + BOUNDS.requiredRepetitions + ' measured repetitions');
  }
  if (plan.validateCorrectness !== true) {
    throw new Error('load plan must enable independent response validation (validateCorrectness: true)');
  }
  if (plan.reportGeneratorHeadroom !== true) {
    throw new Error('load plan must record load-generator headroom (reportGeneratorHeadroom: true)');
  }
  if (plan.separateProcessResources !== true) {
    throw new Error(
      'load plan must separate service and generator resources (separateProcessResources: true)',
    );
  }
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[position];
}

function matchesOracle(body, expected, limit) {
  if (!body || typeof body !== 'object' || !expected) return false;
  if (body.query !== expected.query) return false;
  if (body.total !== expected.total) return false;
  if (!Array.isArray(body.results)) return false;
  const expectedCount = Math.min(limit, expected.total);
  if (body.results.length !== expectedCount) return false;
  for (let position = 0; position < expectedCount; position += 1) {
    const actual = body.results[position];
    const reference = expected.results[position];
    if (!actual || !reference) return false;
    if (actual.id !== reference.id || actual.score !== reference.score) return false;
  }
  return true;
}

function makeLineChannel(stream) {
  const queue = [];
  let buffer = '';
  let closed = false;
  let notify = null;
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\\n');
    while (index >= 0) {
      queue.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\\n');
    }
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  });
  stream.on('end', () => {
    closed = true;
    if (notify) {
      const wake = notify;
      notify = null;
      wake();
    }
  });
  return {
    async waitFor(predicate, timeoutMs, label) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        while (queue.length) {
          const line = queue.shift();
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (predicate(parsed)) return parsed;
        }
        if (closed) throw new Error('service child exited while waiting for ' + label);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('timed out after ' + timeoutMs + 'ms waiting for ' + label);
        await new Promise((settle) => {
          notify = settle;
          setTimeout(settle, Math.min(remaining, 50));
        });
      }
    },
  };
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
validatePlan(plan);

const serviceText = readFileSync(join(root, 'src/service.ts'), 'utf8');
const runnerText = readFileSync(join(root, 'harness/service-runner.mjs'), 'utf8');
const loadCoreText = readFileSync(join(root, 'harness/load-core.mjs'), 'utf8');
const datasetText = readFileSync(join(root, 'corpus/dataset.js'), 'utf8');
const oracleText = readFileSync(join(root, 'corpus/oracle.json'), 'utf8');
const referenceText = readFileSync(join(root, 'harness/reference-search.mjs'), 'utf8');
const oracle = JSON.parse(oracleText);
if (oracle.limit !== ORACLE_LIMIT) throw new Error('fixed oracle limit mismatch');

// Cross-check the fixed oracle against the independent brute-force reference implementation
// over the corpus built in this process. This catches a dataset/oracle drift at runtime.
for (const term of QUERIES) {
  const expected = oracle.queries[term];
  if (!expected) throw new Error('fixed oracle is missing query ' + term);
  const actual = searchReference(term, ORACLE_LIMIT);
  if (actual.total !== expected.total) {
    throw new Error('oracle/dataset total mismatch for ' + term);
  }
  if (JSON.stringify(actual.results) !== JSON.stringify(expected.results)) {
    throw new Error('oracle/dataset ranking mismatch for ' + term);
  }
}

const identity = {
  runtime: 'Bun',
  runtimeVersion: Bun.version,
  platform: process.platform,
  architecture: process.arch,
  cpuModel: cpus()[0]?.model || 'unknown',
  cpuCount: cpus().length,
  osRelease: release(),
  harnessVersion: HARNESS_VERSION,
  datasetRecords: recordCount(),
  datasetFingerprint: datasetFingerprint(),
  datasetSourceFingerprint: sha(datasetText),
  oracleFingerprint: sha(oracleText),
  serviceImageFingerprint: sha(serviceText),
  serviceRunnerFingerprint: sha(runnerText),
  loadCoreFingerprint: sha(loadCoreText),
  referenceSearchFingerprint: sha(referenceText),
};
const identityFingerprint = sha(JSON.stringify(identity));

const child = spawn(
  process.execPath,
  ['run', '--no-env-file', join(root, 'harness/service-runner.mjs')],
  {
    cwd: root,
    env: {
      PATH: process.env.PATH || '',
      HOME: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      NO_COLOR: '1',
      TERM: 'dumb',
      KORY_PERF_LOAD_RECEIPT: receipt,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);

let childStderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  if (childStderr.length < 20_000) childStderr += chunk;
});

const killTimer = setTimeout(() => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* the child already exited */
  }
}, MAX_TOTAL_MS);

const channel = makeLineChannel(child.stdout);
const rawArtifacts = [];

try {
  const ready = await channel.waitFor(
    (message) => message.type === 'ready' && typeof message.port === 'number',
    READY_TIMEOUT_MS,
    'service readiness',
  );
  const port = ready.port;
  const servicePid = ready.pid;

  const sampleMetrics = async (label) => {
    try {
      child.stdin.write('metrics\\n');
    } catch (error) {
      throw new Error('unable to sample service metrics (' + label + '): ' + String(error));
    }
    return channel.waitFor(
      (message) => message.type === 'metrics',
      METRICS_TIMEOUT_MS,
      'service metrics (' + label + ')',
    );
  };

  const resetServiceStats = async (label) => {
    try {
      child.stdin.write('reset\\n');
    } catch (error) {
      throw new Error('unable to reset service request stats (' + label + '): ' + String(error));
    }
    return channel.waitFor(
      (message) => message.type === 'reset-ok',
      METRICS_TIMEOUT_MS,
      'service request-stat reset (' + label + ')',
    );
  };

  const startLagMonitor = () => {
    const samples = [];
    let expectedAt = performance.now() + 5;
    const timer = setInterval(() => {
      const now = performance.now();
      samples.push(Math.max(0, now - expectedAt));
      expectedAt = now + 5;
    }, 5);
    return () => {
      clearInterval(timer);
      return { max: samples.length ? Math.max(...samples) : 0, p95: percentile(samples, 0.95) };
    };
  };

  const intervalMs = 1000 / plan.arrivalRatePerSecond;

  const runPhase = async (label, phaseMs) => {
    const offered = Math.round((plan.arrivalRatePerSecond * phaseMs) / 1000);
    const generatorCpuStart = process.cpuUsage();
    const generatorMemoryStart = process.memoryUsage();
    await resetServiceStats(label);
    const serviceBefore = await sampleMetrics(label + '-before');
    const stopLagMonitor = startLagMonitor();
    const phaseStart = performance.now();
    const successLatencies = [];
    const scheduleLags = [];
    const checkedQueries = new Set();
    const inFlight = new Set();
    let started = 0;
    let completed = 0;
    let dropped = 0;
    let validated = 0;
    let mismatches = 0;
    let failedResponses = 0;
    let responseBytes = 0;
    let maxInFlight = 0;

    const tasks = [];
    for (let index = 0; index < offered; index += 1) {
      const scheduledAt = phaseStart + index * intervalMs;
      tasks.push(
        new Promise((settle) => {
          setTimeout(
            async () => {
              const dispatchedAt = performance.now();
              const scheduleLag = dispatchedAt - scheduledAt;
              if (scheduleLag > DROP_LAG_MS) {
                dropped += 1;
                settle();
                return;
              }
              started += 1;
              scheduleLags.push(scheduleLag);
              inFlight.add(index);
              if (inFlight.size > maxInFlight) maxInFlight = inFlight.size;
              const query = QUERIES[index % QUERIES.length];
              const limit = REQUEST_LIMITS[index % REQUEST_LIMITS.length];
              checkedQueries.add(query);
              const expected = oracle.queries[query];
              // Latency is the real round trip measured from the actual send. It is never
              // derived from scheduledAt, so it can never go negative. Scheduling jitter is
              // recorded separately in scheduleLags.
              const sentAt = performance.now();
              try {
                const response = await fetch(
                  'http://127.0.0.1:' +
                    port +
                    '/search?q=' +
                    encodeURIComponent(query) +
                    '&limit=' +
                    limit,
                );
                const text = await response.text();
                const latency = performance.now() - sentAt;
                responseBytes += Buffer.byteLength(text);
                if (response.status !== 200) {
                  failedResponses += 1;
                } else {
                  let body = null;
                  try {
                    body = JSON.parse(text);
                  } catch {
                    body = null;
                  }
                  if (body && matchesOracle(body, expected, limit)) {
                    validated += 1;
                    successLatencies.push(latency);
                  } else {
                    mismatches += 1;
                  }
                }
              } catch {
                failedResponses += 1;
              } finally {
                completed += 1;
                inFlight.delete(index);
                settle();
              }
            },
            Math.max(0, scheduledAt - performance.now()),
          );
        }),
      );
    }

    await Promise.all(tasks);
    const durationMs = performance.now() - phaseStart;
    const serviceAfter = await sampleMetrics(label + '-after');
    const generatorCpu = process.cpuUsage(generatorCpuStart);
    const generatorMemoryEnd = process.memoryUsage();
    const eventLoopLag = stopLagMonitor();

    const errors = mismatches + failedResponses;
    const droppedFraction = offered > 0 ? dropped / offered : 0;
    const generatorCpuMs = (generatorCpu.user + generatorCpu.system) / 1000;
    const meanMs = successLatencies.length
      ? successLatencies.reduce((total, value) => total + value, 0) / successLatencies.length
      : 0;

    return {
      label,
      arrivalModel: plan.arrivalModel,
      arrivalRatePerSecond: plan.arrivalRatePerSecond,
      phaseMs,
      offered,
      started,
      completed,
      dropped,
      errors,
      errorRate: completed > 0 ? errors / completed : 0,
      p50Ms: percentile(successLatencies, 0.5),
      p95Ms: percentile(successLatencies, 0.95),
      p99Ms: percentile(successLatencies, 0.99),
      minMs: successLatencies.length ? Math.min(...successLatencies) : 0,
      maxMs: successLatencies.length ? Math.max(...successLatencies) : 0,
      meanMs,
      throughputRequestsPerSecond: durationMs > 0 ? completed / (durationMs / 1000) : 0,
      durationMs,
      latencySamplesMs: successLatencies,
      responseBytes,
      saturation: {
        maxInFlight,
        maxConcurrentServiceRequests: serviceAfter.requests?.maxConcurrentRequests ?? 0,
        scheduleLagMs: {
          max: scheduleLags.length ? Math.max(...scheduleLags) : 0,
          p95: percentile(scheduleLags, 0.95),
        },
        schedulingBasis: 'phaseStart + index * (1000 / arrivalRatePerSecond)',
        dispatchIndependentOfResponseTime: true,
      },
      correctness: {
        validated,
        mismatches,
        failedResponses,
        completed,
        checkedQueries: checkedQueries.size,
        oracleMatched: mismatches === 0 && failedResponses === 0 && validated > 0,
        oracleFingerprint: sha(oracleText),
      },
      resources: {
        service: {
          pid: serviceAfter.pid,
          cpuUserMicros: serviceAfter.cpuUserMicros - serviceBefore.cpuUserMicros,
          cpuSystemMicros: serviceAfter.cpuSystemMicros - serviceBefore.cpuSystemMicros,
          rssBytes: serviceAfter.rssBytes,
          heapUsedBytes: serviceAfter.heapUsedBytes,
          externalBytes: serviceAfter.externalBytes,
          rssDeltaBytes: serviceAfter.rssBytes - serviceBefore.rssBytes,
          uptimeMs: serviceAfter.uptimeMs,
          totalRequests: serviceAfter.requests?.totalRequests ?? 0,
          maxConcurrentRequests: serviceAfter.requests?.maxConcurrentRequests ?? 0,
        },
        generator: {
          pid: process.pid,
          cpuUserMicros: generatorCpu.user,
          cpuSystemMicros: generatorCpu.system,
          cpuUtilizationPercent: durationMs > 0 ? (generatorCpuMs / durationMs) * 100 : 0,
          rssBytes: generatorMemoryEnd.rss,
          heapUsedBytes: generatorMemoryEnd.heapUsed,
          externalBytes: generatorMemoryEnd.external,
          rssDeltaBytes: generatorMemoryEnd.rss - generatorMemoryStart.rss,
          eventLoopLagMs: eventLoopLag,
          droppedFraction,
          maxDroppedFraction: plan.maxDroppedFraction,
          generatorLimited: droppedFraction > plan.maxDroppedFraction,
        },
      },
      identityFingerprint,
    };
  };

  const warmupPhase = await runPhase('warmup', plan.warmupMs);
  const repetitions = [];
  for (let index = 0; index < plan.repetitions; index += 1) {
    const phase = await runPhase('measured-' + (index + 1), plan.measuredMs);
    const rawPath =
      'evaluation/performance-testing-scenario-1-repetition-' + (index + 1) + '.json';
    const record = { ...phase, index: index + 1, rawArtifact: rawPath };
    mkdirSync(dirname(resolve(root, rawPath)), { recursive: true });
    await Bun.write(
      resolve(root, rawPath),
      JSON.stringify(
        {
          schemaVersion: 1,
          scenarioId: SCENARIO_ID,
          receipt,
          repetitionIndex: index + 1,
          identityFingerprint,
          record,
        },
        null,
        2,
      ) + '\\n',
    );
    rawArtifacts.push(rawPath);
    repetitions.push(record);
  }

  const generatorLimited = repetitions.some(
    (repetition) => repetition.resources.generator.generatorLimited,
  );
  const result = {
    schemaVersion: 1,
    scenarioId: SCENARIO_ID,
    evidenceKind: 'evaluator-owned-open-model-load-runtime',
    receipt,
    plan: {
      arrivalModel: plan.arrivalModel,
      arrivalRatePerSecond: plan.arrivalRatePerSecond,
      warmupMs: plan.warmupMs,
      repetitions: plan.repetitions,
      measuredMs: plan.measuredMs,
      maxDroppedFraction: plan.maxDroppedFraction,
      validateCorrectness: plan.validateCorrectness,
      reportGeneratorHeadroom: plan.reportGeneratorHeadroom,
      separateProcessResources: plan.separateProcessResources,
      notes: typeof plan.notes === 'string' ? plan.notes : '',
    },
    identity,
    identityFingerprint,
    service: {
      pid: servicePid,
      port,
      datasetRecords: ready.datasetRecords ?? identity.datasetRecords,
      datasetFingerprint: ready.datasetFingerprint ?? '',
      indexBuildMs: ready.indexBuildMs ?? 0,
    },
    generator: { pid: process.pid },
    warmup: { ...warmupPhase, discarded: true },
    repetitions,
    rawArtifacts,
    generatorHeadroom: {
      generatorLimited,
      maxDroppedFraction: plan.maxDroppedFraction,
      worstDroppedFraction: Math.max(
        ...repetitions.map((repetition) => repetition.resources.generator.droppedFraction),
      ),
      maxEventLoopLagMs: Math.max(
        ...repetitions.map((repetition) => repetition.resources.generator.eventLoopLagMs.max),
      ),
      maxGeneratorCpuUtilizationPercent: Math.max(
        ...repetitions.map((repetition) => repetition.resources.generator.cpuUtilizationPercent),
      ),
      note: generatorLimited
        ? 'Load generator was saturated: the dropped-iteration fraction exceeded maxDroppedFraction, so this run is generator-limited and must not be attributed to the service under test.'
        : 'Load generator sustained the requested open arrival rate; the dropped-iteration fraction stayed within maxDroppedFraction, so the measured latency belongs to the service under test.',
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, JSON.stringify(result, null, 2) + '\\n');
  process.stdout.write(
    JSON.stringify({ ok: true, output: outputArg, repetitions: repetitions.length }) + '\\n',
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const stderr = childStderr.trim().slice(-2_000);
  throw new Error('load harness failed: ' + detail + (stderr ? ' | service stderr: ' + stderr : ''));
} finally {
  clearTimeout(killTimer);
  try {
    child.kill('SIGKILL');
  } catch {
    /* the child already exited */
  }
}`;

const ORACLE = JSON.parse(ORACLE_JSON) as { limit: number; queries: Record<string, unknown> };
const ORACLE_QUERY_COUNT = Object.keys(ORACLE.queries).length;

const FIXED_FILES: Readonly<Record<string, string>> = {
  'package.json': packageJson('kory-performance-testing-load', {}),
  'src/service.ts': SERVICE_SOURCE,
  'corpus/dataset.js': DATASET_SOURCE,
  'corpus/oracle.json': ORACLE_JSON,
  'harness/reference-search.mjs': REFERENCE_SEARCH_SOURCE,
  'harness/service-runner.mjs': SERVICE_RUNNER_SOURCE,
  'harness/load-core.mjs': LOAD_CORE_SOURCE,
};

interface LoadPlan {
  arrivalModel?: string;
  arrivalRatePerSecond?: number;
  warmupMs?: number;
  repetitions?: number;
  measuredMs?: number;
  maxDroppedFraction?: number;
  validateCorrectness?: boolean;
  reportGeneratorHeadroom?: boolean;
  separateProcessResources?: boolean;
  notes?: string;
}

interface LoadPhaseResult {
  index?: number;
  label?: string;
  arrivalModel?: string;
  arrivalRatePerSecond?: number;
  phaseMs?: number;
  offered?: number;
  started?: number;
  completed?: number;
  dropped?: number;
  errors?: number;
  errorRate?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  minMs?: number;
  maxMs?: number;
  meanMs?: number;
  throughputRequestsPerSecond?: number;
  durationMs?: number;
  latencySamplesMs?: number[];
  responseBytes?: number;
  saturation?: {
    maxInFlight?: number;
    maxConcurrentServiceRequests?: number;
    scheduleLagMs?: { max?: number; p95?: number };
    schedulingBasis?: string;
    dispatchIndependentOfResponseTime?: boolean;
  };
  correctness?: {
    validated?: number;
    mismatches?: number;
    failedResponses?: number;
    completed?: number;
    checkedQueries?: number;
    oracleMatched?: boolean;
    oracleFingerprint?: string;
  };
  resources?: {
    service?: {
      pid?: number;
      cpuUserMicros?: number;
      cpuSystemMicros?: number;
      rssBytes?: number;
      heapUsedBytes?: number;
      externalBytes?: number;
      rssDeltaBytes?: number;
      uptimeMs?: number;
      totalRequests?: number;
      maxConcurrentRequests?: number;
    };
    generator?: {
      pid?: number;
      cpuUserMicros?: number;
      cpuSystemMicros?: number;
      cpuUtilizationPercent?: number;
      rssBytes?: number;
      heapUsedBytes?: number;
      externalBytes?: number;
      rssDeltaBytes?: number;
      eventLoopLagMs?: { max?: number; p95?: number };
      droppedFraction?: number;
      maxDroppedFraction?: number;
      generatorLimited?: boolean;
    };
  };
  identityFingerprint?: string;
  rawArtifact?: string;
}

interface LoadResult {
  schemaVersion?: number;
  scenarioId?: string;
  evidenceKind?: string;
  receipt?: string;
  plan?: LoadPlan;
  identity?: {
    runtime?: string;
    runtimeVersion?: string;
    platform?: string;
    architecture?: string;
    cpuModel?: string;
    cpuCount?: number;
    osRelease?: string;
    harnessVersion?: string;
    datasetRecords?: number;
    datasetFingerprint?: string;
    datasetSourceFingerprint?: string;
    oracleFingerprint?: string;
    serviceImageFingerprint?: string;
    serviceRunnerFingerprint?: string;
    loadCoreFingerprint?: string;
    referenceSearchFingerprint?: string;
  };
  identityFingerprint?: string;
  service?: { pid?: number; port?: number; datasetRecords?: number; datasetFingerprint?: string };
  generator?: { pid?: number };
  warmup?: LoadPhaseResult & { discarded?: boolean };
  repetitions?: LoadPhaseResult[];
  rawArtifacts?: string[];
  generatorHeadroom?: {
    generatorLimited?: boolean;
    maxDroppedFraction?: number;
    worstDroppedFraction?: number;
    maxEventLoopLagMs?: number;
    maxGeneratorCpuUtilizationPercent?: number;
    note?: string;
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function bounded(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function fixedFilesIntact(root: string): boolean {
  try {
    return Object.entries(FIXED_FILES).every(
      ([path, content]) => readFixtureText(root, path) === content,
    );
  } catch {
    return false;
  }
}

function planDiagnostic(plan: LoadPlan | null): string | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return 'load-plan.json is missing or is not a JSON object.';
  }
  if (plan.arrivalModel !== 'open') {
    return 'Load plan must model arrivals independently of response time (arrivalModel: "open"); a closed or fixed-concurrency model hides coordinated omission.';
  }
  if (!Number.isFinite(plan.arrivalRatePerSecond)) {
    return 'Load plan must set a finite numeric arrivalRatePerSecond.';
  }
  if (
    !bounded(
      plan.arrivalRatePerSecond,
      BOUNDS.minArrivalRatePerSecond,
      BOUNDS.maxArrivalRatePerSecond,
    )
  ) {
    return `Load plan arrivalRatePerSecond must be within [${BOUNDS.minArrivalRatePerSecond}, ${BOUNDS.maxArrivalRatePerSecond}].`;
  }
  if (plan.arrivalRatePerSecond !== BOUNDS.requiredArrivalRatePerSecond) {
    return `Load plan must model exactly ${BOUNDS.requiredArrivalRatePerSecond} new requests/second independent of response time, received ${plan.arrivalRatePerSecond}.`;
  }
  if (!bounded(plan.warmupMs, BOUNDS.minWarmupMs, BOUNDS.maxWarmupMs)) {
    return `Load plan must separate a discarded warmup phase of [${BOUNDS.minWarmupMs}, ${BOUNDS.maxWarmupMs}] ms before the measured repetitions.`;
  }
  if (!bounded(plan.measuredMs, BOUNDS.minMeasuredMs, BOUNDS.maxMeasuredMs)) {
    return `Load plan measuredMs must be within [${BOUNDS.minMeasuredMs}, ${BOUNDS.maxMeasuredMs}] ms.`;
  }
  if (plan.repetitions !== BOUNDS.requiredRepetitions) {
    return `Load plan must request exactly ${BOUNDS.requiredRepetitions} measured repetitions, received ${String(plan.repetitions)}.`;
  }
  if (
    !bounded(plan.maxDroppedFraction, BOUNDS.minMaxDroppedFraction, BOUNDS.maxMaxDroppedFraction)
  ) {
    return `Load plan maxDroppedFraction must be within [${BOUNDS.minMaxDroppedFraction}, ${BOUNDS.maxMaxDroppedFraction}].`;
  }
  if (plan.validateCorrectness !== true) {
    return 'Load plan must enable independent response validation under load (validateCorrectness: true).';
  }
  if (plan.reportGeneratorHeadroom !== true) {
    return 'Load plan must record load-generator headroom so client saturation is not mistaken for service saturation (reportGeneratorHeadroom: true).';
  }
  if (plan.separateProcessResources !== true) {
    return 'Load plan must separate service and load-generator resource accounting (separateProcessResources: true).';
  }
  return null;
}

function fail(message: string, integrityFailure = false): SkillEvalDeterministicScore {
  return { passed: false, quality: 0, verification: 0, integrityFailure, evidence: [message] };
}

export const PERFORMANCE_TESTING_LOAD_VALID_PLAN: LoadPlan = {
  arrivalModel: 'open',
  arrivalRatePerSecond: 300,
  warmupMs: 600,
  repetitions: 3,
  measuredMs: 1_000,
  maxDroppedFraction: 0.05,
  validateCorrectness: true,
  reportGeneratorHeadroom: true,
  separateProcessResources: true,
  notes:
    'Open arrival-rate model: 300 new requests/second are scheduled independently of response time. A 600 ms warmup phase is discarded before three 1000 ms measured repetitions. Every response is validated against the fixed 1M-record oracle. Load-generator CPU, event-loop lag and dropped-iteration headroom are recorded, and service and generator resources are accounted separately.',
};

// Plausible but methodologically wrong: every field is present and in bounds, but a closed
// fixed-concurrency model couples dispatch to response time, so it cannot expose coordinated
// omission. It must fail on the substantive open-model protocol check.
export const PERFORMANCE_TESTING_LOAD_FAULTY_PLAN: LoadPlan = {
  ...PERFORMANCE_TESTING_LOAD_VALID_PLAN,
  arrivalModel: 'closed',
  notes:
    'Runs a fixed pool of 50 virtual users with a 100 ms think time between iterations, which is a closed-loop workload.',
};

const STARTER_PLAN: LoadPlan = {
  arrivalModel: 'closed',
  arrivalRatePerSecond: 0,
  warmupMs: 0,
  repetitions: 1,
  measuredMs: 0,
  maxDroppedFraction: 1,
  validateCorrectness: false,
  reportGeneratorHeadroom: false,
  separateProcessResources: false,
  notes: '',
};

async function scoreLoadTest(root: string): Promise<SkillEvalDeterministicScore> {
  if (!fixedFilesIntact(root)) {
    return fail(
      'Fixed 1M-record dataset, oracle, service, reference search, or evaluator load harness was changed or replaced.',
      true,
    );
  }
  const plan = readJsonArtifact<LoadPlan>(root, 'load-plan.json');
  const diagnostic = planDiagnostic(plan);
  if (diagnostic) return fail(diagnostic);

  const receipt = `KORY_PERF_LOAD_${randomUUID().replaceAll('-', '')}`;
  const run = spawnSync(
    process.execPath,
    ['run', '--no-env-file', 'harness/load-core.mjs', 'load-plan.json', RESULT_ARTIFACT],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        NO_COLOR: '1',
        TERM: 'dumb',
        KORY_PERF_LOAD_RECEIPT: receipt,
      },
      encoding: 'utf8',
      timeout: LOAD_RUN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 8_000_000,
    },
  );
  if (run.error || run.status !== 0) {
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().slice(-3_000);
    const reason = run.error?.message ?? `exit ${String(run.status)} signal ${String(run.signal)}`;
    return fail(`Bounded open-model load run failed: ${reason}${output ? `\n${output}` : ''}`);
  }
  if (!fixedFilesIntact(root)) {
    return fail('Evaluator-owned load inputs changed during execution.', true);
  }
  const result = readJsonArtifact<LoadResult>(root, RESULT_ARTIFACT);
  if (!result) {
    return fail('Evaluator load run did not produce a machine-readable result artifact.');
  }
  if (
    result.schemaVersion !== 1 ||
    result.scenarioId !== SCENARIO_ID ||
    result.receipt !== receipt
  ) {
    return fail(
      'Machine-readable load result is missing its evaluator receipt, scenario id, or schema version.',
    );
  }

  const repetitions = result.repetitions ?? [];
  const servicePid = result.service?.pid;
  const generatorPid = result.generator?.pid;
  const warmupMs = plan!.warmupMs!;
  const measuredMs = plan!.measuredMs!;
  const maxDroppedFraction = plan!.maxDroppedFraction!;

  const openModel =
    repetitions.length === BOUNDS.requiredRepetitions &&
    repetitions.every((item, index) => {
      const expectedOffered = Math.round((item.arrivalRatePerSecond! * item.phaseMs!) / 1000);
      return (
        item.index === index + 1 &&
        item.arrivalModel === 'open' &&
        item.arrivalRatePerSecond === BOUNDS.requiredArrivalRatePerSecond &&
        item.phaseMs === measuredMs &&
        typeof item.offered === 'number' &&
        Math.abs(item.offered - expectedOffered) <= 1 &&
        (item.started ?? -1) + (item.dropped ?? -1) === item.offered &&
        (item.started ?? 0) > 0 &&
        (item.dropped ?? -1) >= 0 &&
        item.saturation?.dispatchIndependentOfResponseTime === true &&
        item.saturation?.schedulingBasis === 'phaseStart + index * (1000 / arrivalRatePerSecond)' &&
        typeof item.saturation?.scheduleLagMs?.max === 'number' &&
        item.saturation.scheduleLagMs.max >= 0 &&
        typeof item.saturation?.scheduleLagMs?.p95 === 'number' &&
        item.saturation.scheduleLagMs.p95 >= 0
      );
    }) &&
    result.warmup?.discarded === true &&
    result.warmup?.arrivalRatePerSecond === BOUNDS.requiredArrivalRatePerSecond &&
    result.warmup?.offered ===
      Math.round((BOUNDS.requiredArrivalRatePerSecond * warmupMs) / 1000) &&
    (result.warmup?.started ?? -1) + (result.warmup?.dropped ?? -1) === result.warmup?.offered;

  const distribution =
    repetitions.length === BOUNDS.requiredRepetitions &&
    repetitions.every((item) => {
      const samples = item.latencySamplesMs ?? [];
      const completed = item.completed ?? 0;
      const errors = item.errors ?? 0;
      return (
        finitePositive(item.p50Ms) &&
        finitePositive(item.p95Ms) &&
        finitePositive(item.p99Ms) &&
        item.p50Ms <= item.p95Ms &&
        item.p95Ms <= item.p99Ms &&
        typeof item.minMs === 'number' &&
        item.minMs >= 0 &&
        finitePositive(item.throughputRequestsPerSecond) &&
        finitePositive(item.durationMs) &&
        finitePositive(item.completed) &&
        typeof item.errorRate === 'number' &&
        Number.isFinite(item.errorRate) &&
        item.errorRate >= 0 &&
        Math.abs(item.errorRate - errors / Math.max(completed, 1)) < 1e-9 &&
        samples.length > 0 &&
        samples.every((value) => Number.isFinite(value) && value >= 0) &&
        samples.length === item.correctness?.validated &&
        finitePositive(item.saturation?.maxInFlight) &&
        typeof item.saturation?.maxConcurrentServiceRequests === 'number' &&
        item.saturation.maxConcurrentServiceRequests >= 0
      );
    });

  const correctness =
    repetitions.length === BOUNDS.requiredRepetitions &&
    repetitions.every((item) => {
      const check = item.correctness;
      if (!check) return false;
      const mismatches = check.mismatches ?? -1;
      const failed = check.failedResponses ?? -1;
      return (
        finitePositive(check.validated) &&
        mismatches === 0 &&
        failed === 0 &&
        check.oracleMatched === true &&
        check.checkedQueries === ORACLE_QUERY_COUNT &&
        check.oracleFingerprint === sha256(ORACLE_JSON) &&
        check.completed === item.completed &&
        check.validated! + mismatches + failed === item.completed &&
        item.errors === 0
      );
    });

  const headroom =
    repetitions.length === BOUNDS.requiredRepetitions &&
    repetitions.every((item) => {
      const generator = item.resources?.generator;
      if (!generator) return false;
      const droppedFraction = generator.droppedFraction;
      return (
        typeof generator.cpuUtilizationPercent === 'number' &&
        Number.isFinite(generator.cpuUtilizationPercent) &&
        generator.cpuUtilizationPercent >= 0 &&
        typeof generator.eventLoopLagMs?.max === 'number' &&
        generator.eventLoopLagMs.max >= 0 &&
        typeof generator.eventLoopLagMs?.p95 === 'number' &&
        generator.eventLoopLagMs.p95 >= 0 &&
        typeof droppedFraction === 'number' &&
        Number.isFinite(droppedFraction) &&
        droppedFraction >= 0 &&
        generator.maxDroppedFraction === maxDroppedFraction &&
        generator.generatorLimited === droppedFraction > maxDroppedFraction
      );
    }) &&
    result.generatorHeadroom?.maxDroppedFraction === maxDroppedFraction &&
    result.generatorHeadroom?.generatorLimited ===
      repetitions.some((item) => item.resources?.generator?.generatorLimited === true) &&
    typeof result.generatorHeadroom?.note === 'string' &&
    result.generatorHeadroom.note.length > 0 &&
    (result.generatorHeadroom.generatorLimited !== true ||
      /generator/iu.test(result.generatorHeadroom.note));

  const resourceSeparation =
    Number.isInteger(servicePid) &&
    Number.isInteger(generatorPid) &&
    servicePid !== generatorPid &&
    finitePositive(result.service?.port) &&
    result.service?.datasetRecords === FIXTURE_RECORDS &&
    result.service?.datasetFingerprint === result.identity?.datasetFingerprint &&
    repetitions.length === BOUNDS.requiredRepetitions &&
    repetitions.every((item) => {
      const service = item.resources?.service;
      const generator = item.resources?.generator;
      if (!service || !generator) return false;
      return (
        service.pid === servicePid &&
        generator.pid === generatorPid &&
        typeof service.cpuUserMicros === 'number' &&
        service.cpuUserMicros >= 0 &&
        typeof service.cpuSystemMicros === 'number' &&
        service.cpuSystemMicros >= 0 &&
        service.cpuUserMicros + service.cpuSystemMicros > 0 &&
        finitePositive(service.rssBytes) &&
        finitePositive(service.heapUsedBytes) &&
        Number.isFinite(service.externalBytes) &&
        Number.isFinite(service.rssDeltaBytes) &&
        typeof service.maxConcurrentRequests === 'number' &&
        service.maxConcurrentRequests >= 1 &&
        typeof service.totalRequests === 'number' &&
        Math.abs(service.totalRequests - (item.started ?? 0)) <= 1 &&
        typeof generator.cpuUserMicros === 'number' &&
        generator.cpuUserMicros >= 0 &&
        generator.cpuUserMicros + (generator.cpuSystemMicros ?? 0) > 0 &&
        finitePositive(generator.rssBytes) &&
        Number.isFinite(generator.rssDeltaBytes)
      );
    });

  const rawArtifacts = result.rawArtifacts ?? [];
  const rawPreserved =
    rawArtifacts.length === BOUNDS.requiredRepetitions &&
    rawArtifacts.every((path, index) => {
      const raw = readJsonArtifact<{
        schemaVersion?: number;
        scenarioId?: string;
        receipt?: string;
        repetitionIndex?: number;
        identityFingerprint?: string;
        record?: LoadPhaseResult;
      }>(root, path);
      return (
        raw !== null &&
        raw.schemaVersion === 1 &&
        raw.scenarioId === SCENARIO_ID &&
        raw.receipt === receipt &&
        raw.repetitionIndex === index + 1 &&
        raw.identityFingerprint === result.identityFingerprint &&
        raw.record?.offered === repetitions[index]?.offered &&
        raw.record?.completed === repetitions[index]?.completed
      );
    });

  const identity = result.identity;
  const identityStable =
    typeof result.identityFingerprint === 'string' &&
    result.identityFingerprint.length === 64 &&
    identity !== undefined &&
    identity.runtime === 'Bun' &&
    identity.runtimeVersion === Bun.version &&
    identity.platform === hostOS() &&
    identity.architecture === process.arch &&
    identity.cpuModel === (cpus()[0]?.model ?? 'unknown') &&
    identity.osRelease === release() &&
    identity.harnessVersion === HARNESS_VERSION &&
    identity.datasetRecords === FIXTURE_RECORDS &&
    typeof identity.datasetFingerprint === 'string' &&
    identity.datasetFingerprint.length === 64 &&
    identity.datasetSourceFingerprint === sha256(DATASET_SOURCE) &&
    identity.oracleFingerprint === sha256(ORACLE_JSON) &&
    identity.serviceImageFingerprint === sha256(SERVICE_SOURCE) &&
    identity.serviceRunnerFingerprint === sha256(SERVICE_RUNNER_SOURCE) &&
    identity.loadCoreFingerprint === sha256(LOAD_CORE_SOURCE) &&
    identity.referenceSearchFingerprint === sha256(REFERENCE_SEARCH_SOURCE) &&
    repetitions.every((item) => item.identityFingerprint === result.identityFingerprint);

  const checks = [
    ['fixed evaluator inputs intact before and after the run', fixedFilesIntact(root)],
    [
      'open-model 300 rps plan with separate warmup and three bounded repetitions',
      planDiagnostic(plan) === null,
    ],
    [
      'evaluator receipt and machine-readable result',
      result.schemaVersion === 1 && result.scenarioId === SCENARIO_ID && result.receipt === receipt,
    ],
    ['open arrival-rate schedule independent of response duration', openModel],
    ['per-repetition latency distribution, throughput and error rate', distribution],
    ['response correctness validated against the fixed oracle', correctness],
    ['load-generator headroom and dropped-iteration attribution', headroom],
    ['service and generator resource separation', resourceSeparation],
    ['three preserved raw repetitions with stable identity', rawPreserved && identityStable],
  ] as const;
  const passed = checks.every(([, ok]) => ok);
  const firstFailure = checks.find(([, ok]) => !ok);
  const summary = repetitions.map((item) => ({
    index: item.index,
    offered: item.offered,
    started: item.started,
    completed: item.completed,
    dropped: item.dropped,
    errors: item.errors,
    p50Ms: item.p50Ms,
    p95Ms: item.p95Ms,
    p99Ms: item.p99Ms,
    throughputRequestsPerSecond: item.throughputRequestsPerSecond,
    serviceCpuMicros: item.resources?.service?.cpuUserMicros,
    generatorCpuUtilizationPercent: item.resources?.generator?.cpuUtilizationPercent,
    droppedFraction: item.resources?.generator?.droppedFraction,
    generatorLimited: item.resources?.generator?.generatorLimited,
  }));
  const verification = {
    schemaVersion: 1,
    scenarioId: SCENARIO_ID,
    evidenceKind: 'evaluator-owned-open-model-load-verification',
    receipt,
    integrity: {
      fixedInputsVerified: true,
      receiptsVerified: true,
      datasetSourceFingerprint: sha256(DATASET_SOURCE),
      oracleFingerprint: sha256(ORACLE_JSON),
      serviceImageFingerprint: sha256(SERVICE_SOURCE),
      serviceRunnerFingerprint: sha256(SERVICE_RUNNER_SOURCE),
      loadCoreFingerprint: sha256(LOAD_CORE_SOURCE),
      referenceSearchFingerprint: sha256(REFERENCE_SEARCH_SOURCE),
    },
    protocol: {
      arrivalModel: 'open',
      arrivalRatePerSecond: BOUNDS.requiredArrivalRatePerSecond,
      warmupMs,
      measuredMs,
      repetitions: BOUNDS.requiredRepetitions,
      maxDroppedFraction,
      datasetRecords: FIXTURE_RECORDS,
      boundedRunTimeoutMs: LOAD_RUN_TIMEOUT_MS,
    },
    identity: result.identity,
    identityFingerprint: result.identityFingerprint,
    service: result.service,
    generator: result.generator,
    generatorHeadroom: result.generatorHeadroom,
    repetitions: summary,
    checks: Object.fromEntries(checks),
    passed,
  };
  try {
    writeFixtureFile(root, VERIFICATION_ARTIFACT, `${JSON.stringify(verification, null, 2)}\n`);
  } catch (error) {
    return fail(
      `Unable to persist evaluator-owned load verification: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  return {
    passed,
    quality: checks.filter(([, ok]) => ok).length / checks.length,
    verification: passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      RESULT_ARTIFACT,
      VERIFICATION_ARTIFACT,
      `Evaluator receipt verified; bounded local run completed within ${LOAD_RUN_TIMEOUT_MS} ms.`,
      ...checks.map(([name, ok]) => `${name}: ${ok ? 'pass' : 'fail'}`),
      ...(firstFailure && !firstFailure[1] ? [`First failing check: ${firstFailure[0]}.`] : []),
      `service pid ${String(servicePid)} vs generator pid ${String(generatorPid)}; offered/started/completed/dropped per repetition: ${summary
        .map(
          (item) =>
            `${String(item.offered)}/${String(item.started)}/${String(item.completed)}/${String(item.dropped)}`,
        )
        .join(', ')}`,
      `p95 ms per repetition: ${summary.map((item) => (item.p95Ms ?? 0).toFixed(3)).join(', ')}; throughput rps per repetition: ${summary
        .map((item) => (item.throughputRequestsPerSecond ?? 0).toFixed(1))
        .join(', ')}`,
      `generator dropped fraction: ${summary.map((item) => (item.droppedFraction ?? 0).toFixed(4)).join(', ')}; generator-limited: ${String(result.generatorHeadroom?.generatorLimited)}`,
      'The evaluator owns the fixed service, the 1M-record dataset and oracle, the open arrival schedule, the correctness validation, and both resource accounts. Candidate-authored measurements are not read.',
    ],
  };
}

export const PERFORMANCE_TESTING_LOAD_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [
    {
      id: 'performance-testing/open-model-load-plan@1',
      realRuntime: true,
      matches: (scenario) => scenario.id === SCENARIO_ID,
      materialize: (root) => {
        for (const [path, content] of Object.entries(FIXED_FILES)) {
          writeFixtureFile(root, path, content);
        }
        writeFixtureFile(root, 'load-plan.json', `${JSON.stringify(STARTER_PLAN, null, 2)}\n`);
        writeFixtureFile(
          root,
          'README.md',
          '# Open-model performance test for an HTTP search API\n\nProduct traffic is 300 new search requests per second, independent of response time. `src/service.ts`, `corpus/dataset.js` (the fixed deterministic 1M-record corpus), `corpus/oracle.json`, and everything under `harness/` are evaluator-owned and must not be edited.\n\nYour only deliverable is `load-plan.json`. A valid plan must express an `arrivalModel` of `"open"`, `arrivalRatePerSecond` of exactly 300, a discarded `warmupMs` in [500, 3000], exactly `repetitions` of 3 with `measuredMs` in [1000, 3000], a `maxDroppedFraction` in [0, 0.5], and `validateCorrectness`, `reportGeneratorHeadroom`, and `separateProcessResources` all `true`. Out-of-bounds values are rejected by both the evaluator scorer and the load harness.\n\nThe evaluator boots the fixed service in its own child process, schedules every iteration at `phaseStart + index * (1000 / arrivalRatePerSecond)` regardless of response duration, validates every response against the fixed oracle, and records service and load-generator resources separately. Do not diagnose a regression and do not issue a release pass/fail budget verdict in this task.\n',
        );
      },
    },
  ];

export const PERFORMANCE_TESTING_LOAD_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] =
  [
    {
      id: 'performance-testing/open-model-load-plan-scorer@1',
      scenarioIds: [SCENARIO_ID],
      score: ({ workingDirectory }) => scoreLoadTest(workingDirectory),
    },
  ];
