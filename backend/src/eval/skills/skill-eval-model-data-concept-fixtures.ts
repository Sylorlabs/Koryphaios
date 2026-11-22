import type { ConceptFixture, ConceptVector } from './skill-eval-concept-fixtures';
import { createConceptFixtures } from './skill-eval-concept-fixtures';

function detectorVectors(): ConceptVector[] {
  return [
    {
      name: 'group and duplicate leakage removed before detector comparison',
      input: {
        trainGroups: ['cam1:s1'],
        samples: [
          {
            id: 'a',
            group: 'cam1:s1',
            duplicateOf: null,
            truth: true,
            predicted: true,
            slice: 'bright',
          },
          {
            id: 'b',
            group: 'cam2:s2',
            duplicateOf: null,
            truth: true,
            predicted: true,
            slice: 'blur',
          },
          {
            id: 'c',
            group: 'cam2:s2',
            duplicateOf: 'b',
            truth: true,
            predicted: true,
            slice: 'blur',
          },
          {
            id: 'd',
            group: 'cam3:s3',
            duplicateOf: null,
            truth: false,
            predicted: true,
            slice: 'dark',
          },
          {
            id: 'e',
            group: 'cam4:s4',
            duplicateOf: null,
            truth: false,
            predicted: false,
            slice: 'bright',
          },
        ],
        latencyMs: 18,
        memoryMb: 420,
        latencyBudgetMs: 25,
        memoryBudgetMb: 512,
      },
      expected: {
        eligibleIds: ['b', 'd', 'e'],
        leakageIds: ['a', 'c'],
        precision: 0.5,
        recall: 1,
        runtimeReady: true,
      },
    },
    {
      name: 'runtime budget blocks rollout even with perfect eligible predictions',
      input: {
        trainGroups: [],
        samples: [
          { id: 'x', group: 'g1', duplicateOf: null, truth: true, predicted: true, slice: 'tiny' },
        ],
        latencyMs: 30,
        memoryMb: 300,
        latencyBudgetMs: 20,
        memoryBudgetMb: 512,
      },
      expected: {
        eligibleIds: ['x'],
        leakageIds: [],
        precision: 1,
        recall: 1,
        runtimeReady: false,
      },
    },
  ];
}

function segmentationVectors(): ConceptVector[] {
  return [
    {
      name: 'uncertain pixels excluded and duplicate crop withheld',
      input: {
        trainParents: ['p1'],
        samples: [
          {
            id: 'a',
            parent: 'p1',
            duplicateOf: null,
            truth: [1, 1, 0, 0],
            pred: [1, 1, 0, 0],
            uncertain: [false, false, false, false],
            tiny: true,
          },
          {
            id: 'b',
            parent: 'p2',
            duplicateOf: null,
            truth: [1, 0, 0, 0],
            pred: [1, 1, 0, 0],
            uncertain: [false, false, true, false],
            tiny: true,
          },
          {
            id: 'c',
            parent: 'p3',
            duplicateOf: 'b',
            truth: [1, 0, 0, 0],
            pred: [1, 0, 0, 0],
            uncertain: [false, false, false, false],
            tiny: false,
          },
        ],
        exportLatencyMs: 12,
        latencyBudgetMs: 15,
      },
      expected: {
        eligibleIds: ['b'],
        leakageIds: ['a', 'c'],
        iou: 0.5,
        tinyRecall: 1,
        runtimeReady: true,
      },
    },
    {
      name: 'uncertain positive cannot inflate or punish IoU denominator',
      input: {
        trainParents: [],
        samples: [
          {
            id: 'x',
            parent: 'p9',
            duplicateOf: null,
            truth: [1, 1, 0],
            pred: [1, 0, 0],
            uncertain: [false, true, false],
            tiny: false,
          },
        ],
        exportLatencyMs: 20,
        latencyBudgetMs: 10,
      },
      expected: { eligibleIds: ['x'], leakageIds: [], iou: 1, tinyRecall: 0, runtimeReady: false },
    },
  ];
}

function fineTuneDecisionVectors(): ConceptVector[] {
  return [
    {
      name: 'behavioral formatting failure with clean corpus and provider eligibility can pilot fine tuning',
      input: {
        failureType: 'stable-style-format',
        providerEligible: true,
        deprecated: false,
        maxTokens: 1000,
        examples: [
          {
            id: 'a',
            source: 's1',
            customer: 'c1',
            fingerprint: 'f1',
            pii: false,
            licensed: true,
            tokens: 200,
            split: 'train',
          },
          {
            id: 'b',
            source: 's2',
            customer: 'c2',
            fingerprint: 'f2',
            pii: false,
            licensed: true,
            tokens: 250,
            split: 'validation',
          },
          {
            id: 'c',
            source: 's3',
            customer: 'c3',
            fingerprint: 'f3',
            pii: false,
            licensed: true,
            tokens: 300,
            split: 'holdout',
          },
        ],
        baseline: 0.6,
        pilot: 0.78,
        latencyOk: true,
        costOk: true,
      },
      expected: {
        intervention: 'fine-tune',
        eligibleIds: ['a', 'b', 'c'],
        rejectedIds: [],
        splitLeakage: false,
        pilotReady: true,
      },
    },
    {
      name: 'current-fact failure routes to retrieval instead of training',
      input: {
        failureType: 'missing-current-facts',
        providerEligible: true,
        deprecated: false,
        maxTokens: 1000,
        examples: [],
        baseline: 0.5,
        pilot: 0.9,
        latencyOk: true,
        costOk: true,
      },
      expected: {
        intervention: 'retrieval',
        eligibleIds: [],
        rejectedIds: [],
        splitLeakage: false,
        pilotReady: false,
      },
    },
    {
      name: 'PII licensing overlength and fingerprint leakage block pilot',
      input: {
        failureType: 'stable-style-format',
        providerEligible: true,
        deprecated: false,
        maxTokens: 1000,
        examples: [
          {
            id: 'a',
            source: 's1',
            customer: 'c1',
            fingerprint: 'same',
            pii: false,
            licensed: true,
            tokens: 200,
            split: 'train',
          },
          {
            id: 'b',
            source: 's2',
            customer: 'c2',
            fingerprint: 'same',
            pii: false,
            licensed: true,
            tokens: 200,
            split: 'holdout',
          },
          {
            id: 'c',
            source: 's3',
            customer: 'c3',
            fingerprint: 'c',
            pii: true,
            licensed: true,
            tokens: 100,
            split: 'train',
          },
          {
            id: 'd',
            source: 's4',
            customer: 'c4',
            fingerprint: 'd',
            pii: false,
            licensed: false,
            tokens: 100,
            split: 'train',
          },
          {
            id: 'e',
            source: 's5',
            customer: 'c5',
            fingerprint: 'e',
            pii: false,
            licensed: true,
            tokens: 1200,
            split: 'train',
          },
        ],
        baseline: 0.6,
        pilot: 0.8,
        latencyOk: true,
        costOk: true,
      },
      expected: {
        intervention: 'fine-tune',
        eligibleIds: ['a', 'b'],
        rejectedIds: ['c', 'd', 'e'],
        splitLeakage: true,
        pilotReady: false,
      },
    },
  ];
}

function loraVectors(): ConceptVector[] {
  return [
    {
      name: 'bounded LoRA adapter with clean entity split and resume state is promotable',
      input: {
        totalParams: 1_000_000,
        trainableParams: 20_000,
        rank: 8,
        alpha: 16,
        targetModules: ['q_proj', 'v_proj'],
        allowedModules: ['q_proj', 'v_proj'],
        trainEntities: ['a', 'b'],
        validationEntities: ['c'],
        testEntities: ['d'],
        checkpoint: { step: 400, optimizer: true, peftConfig: true },
        adapterMetric: 0.81,
        baseMetric: 0.7,
        latencyMs: 30,
        latencyBudgetMs: 35,
        memoryMb: 900,
        memoryBudgetMb: 1000,
      },
      expected: {
        trainableFraction: 0.02,
        splitLeakage: false,
        resumable: true,
        targetModulesValid: true,
        promotable: true,
      },
    },
    {
      name: 'entity leakage and unsupported target module block adapter promotion',
      input: {
        totalParams: 1_000_000,
        trainableParams: 100_000,
        rank: 16,
        alpha: 32,
        targetModules: ['q_proj', 'lm_head'],
        allowedModules: ['q_proj', 'v_proj'],
        trainEntities: ['a'],
        validationEntities: ['a'],
        testEntities: ['d'],
        checkpoint: { step: 100, optimizer: false, peftConfig: true },
        adapterMetric: 0.9,
        baseMetric: 0.7,
        latencyMs: 20,
        latencyBudgetMs: 35,
        memoryMb: 800,
        memoryBudgetMb: 1000,
      },
      expected: {
        trainableFraction: 0.1,
        splitLeakage: true,
        resumable: false,
        targetModulesValid: false,
        promotable: false,
      },
    },
  ];
}

export const MODEL_DATA_CONCEPTS: readonly ConceptFixture[] = [
  {
    id: 'computer-vision-full-task-1-individual',
    skill: 'computer-vision',
    // 3: the contract named TP, FP and FN as intermediate counts without saying they are excluded
    // from the result, so a correct candidate that also reported them failed every vector on exact
    // shape. The result shape is now stated; the filtering and metrics are unchanged.
    generation: 3,
    contract: `Filter evaluation leakage before metrics. A sample leaks when group appears in trainGroups or duplicateOf references any sample id in the same corpus; keep only the first member of a duplicate family, treating duplicateOf!=null as leakage. Return eligibleIds/leakageIds in input order. Derive TP, FP, and FN from the eligible samples' boolean truth and predicted fields, then return precision=TP/(TP+FP) and recall=TP/(TP+FN), zero for an empty denominator, rounded to three decimals. runtimeReady requires latencyMs<=latencyBudgetMs and memoryMb<=memoryBudgetMb. Do not let near-duplicate burst frames cross evaluation boundaries. Return exactly {eligibleIds,leakageIds,precision,recall,runtimeReady} with no extra fields; tp, fp and fn are intermediate counts and are not part of the result.`,
    vectors: detectorVectors,
  },
  {
    id: 'computer-vision-full-task-2-individual',
    skill: 'computer-vision',
    generation: 2,
    contract: `A sample leaks when parent appears in trainParents or duplicateOf is non-null. Return eligibleIds and leakageIds in input order. For eligible samples, exclude uncertain pixels entirely. Treat truth/pred values as binary mask pixels. Aggregate intersection and union over all eligible known pixels; IoU=intersection/union or 1 when union=0. tinyRecall is true-positive tiny samples / truth-positive tiny samples using whether any known truth pixel=1 and any known predicted pixel=1; 0 if no tiny positive samples. Return exactly eligibleIds, leakageIds, iou, tinyRecall, and runtimeReady. Round metrics to three decimals. runtimeReady requires exportLatencyMs<=latencyBudgetMs.`,
    vectors: segmentationVectors,
  },
  {
    id: 'fine-tuning-training-full-task-1-individual',
    skill: 'fine-tuning-training',
    contract: `Choose intervention from measured failureType: missing-current-facts=>retrieval; deterministic-tool-action=>tools; unstable-prompt-contract=>prompting; stable-style-format=>fine-tune; otherwise product-logic. Reject examples with pii=true, licensed=false, or tokens>maxTokens. eligibleIds/rejectedIds preserve input order. splitLeakage is true when the same fingerprint or customer appears across more than one split among eligible examples. pilotReady requires intervention=fine-tune, providerEligible, not deprecated, no split leakage, pilot>baseline, latencyOk and costOk, with at least one eligible train, validation and holdout example.`,
    vectors: fineTuneDecisionVectors,
  },
  {
    id: 'fine-tuning-training-full-task-2-individual',
    skill: 'fine-tuning-training',
    contract: `trainableFraction=trainableParams/totalParams rounded to three decimals. splitLeakage is true when any entity appears in more than one of trainEntities,validationEntities,testEntities. resumable requires checkpoint.step>0, optimizer=true and peftConfig=true. targetModulesValid requires every targetModules entry in allowedModules. promotable requires no split leakage, resumable, targetModulesValid, trainableFraction<=0.1, adapterMetric>baseMetric, latencyMs<=latencyBudgetMs and memoryMb<=memoryBudgetMb.`,
    vectors: loraVectors,
  },
];

const fixtures = createConceptFixtures(MODEL_DATA_CONCEPTS);
export const MODEL_DATA_SKILL_EVAL_MATERIALIZERS = fixtures.materializers;
export const MODEL_DATA_SKILL_EVAL_SCORERS = fixtures.scorers;
