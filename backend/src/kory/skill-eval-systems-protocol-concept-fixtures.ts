import type { ConceptFixture, ConceptVector } from './skill-eval-concept-fixtures';
import { createConceptFixtures } from './skill-eval-concept-fixtures';

const r3 = (value: number) => Math.round(value * 1_000) / 1_000;

function llmAppProviderVectors(): ConceptVector[] {
  return [
    {
      name: 'primary valid envelope normalizes into product schema without fallback',
      input: {
        budget: { maxLatencyMs: 1200, maxTokens: 600 },
        primary: {
          status: 'ok',
          latencyMs: 420,
          tokens: 220,
          envelope: { output: { category: 'billing', confidence: 0.91 } },
        },
        fallback: {
          status: 'ok',
          latencyMs: 300,
          tokens: 180,
          envelope: { result: { label: 'technical', score: 0.8 } },
        },
      },
      expected: {
        category: 'billing',
        confidence: 0.91,
        provider: 'primary',
        fallbackUsed: false,
        outcome: 'route',
      },
    },
    {
      name: 'malformed primary uses normalized fallback envelope',
      input: {
        budget: { maxLatencyMs: 1200, maxTokens: 600 },
        primary: {
          status: 'ok',
          latencyMs: 300,
          tokens: 180,
          envelope: { output: { category: 7 } },
        },
        fallback: {
          status: 'ok',
          latencyMs: 500,
          tokens: 240,
          envelope: { result: { label: 'technical', score: 0.77 } },
        },
      },
      expected: {
        category: 'technical',
        confidence: 0.77,
        provider: 'fallback',
        fallbackUsed: true,
        outcome: 'route',
      },
    },
    {
      name: 'timeout plus fallback budget overflow returns bounded failure',
      input: {
        budget: { maxLatencyMs: 1000, maxTokens: 500 },
        primary: { status: 'timeout', latencyMs: 1000, tokens: 0, envelope: null },
        fallback: {
          status: 'ok',
          latencyMs: 800,
          tokens: 600,
          envelope: { result: { label: 'billing', score: 0.9 } },
        },
      },
      expected: {
        category: null,
        confidence: null,
        provider: null,
        fallbackUsed: true,
        outcome: 'budget-exceeded',
      },
    },
  ];
}

function llmAppToolVectors(): ConceptVector[] {
  return [
    {
      name: 'confirmed authorized eligible refund executes once',
      input: {
        sessionUser: 'u1',
        accountUser: 'u1',
        confirmed: true,
        order: { id: 'o1', version: 4, refundable: true, refunded: false },
        proposal: { orderId: 'o1', expectedVersion: 4, amount: 20 },
        priorReceipts: [],
      },
      expected: {
        decision: 'execute',
        idempotencyKey: 'refund:o1:4:20',
        audit: ['authorized', 'eligible', 'confirmed', 'fresh'],
        reason: null,
      },
    },
    {
      name: 'stale state blocks tool call even after confirmation',
      input: {
        sessionUser: 'u1',
        accountUser: 'u1',
        confirmed: true,
        order: { id: 'o1', version: 5, refundable: true, refunded: false },
        proposal: { orderId: 'o1', expectedVersion: 4, amount: 20 },
        priorReceipts: [],
      },
      expected: {
        decision: 'reject',
        idempotencyKey: null,
        audit: ['authorized', 'eligible', 'confirmed'],
        reason: 'stale-state',
      },
    },
    {
      name: 'duplicate prior receipt converges without second execution',
      input: {
        sessionUser: 'u2',
        accountUser: 'u2',
        confirmed: true,
        order: { id: 'o9', version: 2, refundable: true, refunded: true },
        proposal: { orderId: 'o9', expectedVersion: 2, amount: 15 },
        priorReceipts: ['refund:o9:2:15'],
      },
      expected: {
        decision: 'already-complete',
        idempotencyKey: 'refund:o9:2:15',
        audit: ['authorized', 'receipt-found'],
        reason: null,
      },
    },
    {
      name: 'cross-account proposal is rejected before eligibility',
      input: {
        sessionUser: 'u1',
        accountUser: 'u2',
        confirmed: true,
        order: { id: 'o2', version: 1, refundable: true, refunded: false },
        proposal: { orderId: 'o2', expectedVersion: 1, amount: 10 },
        priorReceipts: [],
      },
      expected: { decision: 'reject', idempotencyKey: null, audit: [], reason: 'unauthorized' },
    },
  ];
}

function mlBinaryVectors(): ConceptVector[] {
  return [
    {
      name: 'temporal and account leakage are removed before threshold evaluation',
      input: {
        cutoff: 100,
        reviewCapacity: 2,
        train: [{ id: 't1', account: 'a', fingerprint: 'x' }],
        rows: [
          { id: 'r1', account: 'b', fingerprint: 'y', time: 110, label: 1, probability: 0.9 },
          { id: 'r2', account: 'a', fingerprint: 'z', time: 120, label: 0, probability: 0.8 },
          { id: 'r3', account: 'c', fingerprint: 'x', time: 130, label: 1, probability: 0.7 },
          { id: 'r4', account: 'd', fingerprint: 'w', time: 140, label: 0, probability: 0.6 },
        ],
      },
      expected: {
        eligibleIds: ['r1', 'r4'],
        leakageIds: ['r2', 'r3'],
        reviewedIds: ['r1', 'r4'],
        precision: 0.5,
        recall: 1,
      },
    },
    {
      name: 'missing labels are excluded from denominator',
      input: {
        cutoff: 10,
        reviewCapacity: 1,
        train: [],
        rows: [
          { id: 'a', account: 'a', fingerprint: 'a', time: 11, label: null, probability: 0.99 },
          { id: 'b', account: 'b', fingerprint: 'b', time: 12, label: 1, probability: 0.8 },
        ],
      },
      expected: { eligibleIds: ['b'], leakageIds: [], reviewedIds: ['b'], precision: 1, recall: 1 },
    },
  ];
}

function mlMulticlassVectors(): ConceptVector[] {
  return [
    {
      name: 'thread duplicates are excluded and rare critical recall stays visible',
      input: {
        trainThreads: ['th1'],
        rows: [
          { id: 'a', thread: 'th1', truth: 'critical', predicted: 'critical', valid: true },
          { id: 'b', thread: 'th2', truth: 'critical', predicted: 'normal', valid: true },
          { id: 'c', thread: 'th3', truth: 'normal', predicted: 'normal', valid: true },
          { id: 'd', thread: 'th4', truth: 'billing', predicted: 'billing', valid: true },
          { id: 'e', thread: 'th5', truth: 'critical', predicted: 'critical', valid: false },
        ],
      },
      expected: {
        eligibleIds: ['b', 'c', 'd'],
        leakageIds: ['a'],
        accuracy: 0.667,
        criticalRecall: 0,
      },
    },
    {
      name: 'critical slice perfect result is preserved separately from aggregate',
      input: {
        trainThreads: [],
        rows: [
          { id: 'a', thread: '1', truth: 'critical', predicted: 'critical', valid: true },
          { id: 'b', thread: '2', truth: 'normal', predicted: 'billing', valid: true },
        ],
      },
      expected: { eligibleIds: ['a', 'b'], leakageIds: [], accuracy: 0.5, criticalRecall: 1 },
    },
  ];
}

function mlopsLineageVectors(): ConceptVector[] {
  return [
    {
      name: 'immutable lineage and healthy canary permit promotion',
      input: {
        lineage: {
          data: 'd1',
          features: 'f1',
          code: 'c1',
          env: 'e1',
          modelDigest: 'm1',
          signatureValid: true,
        },
        evaluationPassed: true,
        approved: true,
        featureParity: true,
        canary: { health: true, quality: true },
        rollbackDigest: 'm0',
      },
      expected: {
        promotable: true,
        lineageKey: 'd1|f1|c1|e1|m1',
        rollbackReady: true,
        blockers: [],
      },
    },
    {
      name: 'offline online feature mismatch blocks promotion despite good canary service health',
      input: {
        lineage: {
          data: 'd1',
          features: 'f2',
          code: 'c2',
          env: 'e1',
          modelDigest: 'm2',
          signatureValid: true,
        },
        evaluationPassed: true,
        approved: true,
        featureParity: false,
        canary: { health: true, quality: true },
        rollbackDigest: 'm1',
      },
      expected: {
        promotable: false,
        lineageKey: 'd1|f2|c2|e1|m2',
        rollbackReady: true,
        blockers: ['feature-parity'],
      },
    },
    {
      name: 'unsigned artifact and missing approval fail closed',
      input: {
        lineage: {
          data: 'd2',
          features: 'f2',
          code: 'c3',
          env: 'e2',
          modelDigest: 'm3',
          signatureValid: false,
        },
        evaluationPassed: true,
        approved: false,
        featureParity: true,
        canary: { health: true, quality: true },
        rollbackDigest: null,
      },
      expected: {
        promotable: false,
        lineageKey: 'd2|f2|c3|e2|m3',
        rollbackReady: false,
        blockers: ['approval', 'artifact-signature', 'rollback'],
      },
    },
  ];
}

function mlopsMonitoringVectors(): ConceptVector[] {
  return [
    {
      name: 'duplicate trigger does not fork a second pipeline and resume continues failed stage',
      input: {
        runId: 'r1',
        duplicateRunIds: ['r1', 'r1'],
        stages: [
          { id: 'snapshot', status: 'done' },
          { id: 'train', status: 'failed' },
          { id: 'evaluate', status: 'pending' },
        ],
        monitors: {
          health: true,
          freshness: true,
          schema: true,
          drift: true,
          delayedQuality: true,
        },
        candidatePassed: false,
      },
      expected: { canonicalRunId: 'r1', nextStage: 'train', promote: false, rollback: false },
    },
    {
      name: 'degraded production monitoring triggers rollback independent of candidate pipeline',
      input: {
        runId: 'r2',
        duplicateRunIds: ['r2'],
        stages: [
          { id: 'snapshot', status: 'done' },
          { id: 'train', status: 'done' },
          { id: 'evaluate', status: 'done' },
        ],
        monitors: {
          health: true,
          freshness: false,
          schema: true,
          drift: true,
          delayedQuality: true,
        },
        candidatePassed: true,
      },
      expected: { canonicalRunId: 'r2', nextStage: null, promote: false, rollback: true },
    },
    {
      name: 'complete healthy candidate can promote',
      input: {
        runId: 'r3',
        duplicateRunIds: ['r3'],
        stages: [
          { id: 'snapshot', status: 'done' },
          { id: 'train', status: 'done' },
          { id: 'evaluate', status: 'done' },
        ],
        monitors: {
          health: true,
          freshness: true,
          schema: true,
          drift: true,
          delayedQuality: true,
        },
        candidatePassed: true,
      },
      expected: { canonicalRunId: 'r3', nextStage: null, promote: true, rollback: false },
    },
  ];
}

function finopsAllocationVectors(): ConceptVector[] {
  return [
    {
      name: 'allocated costs reconcile to invoice and normalize by transactions',
      input: {
        invoiceTotal: 1000,
        rows: [
          { team: 'a', cost: 400, transactions: 200 },
          { team: 'b', cost: 300, transactions: 100 },
          { team: 'shared', cost: 300, transactions: 0 },
        ],
        sharedWeights: { a: 0.6, b: 0.4 },
      },
      expected: {
        reconciled: true,
        allocated: { a: 580, b: 420 },
        unitCost: { a: 2.9, b: 4.2 },
        unallocated: 0,
      },
    },
    {
      name: 'missing allocation weights remain unallocated rather than disappearing',
      input: {
        invoiceTotal: 500,
        rows: [
          { team: 'a', cost: 200, transactions: 100 },
          { team: 'shared', cost: 300, transactions: 0 },
        ],
        sharedWeights: {},
      },
      expected: { reconciled: true, allocated: { a: 200 }, unitCost: { a: 2 }, unallocated: 300 },
    },
  ];
}

function finopsCommitmentVectors(): ConceptVector[] {
  return [
    {
      name: 'commitment is bounded by stable eligible spend and utilization guardrail',
      input: {
        hourlyEligible: [100, 110, 90, 105],
        proposedHourlyCommit: 80,
        utilizationFloor: 0.8,
        cashAllowed: true,
        migrationRisk: false,
      },
      expected: { maxSafeCommit: 72, purchaseAllowed: false, reasons: ['proposed-above-safe'] },
    },
    {
      name: 'cash or migration constraints can block otherwise covered purchase',
      input: {
        hourlyEligible: [100, 100, 100],
        proposedHourlyCommit: 60,
        utilizationFloor: 0.8,
        cashAllowed: false,
        migrationRisk: true,
      },
      expected: {
        maxSafeCommit: 80,
        purchaseAllowed: false,
        reasons: ['cash-constraint', 'migration-risk'],
      },
    },
    {
      name: 'bounded commitment passes all guardrails',
      input: {
        hourlyEligible: [100, 120, 110],
        proposedHourlyCommit: 70,
        utilizationFloor: 0.8,
        cashAllowed: true,
        migrationRisk: false,
      },
      expected: { maxSafeCommit: 80, purchaseAllowed: true, reasons: [] },
    },
  ];
}

function emailAlignmentVectors(): ConceptVector[] {
  return [
    {
      name: 'aligned auth with provider-specific junking points to reputation experiment before DNS mutation',
      input: {
        spfAligned: true,
        dkimAligned: true,
        dmarcPass: true,
        gmailPlacement: 'inbox',
        microsoftPlacement: 'junk',
        complaintRate: 0.001,
        hardBounceRate: 0.002,
        volumeJump: 8,
      },
      expected: {
        authProblem: false,
        likelyFocus: ['provider-reputation', 'warm-up'],
        experiment: 'controlled-seed-and-volume-ramp',
      },
    },
    {
      name: 'DMARC alignment failure is authentication evidence not a reputation guess',
      input: {
        spfAligned: false,
        dkimAligned: false,
        dmarcPass: false,
        gmailPlacement: 'spam',
        microsoftPlacement: 'junk',
        complaintRate: 0,
        hardBounceRate: 0,
        volumeJump: 1,
      },
      expected: {
        authProblem: true,
        likelyFocus: ['alignment'],
        experiment: 'header-alignment-control',
      },
    },
  ];
}

function emailSuppressionVectors(): ConceptVector[] {
  return [
    {
      name: 'hard bounce suppresses regardless of later duplicate soft bounce',
      input: {
        events: [
          { id: 'e1', address: 'a@x', kind: 'hard', at: 20 },
          { id: 'e2', address: 'a@x', kind: 'soft', at: 10 },
          { id: 'e1', address: 'a@x', kind: 'hard', at: 20 },
        ],
        actions: [],
      },
      expected: { suppressed: ['a@x'], sendable: [], auditIds: ['e2', 'e1'] },
    },
    {
      name: 'explicit corrected-address unsuppression does not clear old address history',
      input: {
        events: [{ id: 'e1', address: 'old@x', kind: 'hard', at: 1 }],
        actions: [
          { type: 'correct', from: 'old@x', to: 'new@x' },
          { type: 'unsuppress', address: 'new@x' },
        ],
      },
      expected: { suppressed: ['old@x'], sendable: ['new@x'], auditIds: ['e1'] },
    },
  ];
}

function paymentAttemptVectors(): ConceptVector[] {
  return [
    {
      name: 'lost response keeps one logical provider identity and reconciles accepted charge',
      input: {
        orderId: 'o1',
        prior: null,
        attempt: { providerOutcome: 'accepted-response-lost', providerId: 'p1' },
        webhook: null,
        restart: true,
      },
      expected: {
        idempotencyKey: 'payment:o1',
        providerCalls: 1,
        state: 'reconcile',
        capturedCharges: 1,
        providerId: 'p1',
      },
    },
    {
      name: 'duplicate submit reuses existing provider payment',
      input: {
        orderId: 'o1',
        prior: { providerId: 'p1', state: 'captured' },
        attempt: { providerOutcome: 'accepted', providerId: 'p2' },
        webhook: null,
        restart: false,
      },
      expected: {
        idempotencyKey: 'payment:o1',
        providerCalls: 0,
        state: 'captured',
        capturedCharges: 1,
        providerId: 'p1',
      },
    },
    {
      name: 'decline remains terminal unless later authoritative success exists',
      input: {
        orderId: 'o2',
        prior: null,
        attempt: { providerOutcome: 'declined', providerId: 'p9' },
        webhook: null,
        restart: false,
      },
      expected: {
        idempotencyKey: 'payment:o2',
        providerCalls: 1,
        state: 'declined',
        capturedCharges: 0,
        providerId: 'p9',
      },
    },
    {
      name: 'late success webhook converges ambiguous local state',
      input: {
        orderId: 'o3',
        prior: { providerId: 'p3', state: 'reconcile' },
        attempt: null,
        webhook: { providerId: 'p3', state: 'captured' },
        restart: false,
      },
      expected: {
        idempotencyKey: 'payment:o3',
        providerCalls: 0,
        state: 'captured',
        capturedCharges: 1,
        providerId: 'p3',
      },
    },
  ];
}

function paymentEventVectors(): ConceptVector[] {
  return [
    {
      name: 'verified shuffled events converge from canonical provider state and dedupe audit ids',
      input: {
        canonical: { charged: 100, refunded: 40, disputed: 20 },
        events: [
          { id: 'r1', kind: 'refund', validSignature: true },
          { id: 'c1', kind: 'charge', validSignature: true },
          { id: 'r1', kind: 'refund', validSignature: true },
          { id: 'd1', kind: 'dispute', validSignature: true },
        ],
      },
      expected: {
        state: { charged: 100, refunded: 40, disputed: 20 },
        auditIds: ['r1', 'c1', 'd1'],
        rejectedIds: [],
      },
    },
    {
      name: 'invalid signature is rejected before audit/state mutation',
      input: {
        canonical: { charged: 50, refunded: 0, disputed: 0 },
        events: [
          { id: 'bad', kind: 'refund', validSignature: false },
          { id: 'c', kind: 'charge', validSignature: true },
        ],
      },
      expected: {
        state: { charged: 50, refunded: 0, disputed: 0 },
        auditIds: ['c'],
        rejectedIds: ['bad'],
      },
    },
  ];
}

function orderSyncVectors(): ConceptVector[] {
  return [
    {
      name: 'duplicate pages and correction upsert once per external id with checkpoint after page commit',
      input: {
        pages: [
          {
            cursor: 'c1',
            next: 'c2',
            orders: [
              { id: 'v1', version: 1, amount: 10 },
              { id: 'v1', version: 1, amount: 10 },
            ],
          },
          {
            cursor: 'c2',
            next: null,
            orders: [
              { id: 'v1', version: 2, amount: 12 },
              { id: 'v2', version: 1, amount: 5 },
            ],
          },
        ],
        interruptAfterCursor: null,
      },
      expected: {
        checkpoint: null,
        orders: { v1: { version: 2, amount: 12 }, v2: { version: 1, amount: 5 } },
        status: 'complete',
      },
    },
    {
      name: 'interruption checkpoints last fully committed page',
      input: {
        pages: [
          { cursor: 'a', next: 'b', orders: [{ id: 'x', version: 1, amount: 1 }] },
          { cursor: 'b', next: null, orders: [{ id: 'y', version: 1, amount: 2 }] },
        ],
        interruptAfterCursor: 'a',
      },
      expected: {
        checkpoint: 'b',
        orders: { x: { version: 1, amount: 1 } },
        status: 'interrupted',
      },
    },
  ];
}

function subscriptionWebhookVectors(): ConceptVector[] {
  return [
    {
      name: 'signature and timestamp checks precede dedupe and canonical reconciliation',
      input: {
        now: 1000,
        tolerance: 300,
        events: [
          { id: 'e1', validSignature: true, timestamp: 900, status: 'past_due' },
          { id: 'e2', validSignature: false, timestamp: 950, status: 'active' },
          { id: 'e3', validSignature: true, timestamp: 500, status: 'canceled' },
          { id: 'e1', validSignature: true, timestamp: 900, status: 'past_due' },
        ],
        canonicalStatus: 'active',
      },
      expected: {
        acceptedIds: ['e1'],
        rejectedIds: ['e2', 'e3'],
        finalStatus: 'active',
        reconciled: true,
      },
    },
    {
      name: 'missed event recovery uses canonical list state',
      input: { now: 2000, tolerance: 300, events: [], canonicalStatus: 'canceled' },
      expected: { acceptedIds: [], rejectedIds: [], finalStatus: 'canceled', reconciled: true },
    },
  ];
}

function phiVectors(): ConceptVector[] {
  return [
    {
      name: 'parallel copy preserves swapped incoming values on loop edge',
      input: {
        registers: { a: 1, b: 2 },
        copies: [
          { to: 'a', from: 'b' },
          { to: 'b', from: 'a' },
        ],
      },
      expected: { a: 2, b: 1 },
    },
    {
      name: 'straight line copies retain original incoming snapshot',
      input: {
        registers: { x: 3, y: 4, z: 5 },
        copies: [
          { to: 'x', from: 'y' },
          { to: 'z', from: 'x' },
        ],
      },
      expected: { x: 4, y: 4, z: 3 },
    },
  ];
}

function gcRootVectors(): ConceptVector[] {
  return [
    {
      name: 'live spilled reference is included at safepoint while integers are not',
      input: {
        live: [
          { vreg: 'r1', kind: 'ref', location: 'stack:24' },
          { vreg: 'i1', kind: 'int', location: 'reg:x0' },
        ],
        safepoint: true,
      },
      expected: { roots: ['stack:24'] },
    },
    {
      name: 'dead references and non-safepoints produce no roots',
      input: { live: [{ vreg: 'r2', kind: 'ref-dead', location: 'reg:x1' }], safepoint: false },
      expected: { roots: [] },
    },
    {
      name: 'multiple live reference locations remain exact',
      input: {
        live: [
          { vreg: 'a', kind: 'ref', location: 'reg:x3' },
          { vreg: 'b', kind: 'ref', location: 'stack:8' },
        ],
        safepoint: true,
      },
      expected: { roots: ['reg:x3', 'stack:8'] },
    },
  ];
}

function parserRefactorVectors(): ConceptVector[] {
  return [
    {
      name: 'valid configuration preserves public parse result after structural split',
      input: { source: 'port=8080\nmode=fast', knownKeys: ['port', 'mode'] },
      expected: { ok: true, value: { port: '8080', mode: 'fast' }, diagnostics: [] },
    },
    {
      name: 'invalid line preserves stable diagnostic location and message',
      input: { source: 'port=8080\nbadline\nmode=fast', knownKeys: ['port', 'mode'] },
      expected: {
        ok: false,
        value: null,
        diagnostics: [{ line: 2, code: 'expected-equals', message: 'Expected key=value' }],
      },
    },
    {
      name: 'semantic unknown key remains distinct from syntax failure',
      input: { source: 'port=8080\ncolor=blue', knownKeys: ['port'] },
      expected: {
        ok: false,
        value: null,
        diagnostics: [{ line: 2, code: 'unknown-key', message: 'Unknown key: color' }],
      },
    },
  ];
}

function persistenceRefactorVectors(): ConceptVector[] {
  return [
    {
      name: 'narrow repository contract preserves transaction rollback',
      input: {
        initial: { a: 1 },
        operations: [{ type: 'begin' }, { type: 'set', key: 'a', value: 2 }, { type: 'error' }],
      },
      expected: { state: { a: 1 }, commits: 0, rollbacks: 1 },
    },
    {
      name: 'old and new call sites share one transaction semantic',
      input: {
        initial: {},
        operations: [
          { type: 'begin' },
          { type: 'set', key: 'x', value: 1 },
          { type: 'commit' },
          { type: 'begin' },
          { type: 'set', key: 'y', value: 2 },
          { type: 'commit' },
        ],
      },
      expected: { state: { x: 1, y: 2 }, commits: 2, rollbacks: 0 },
    },
  ];
}

function projectileVectors(): ConceptVector[] {
  return [
    {
      name: 'fixed-step projectile hit is invariant across render frame rates',
      input: {
        fixedDt: 0.01,
        speed: 100,
        targetX: 5,
        radius: 0.2,
        frameDts: [0.016, 0.016, 0.016, 0.016],
      },
      expected: { hit: true, simSteps: 6, position: 6 },
    },
    {
      name: 'large hitch is consumed through bounded fixed steps rather than one tunneling jump',
      input: { fixedDt: 0.01, speed: 100, targetX: 5, radius: 0.2, frameDts: [0.25] },
      expected: { hit: true, simSteps: 25, position: 25 },
    },
    {
      name: 'paused frames do not advance simulation',
      input: {
        fixedDt: 0.01,
        speed: 10,
        targetX: 100,
        radius: 1,
        frameDts: [0.05, 0, 0.05],
        pausedIndices: [1],
      },
      expected: { hit: false, simSteps: 10, position: 1 },
    },
  ];
}

function saveMigrationVectors(): ConceptVector[] {
  return [
    {
      name: 'v1 inventory migrates to v2 with stable ids and equipped item',
      input: { version: 1, save: { items: ['sword', 'potion'], equippedIndex: 0 } },
      expected: {
        ok: true,
        version: 2,
        inventory: [
          { id: 'item-0', kind: 'sword' },
          { id: 'item-1', kind: 'potion' },
        ],
        equippedId: 'item-0',
      },
    },
    {
      name: 'duplicate v2 ids fail closed',
      input: {
        version: 2,
        save: {
          inventory: [
            { id: 'x', kind: 'sword' },
            { id: 'x', kind: 'potion' },
          ],
          equippedId: 'x',
        },
      },
      expected: { ok: false, error: 'duplicate-id' },
    },
    {
      name: 'corrupt version is rejected without partial state',
      input: { version: 99, save: {} },
      expected: { ok: false, error: 'unsupported-version' },
    },
  ];
}

function networkPathVectors(): ConceptVector[] {
  return [
    {
      name: 'DNS succeeds but IPv6 route fails while IPv4 works localizes route layer',
      input: {
        dns: { a: true, aaaa: true },
        routes: { ipv4: true, ipv6: false },
        tcp: { ipv4: true, ipv6: false },
        tls: { ipv4: true, ipv6: false },
        http: { ipv4: true, ipv6: false },
      },
      expected: {
        failingLayer: 'route-ipv6',
        nextProbe: 'compare-ipv6-route-source',
        safeControl: 'prefer-ipv4-temporarily',
      },
    },
    {
      name: 'TCP connects but SNI certificate mismatch localizes TLS identity',
      input: {
        dns: { a: true, aaaa: false },
        routes: { ipv4: true, ipv6: null },
        tcp: { ipv4: true, ipv6: null },
        tls: { ipv4: false, ipv6: null, reason: 'certificate-name' },
        http: { ipv4: false, ipv6: null },
      },
      expected: {
        failingLayer: 'tls-sni-certificate',
        nextProbe: 'verify-sni-and-certificate-chain',
        safeControl: 'rollback-lb-tls-config',
      },
    },
  ];
}

function mtuVectors(): ConceptVector[] {
  return [
    {
      name: 'payload above effective tunnel MTU with filtered PTB predicts blackhole',
      input: {
        linkMtu: 1500,
        encapsulationOverhead: 80,
        tcpMss: 1460,
        payloadBytes: 1450,
        ptbObserved: false,
        ptbFiltered: true,
      },
      expected: { effectiveMtu: 1420, oversized: true, likelyBlackhole: true, suggestedMss: 1380 },
    },
    {
      name: 'small payload below effective MTU does not implicate PMTU',
      input: {
        linkMtu: 1500,
        encapsulationOverhead: 50,
        tcpMss: 1400,
        payloadBytes: 1000,
        ptbObserved: false,
        ptbFiltered: false,
      },
      expected: {
        effectiveMtu: 1450,
        oversized: false,
        likelyBlackhole: false,
        suggestedMss: 1410,
      },
    },
  ];
}

function systemdVectors(): ConceptVector[] {
  return [
    {
      name: 'drop-in overrides environment while package unit remains owned by package',
      input: {
        unit: { user: 'svc', after: ['network.target'], env: { MODE: 'prod' } },
        dropins: [{ env: { MODE: 'safe', PORT: '8080' }, after: ['network-online.target'] }],
        permissions: { serviceUserCanWriteConfig: false },
        journal: { cleanStart: true },
      },
      expected: {
        effective: {
          user: 'svc',
          after: ['network.target', 'network-online.target'],
          env: { MODE: 'safe', PORT: '8080' },
        },
        safe: true,
      },
    },
    {
      name: 'service-owned writable config violates lifecycle boundary',
      input: {
        unit: { user: 'svc', after: [], env: {} },
        dropins: [],
        permissions: { serviceUserCanWriteConfig: true },
        journal: { cleanStart: true },
      },
      expected: { effective: { user: 'svc', after: [], env: {} }, safe: false },
    },
  ];
}

function linuxLeakVectors(): ConceptVector[] {
  return [
    {
      name: 'deleted-open file accounts for hidden disk usage until owning process releases fd',
      input: {
        filesystemUsedMb: 900,
        visibleFilesMb: 500,
        openDeleted: [{ pid: 10, bytesMb: 400 }],
        cgroup: { oomKill: 0 },
      },
      expected: { hiddenDeletedMb: 400, accountedMb: 900, cause: 'deleted-open-files' },
    },
    {
      name: 'cgroup OOM event localizes memory kill when disk accounting matches',
      input: {
        filesystemUsedMb: 500,
        visibleFilesMb: 500,
        openDeleted: [],
        cgroup: { oomKill: 3 },
      },
      expected: { hiddenDeletedMb: 0, accountedMb: 500, cause: 'cgroup-oom' },
    },
  ];
}

function apiReferenceVectors(): ConceptVector[] {
  return [
    {
      name: 'runtime validator and handler errors override stale prose while deprecation remains documented',
      input: {
        openapi: {
          fields: { q: { required: true }, limit: { required: false, deprecated: true } },
          errors: ['400'],
        },
        validator: { nullAllowed: ['limit'], omittedDefaults: { limit: 20 } },
        handlerErrors: ['404'],
        staleProseFields: ['legacy'],
      },
      expected: {
        fields: ['q', 'limit'],
        errors: ['400', '404'],
        defaults: { limit: 20 },
        nullAllowed: ['limit'],
        deprecated: ['limit'],
        ignoredStaleFields: ['legacy'],
      },
    },
    {
      name: 'omitted and explicit null remain distinct',
      input: {
        openapi: { fields: { mode: { required: false } }, errors: [] },
        validator: { nullAllowed: [], omittedDefaults: { mode: 'auto' } },
        handlerErrors: [],
        staleProseFields: [],
      },
      expected: {
        fields: ['mode'],
        errors: [],
        defaults: { mode: 'auto' },
        nullAllowed: [],
        deprecated: [],
        ignoredStaleFields: [],
      },
    },
  ];
}

function settingsReferenceVectors(): ConceptVector[] {
  return [
    {
      name: 'runtime enum conflict is surfaced instead of copying schema claim',
      input: {
        schema: { enum: ['a', 'b'], default: 'a' },
        runtime: { enum: ['a', 'c'], computedDefault: 'c' },
        env: { name: 'KORY_MODE', omissionSensitive: true },
        cli: { flag: '--mode', aliases: ['--legacy-mode'] },
      },
      expected: {
        acceptedValues: ['a', 'c'],
        default: 'c',
        conflicts: ['schema-runtime-enum'],
        env: 'KORY_MODE',
        cli: '--mode',
        deprecatedAliases: ['--legacy-mode'],
      },
    },
    {
      name: 'matching schema and runtime have no conflict',
      input: {
        schema: { enum: ['x'], default: 'x' },
        runtime: { enum: ['x'], computedDefault: 'x' },
        env: { name: 'X', omissionSensitive: false },
        cli: { flag: '--x', aliases: [] },
      },
      expected: {
        acceptedValues: ['x'],
        default: 'x',
        conflicts: [],
        env: 'X',
        cli: '--x',
        deprecatedAliases: [],
      },
    },
  ];
}

export const SYSTEMS_PROTOCOL_CONCEPTS: readonly ConceptFixture[] = [
  {
    id: 'llm-application-engineering-full-task-1-individual',
    skill: 'llm-application-engineering',
    contract: `Normalize provider responses into {category,confidence}. Primary uses envelope.output.{category,confidence}; fallback uses envelope.result.{label,score}. A valid category is a nonempty string and confidence/score is a finite number in [0,1]. Try primary first. Use fallback only for timeout/rate-limit/refusal/malformed primary. Total latency and tokens across attempted providers must remain <= budget; if exceeded return null category/confidence/provider, fallbackUsed reflecting whether fallback was attempted, outcome budget-exceeded. A valid provider returns outcome route. If both fail within budget return outcome unavailable.`,
    vectors: llmAppProviderVectors,
  },
  {
    id: 'llm-application-engineering-full-task-2-individual',
    skill: 'llm-application-engineering',
    contract: `Authorize a refund proposal deterministically before any tool execution. Cross-account identity rejects unauthorized. Compute key refund:<orderId>:<expectedVersion>:<amount>. If a prior receipt contains the key, return already-complete and audit authorized,receipt-found without another call. Otherwise require refundable and not already refunded, explicit confirmation, and exact order version. Audit successful gates in order authorized,eligible,confirmed,fresh. Return execute only after all gates. Stale state rejects with stale-state.`,
    vectors: llmAppToolVectors,
  },
  {
    id: 'ml-evaluation-full-task-1-individual',
    skill: 'ml-evaluation',
    contract: `Evaluate final-period binary examples only after leakage filtering. Exclude invalid/missing labels. A row leaks when its account or fingerprint appears in train. Remaining rows are eligible. Review the highest probability rows up to reviewCapacity, ties by id. precision is positives among reviewed / reviewed; recall is positives among reviewed / positives among all eligible, with 0 for empty denominators. Round to three decimals. Return eligibleIds and leakageIds in input order, reviewedIds in score order.`,
    vectors: mlBinaryVectors,
  },
  {
    id: 'ml-evaluation-full-task-2-individual',
    skill: 'ml-evaluation',
    contract: `Exclude invalid rows and any row whose thread appears in trainThreads. Return eligibleIds and leakageIds in input order. accuracy is exact predicted/truth matches over eligible. criticalRecall is correctly predicted critical / eligible truth=critical, or 0 when no critical cases. Round to three decimals. Never hide the rare critical slice inside aggregate accuracy.`,
    vectors: mlMulticlassVectors,
  },
  {
    id: 'mlops-full-task-1-individual',
    skill: 'mlops',
    contract: `Build lineageKey data|features|code|env|modelDigest. Promotion requires artifact signature valid, evaluationPassed, approved, featureParity, canary health and quality, and a nonempty rollbackDigest. Return sorted blocker names from approval, artifact-signature, evaluation, feature-parity, canary-health, canary-quality, rollback. rollbackReady is Boolean rollbackDigest.`,
    vectors: mlopsLineageVectors,
  },
  {
    id: 'mlops-full-task-2-individual',
    skill: 'mlops',
    contract: `Canonical run identity is runId regardless of duplicate triggers. nextStage is the first stage whose status is failed or pending, else null. A production monitor failure in any of health,freshness,schema,drift,delayedQuality sets rollback=true and blocks promotion. Promotion requires no next stage, all monitors true, and candidatePassed.`,
    vectors: mlopsMonitoringVectors,
  },
  {
    id: 'finops-cloud-cost-full-task-1-individual',
    skill: 'finops-cloud-cost',
    contract: `Reconcile all row costs to invoiceTotal within exact fixture arithmetic. Direct team rows allocate to that team. shared rows allocate by sharedWeights when weights sum to 1; otherwise remain unallocated. unitCost for a team is allocated cost / that team's direct transactions when transactions>0. Return allocated and unitCost objects by team key, unallocated, reconciled. Round unit costs to three decimals.`,
    vectors: finopsAllocationVectors,
  },
  {
    id: 'finops-cloud-cost-full-task-2-individual',
    skill: 'finops-cloud-cost',
    contract: `maxSafeCommit is min(hourlyEligible)*utilizationFloor, rounded to three decimals. Purchase is allowed only when proposedHourlyCommit<=maxSafeCommit, cashAllowed=true, migrationRisk=false. reasons are sorted among proposed-above-safe,cash-constraint,migration-risk.`,
    vectors: finopsCommitmentVectors,
  },
  {
    id: 'email-delivery-full-task-1-individual',
    skill: 'email-delivery',
    contract: `If DMARC fails or neither SPF nor DKIM aligns, authProblem=true, likelyFocus=['alignment'], experiment='header-alignment-control'. Otherwise authProblem=false. When Microsoft placement is junk while Gmail is inbox, focus provider-reputation; add warm-up when volumeJump>=3. Return likelyFocus sorted in provider-reputation,warm-up order and experiment controlled-seed-and-volume-ramp for that provider-specific case. Do not prescribe DNS mutation when authentication already aligns.`,
    vectors: emailAlignmentVectors,
  },
  {
    id: 'email-delivery-full-task-2-individual',
    skill: 'email-delivery',
    generation: 3,
    contract: `Input is {events,actions}. Each event is {id,address,kind,at}, where kind is hard or soft. Process events in ascending at then input order, deduplicating stable event id. kind=hard permanently suppresses event.address; kind=soft never clears a hard suppression. Then process actions in input order. A correction action is {type:'correct',from,to}: it introduces the new to address as sendable while preserving the old from address suppression/history. An unsuppress action is {type:'unsuppress',address} and applies only to that named address. auditIds reflect unique processed event ids in chronological order and do not include actions. sendable contains corrected/known addresses that are not suppressed and were explicitly unsuppressed or introduced by correction. Return exactly {suppressed,sendable,auditIds}, with suppressed and sendable sorted.`,
    vectors: emailSuppressionVectors,
  },
  {
    id: 'payment-integration-full-task-1-individual',
    skill: 'payment-integration',
    contract: `One logical order uses idempotencyKey payment:<orderId>. If prior payment exists, make zero provider calls and preserve its providerId/state; captured means one captured charge. With no prior, one attempt creates at most one provider call. accepted-response-lost stores providerId and state reconcile but capturedCharges=1 because provider accepted. accepted=>captured, declined=>declined. A matching authoritative webhook may move reconcile to captured. Restart never creates a second provider identity.`,
    vectors: paymentAttemptVectors,
  },
  {
    id: 'payment-integration-full-task-2-individual',
    skill: 'payment-integration',
    contract: `Reject invalid-signature events before audit/state changes. Deduplicate valid event ids in delivery order into auditIds. Because delivery is unordered, final materialized payment state equals the supplied canonical provider lookup, not replay order. rejectedIds lists invalid signatures in input order.`,
    vectors: paymentEventVectors,
  },
  {
    id: 'integration-implementation-full-task-1-individual',
    skill: 'integration-implementation',
    contract: `Process pages in order using opaque cursor semantics. Upsert orders by vendor id only when version is >= current version, preserving the newest correction. Duplicate rows are idempotent. After each fully committed page checkpoint becomes that page's next cursor. If interruptAfterCursor equals a committed page cursor, stop immediately after committing it and return interrupted. Complete traversal returns status complete and final checkpoint null.`,
    vectors: orderSyncVectors,
  },
  {
    id: 'integration-implementation-full-task-2-individual',
    skill: 'integration-implementation',
    contract: `Accept an event only when validSignature=true and absolute(now-timestamp)<=tolerance. Deduplicate accepted stable ids. rejectedIds contains invalid/stale ids once in input order. Event delivery order is not canonical; after processing, reconcile to supplied canonicalStatus and set reconciled=true.`,
    vectors: subscriptionWebhookVectors,
  },
  {
    id: 'compiler-runtime-backend-full-task-1-individual',
    skill: 'compiler-runtime-backend',
    contract: `Lower phi-edge parallel copies correctly. Every copy reads from the predecessor register snapshot before any destination is updated, so cycles/swaps preserve original incoming values. Return the final register object with untouched registers retained.`,
    vectors: phiVectors,
  },
  {
    id: 'compiler-runtime-backend-full-task-2-individual',
    skill: 'compiler-runtime-backend',
    contract: `At a safepoint, roots are exactly locations of live entries whose kind is ref. Ignore int and ref-dead. At non-safepoints return no roots. Preserve input order of live roots. Return {roots}.`,
    vectors: gcRootVectors,
  },
  {
    id: 'refactor-implementation-full-task-1-individual',
    skill: 'refactor-implementation',
    contract: `Implement the public parser behavior independent of internal tokenizer/syntax/semantic structure. Each nonempty line must be key=value. Missing '=' yields one expected-equals diagnostic with 1-based line and no value. Unknown keys yield unknown-key diagnostics. If any diagnostic exists return {ok:false,value:null,diagnostics}; otherwise return parsed string values. Preserve diagnostic messages exactly as specified in vectors.`,
    vectors: parserRefactorVectors,
  },
  {
    id: 'refactor-implementation-full-task-2-individual',
    skill: 'refactor-implementation',
    contract: `Replay a narrow transaction contract over initial key/value state. begin snapshots state. set mutates only inside active transaction. error rolls back to snapshot and increments rollbacks. commit makes current state durable and increments commits. Return {state,commits,rollbacks}. This represents the preserved behavior while persistence interfaces are extracted.`,
    vectors: persistenceRefactorVectors,
  },
  {
    id: 'game-development-full-task-1-individual',
    skill: 'game-development',
    contract: `Simulate using fixedDt independent of render frame rate. Accumulate each non-paused frameDt and consume fixed steps while accumulator>=fixedDt. Each step advances position by speed*fixedDt. hit becomes true if the segment from previous to new position intersects [targetX-radius,targetX+radius]. Continue all steps. pausedIndices identify frame entries whose dt must not advance or accumulate. Return hit,simSteps,position rounded to three decimals.`,
    vectors: projectileVectors,
  },
  {
    id: 'game-development-full-task-2-individual',
    skill: 'game-development',
    contract: `Load save data atomically. Version 1 has items[] and equippedIndex; migrate to version 2 inventory entries {id:'item-<index>',kind} and equippedId or null. Version 2 must reject duplicate ids and otherwise preserve inventory/equippedId. Unknown version returns {ok:false,error:'unsupported-version'}. Invalid duplicate returns duplicate-id. Successful result includes ok:true,version:2,inventory,equippedId.`,
    vectors: saveMigrationVectors,
  },
  {
    id: 'networking-systems-full-task-1-individual',
    skill: 'networking-systems',
    contract: `Localize the first failed layer from evidence, without assuming topology. If DNS resolves but an address-family route is false, return route-<family>, nextProbe compare-<family>-route-source, and safeControl prefer the other family temporarily when it works. If route/TCP succeed but TLS fails for certificate-name, return tls-sni-certificate, probe verify-sni-and-certificate-chain, control rollback-lb-tls-config.`,
    vectors: networkPathVectors,
  },
  {
    id: 'networking-systems-full-task-2-individual',
    skill: 'networking-systems',
    contract: `effectiveMtu=linkMtu-encapsulationOverhead. suggestedMss=max(536,effectiveMtu-40). oversized is payloadBytes>effectiveMtu. likelyBlackhole is true only when oversized and no PTB observed and PTB is filtered. Return integer effectiveMtu/suggestedMss plus booleans.`,
    vectors: mtuVectors,
  },
  {
    id: 'linux-systems-full-task-1-individual',
    skill: 'linux-systems',
    contract: `Compute effective systemd-like config by starting with unit then applying dropins in order. Merge env by key with later override. after is stable unique concatenation. Safe requires nonempty non-root-like service user, serviceUserCanWriteConfig=false and journal.cleanStart=true. Return {effective:{user,after,env},safe}.`,
    vectors: systemdVectors,
  },
  {
    id: 'linux-systems-full-task-2-individual',
    skill: 'linux-systems',
    contract: `hiddenDeletedMb is sum of openDeleted bytesMb. accountedMb=visibleFilesMb+hiddenDeletedMb. If hiddenDeletedMb>0 and accountedMb explains filesystemUsedMb, cause deleted-open-files. Else if cgroup.oomKill>0 cause cgroup-oom. Else cause unresolved.`,
    vectors: linuxLeakVectors,
  },
  {
    id: 'reference-communication-full-task-1-individual',
    skill: 'reference-communication',
    contract: `Build reference facts from active contract/runtime sources. fields are OpenAPI field keys in declaration order; ignore stale prose-only fields. errors are unique OpenAPI then handler errors. defaults and nullAllowed come from runtime validator. deprecated are fields marked deprecated in OpenAPI. Return ignoredStaleFields unchanged. Do not invent behavior absent from active sources.`,
    vectors: apiReferenceVectors,
  },
  {
    id: 'reference-communication-full-task-2-individual',
    skill: 'reference-communication',
    contract: `Runtime behavior is authoritative when schema conflicts. acceptedValues are runtime.enum. default is runtime.computedDefault. Add conflict schema-runtime-enum when sorted enum sets differ. Return env name, canonical cli flag, deprecatedAliases.`,
    vectors: settingsReferenceVectors,
  },
];

const fixtures = createConceptFixtures(SYSTEMS_PROTOCOL_CONCEPTS);
export const SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS = fixtures.materializers;
export const SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS = fixtures.scorers;
