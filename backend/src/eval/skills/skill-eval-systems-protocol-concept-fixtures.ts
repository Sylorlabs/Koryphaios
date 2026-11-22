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
          { id: 'r0', account: 'b', fingerprint: 'q', time: 100, label: 1, probability: 1 },
          { id: 'before', account: 'e', fingerprint: 'v', time: 99, label: 1, probability: 0.99 },
          { id: 'r1', account: 'b', fingerprint: 'y', time: 110, label: 1, probability: 0.9 },
          { id: 'r2', account: 'a', fingerprint: 'z', time: 120, label: 0, probability: 0.8 },
          { id: 'r3', account: 'c', fingerprint: 'x', time: 130, label: 1, probability: 0.7 },
          { id: 'r4', account: 'd', fingerprint: 'w', time: 140, label: 0, probability: 0.6 },
        ],
      },
      expected: {
        eligibleIds: ['r1', 'r4'],
        leakageIds: ['r0', 'before', 'r2', 'r3'],
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
    {
      name: 'invalid labels are excluded before leakage classification and ranking',
      input: {
        cutoff: 20,
        reviewCapacity: 3,
        train: [{ id: 'train', account: 'seen', fingerprint: 'seen' }],
        rows: [
          { id: 'missing', account: 'seen', fingerprint: 'seen', time: 19, probability: 1 },
          { id: 'string', account: 's', fingerprint: 's', time: 21, label: '1', probability: 0.99 },
          {
            id: 'boolean',
            account: 'b',
            fingerprint: 'b',
            time: 21,
            label: true,
            probability: 0.98,
          },
          { id: 'invalid', account: 'i', fingerprint: 'i', time: 21, label: 2, probability: 0.97 },
          { id: 'valid', account: 'v', fingerprint: 'v', time: 21, label: 0, probability: 0.8 },
        ],
      },
      expected: {
        eligibleIds: ['valid'],
        leakageIds: [],
        reviewedIds: ['valid'],
        precision: 0,
        recall: 0,
      },
    },
    {
      name: 'capacity and ties preserve ordering and eligible-positive recall denominator',
      input: {
        cutoff: 200,
        reviewCapacity: 2,
        train: [],
        rows: [
          { id: 'z', account: 'z', fingerprint: 'z', time: 201, label: 1, probability: 0.8 },
          { id: 'a', account: 'a', fingerprint: 'a', time: 202, label: 0, probability: 0.8 },
          { id: 'c', account: 'c', fingerprint: 'c', time: 203, label: 1, probability: 0.7 },
          { id: 'd', account: 'd', fingerprint: 'd', time: 204, label: 1, probability: 0.6 },
        ],
      },
      expected: {
        eligibleIds: ['z', 'a', 'c', 'd'],
        leakageIds: [],
        reviewedIds: ['a', 'z'],
        precision: 0.5,
        recall: 0.333,
      },
    },
    {
      name: 'empty eligible population has zero precision and recall',
      input: { cutoff: 0, reviewCapacity: 2, train: [], rows: [] },
      expected: { eligibleIds: [], leakageIds: [], reviewedIds: [], precision: 0, recall: 0 },
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
  const safeControls = {
    stream: 'transactional-isolated',
    suppressionBeforeProvider: true,
    unsubscribe: 'not-applicable',
    templateRender: 'observed',
    providerEvents: 'observed',
    rateLimit: 'bounded-deferral',
    retry: 'transient-only',
    failover: 'state-preserving',
  };
  const alignedAuthentication = {
    dnsRecords: {
      spf: 'v=spf1 include:_spf.vendor.test -all',
      dkim: 'v=DKIM1; k=rsa; p=fixture-public-key',
      dmarc: 'v=DMARC1; p=none',
    },
    received: {
      spf: { result: 'pass', aligned: true, domain: 'bounce.reset.example.com' },
      dkim: { result: 'pass', aligned: true, domain: 'reset.example.com', selector: 's1' },
      dmarc: { result: 'pass' },
    },
    faultSurface: 'none',
  };
  return [
    {
      name: 'malformed authentication records remain unresolved even when all fields are nonempty',
      input: {
        authentication: {
          dnsRecords: {
            spf: 'v=spf1 include:_spf.vendor.test -all',
            dkim: 'not-a-dkim-record',
            dmarc: 'v=DMARC1; p=none',
          },
          received: alignedAuthentication.received,
          faultSurface: 'unknown',
        },
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'junk' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 1,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'unresolved',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'unresolved',
          reputation: 'unresolved',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'unresolved-until-auth-evidence',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: ['authentication-evidence-invalid'],
        experiments: [
          {
            id: 'authentication-evidence-validation',
            change: 'validate-dns-record-shape-and-received-auth-fields',
            bound: 'one-sending-subdomain',
          },
        ],
        successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
        recovery: [
          'do-not-change-dns-without-validating-record-evidence',
          'recheck-placement-after-auth-evidence',
        ],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'aligned auth with provider-specific junking produces a bounded reputation and warm-up investigation',
      input: {
        authentication: alignedAuthentication,
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'junk' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 8,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'aligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'inferred',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'provider-specific-hypothesis',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: ['provider-reputation', 'warm-up'],
        experiments: [
          {
            id: 'microsoft-seed-control',
            change: 'hold-content-and-auth-constant',
            bound: 'microsoft-seed-cohort',
          },
          { id: 'volume-ramp', change: 'step-volume-only', bound: 'new-sending-subdomain' },
        ],
        successMetrics: [
          'microsoft-inbox-rate',
          'complaint-rate',
          'hard-bounce-rate',
          'provider-acceptance-rate',
        ],
        recovery: [
          'stop-ramp-on-complaint-or-bounce-regression',
          'recheck-placement-before-expanding',
        ],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'provider configuration misalignment does not imply a DNS edit',
      input: {
        authentication: {
          dnsRecords: alignedAuthentication.dnsRecords,
          received: {
            spf: { result: 'pass', aligned: false, domain: 'mail.vendor.test' },
            dkim: { result: 'pass', aligned: false, domain: 'vendor.test', selector: 's1' },
            dmarc: { result: 'fail' },
          },
          faultSurface: 'provider-config',
        },
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'mail.vendor.test',
          dkimDomain: 'vendor.test',
        },
        placement: { gmail: 'spam', microsoft: 'junk' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 1,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'misaligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'mail.vendor.test',
          dkimDomain: 'vendor.test',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'unresolved',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'unresolved-until-auth-control',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: ['alignment'],
        experiments: [
          {
            id: 'header-alignment-control',
            change: 'align-authenticated-identities',
            bound: 'one-sending-subdomain',
          },
        ],
        successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
        recovery: [
          'revert-identity-change-if-auth-regresses',
          'recheck-placement-after-auth-control',
        ],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'localized DNS record defect permits a bounded DNS correction',
      input: {
        authentication: {
          dnsRecords: alignedAuthentication.dnsRecords,
          received: {
            spf: { result: 'fail', aligned: false, domain: 'bounce.reset.example.com' },
            dkim: { result: 'fail', aligned: false, domain: 'reset.example.com', selector: 's1' },
            dmarc: { result: 'fail' },
          },
          faultSurface: 'dns-record',
        },
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'junk' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 1,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'misaligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'unresolved',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'unresolved-until-auth-control',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: ['alignment'],
        experiments: [
          {
            id: 'header-alignment-control',
            change: 'align-authenticated-identities',
            bound: 'one-sending-subdomain',
          },
        ],
        successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
        recovery: [
          'revert-identity-change-if-auth-regresses',
          'recheck-placement-after-auth-control',
        ],
        dnsChangeRecommended: true,
      },
    },
    {
      name: 'non-differential placement leaves reputation unresolved',
      input: {
        authentication: alignedAuthentication,
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'inbox' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 1,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'aligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'unresolved',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'unresolved',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: [],
        experiments: [],
        successMetrics: [
          'microsoft-inbox-rate',
          'complaint-rate',
          'hard-bounce-rate',
          'provider-acceptance-rate',
        ],
        recovery: ['recheck-placement-before-expanding'],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'aligned placement investigation keeps complaint content and unsafe delivery controls visible',
      input: {
        authentication: alignedAuthentication,
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'junk' },
        complaints: 'elevated',
        bounces: 'elevated',
        volumeJump: 1,
        contentRisk: true,
        controls: {
          ...safeControls,
          rateLimit: 'unknown',
          retry: 'retries-permanent',
          failover: 'bypasses-suppression',
        },
      },
      expected: {
        authentication: 'aligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'inferred',
          placement: 'observed',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'gap',
          failover: 'gap',
        },
        signals: {
          reputation: 'provider-specific-hypothesis',
          complaints: 'elevated',
          bounces: 'elevated',
          content: 'observed-risk',
        },
        operatingGaps: ['rate-limit-policy', 'retry-policy', 'failover-state'],
        hypotheses: ['provider-reputation', 'complaints', 'bounces', 'message-construction'],
        experiments: [
          {
            id: 'microsoft-seed-control',
            change: 'hold-content-and-auth-constant',
            bound: 'microsoft-seed-cohort',
          },
          {
            id: 'message-construction-control',
            change: 'remove-one-content-risk',
            bound: 'seed-cohort-only',
          },
        ],
        successMetrics: [
          'microsoft-inbox-rate',
          'complaint-rate',
          'hard-bounce-rate',
          'provider-acceptance-rate',
        ],
        recovery: [
          'restore-original-message-if-placement-worsens',
          'keep-elevated-complaint-or-bounce-signal-open',
          'recheck-placement-before-expanding',
          'block-expansion-until-operating-gaps-close',
        ],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'missing authentication evidence and unsafe controls stay explicit',
      input: {
        authentication: {
          dnsRecords: {
            spf: 'v=spf1 include:_spf.vendor.test -all',
            dkim: '',
            dmarc: 'v=DMARC1; p=none',
          },
          received: alignedAuthentication.received,
          faultSurface: 'unknown',
        },
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'inbox', microsoft: 'junk' },
        complaints: 'elevated',
        bounces: 'elevated',
        volumeJump: 4,
        contentRisk: true,
        controls: {
          stream: 'shared-unknown',
          suppressionBeforeProvider: false,
          unsubscribe: 'not-applicable',
          templateRender: 'unavailable',
          providerEvents: 'unavailable',
          rateLimit: 'unknown',
          retry: 'retries-permanent',
          failover: 'bypasses-suppression',
        },
      },
      expected: {
        authentication: 'unresolved',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'unavailable',
          reputation: 'unresolved',
          placement: 'observed',
          providerEvents: 'unavailable',
          rendering: 'unavailable',
          unsubscribe: 'not-applicable',
          retry: 'gap',
          failover: 'gap',
        },
        signals: {
          reputation: 'unresolved-until-auth-evidence',
          complaints: 'elevated',
          bounces: 'elevated',
          content: 'observed-risk',
        },
        operatingGaps: [
          'stream-boundary',
          'suppression-before-provider',
          'rate-limit-policy',
          'retry-policy',
          'failover-state',
        ],
        hypotheses: ['authentication-evidence-gap'],
        experiments: [
          {
            id: 'authentication-evidence-control',
            change: 'collect-dns-and-received-auth-evidence',
            bound: 'one-sending-subdomain',
          },
        ],
        successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
        recovery: [
          'do-not-change-dns-without-fault-localization',
          'recheck-placement-after-auth-evidence',
          'block-expansion-until-operating-gaps-close',
        ],
        dnsChangeRecommended: false,
      },
    },
    {
      name: 'unavailable placement does not become observed mailbox evidence',
      input: {
        authentication: alignedAuthentication,
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        placement: { gmail: 'unavailable', microsoft: 'unavailable' },
        complaints: 'normal',
        bounces: 'normal',
        volumeJump: 1,
        contentRisk: false,
        controls: safeControls,
      },
      expected: {
        authentication: 'aligned',
        identity: {
          fromDomain: 'reset.example.com',
          returnPathDomain: 'bounce.reset.example.com',
          dkimDomain: 'reset.example.com',
        },
        evidencePriority: [
          'received-headers',
          'dns-and-provider-config',
          'provider-events',
          'seed-placement',
        ],
        evidenceStatus: {
          authentication: 'observed',
          reputation: 'unresolved',
          placement: 'unavailable',
          providerEvents: 'observed',
          rendering: 'observed',
          unsubscribe: 'not-applicable',
          retry: 'observed',
          failover: 'observed',
        },
        signals: {
          reputation: 'unresolved',
          complaints: 'normal',
          bounces: 'normal',
          content: 'no-observed-risk',
        },
        operatingGaps: [],
        hypotheses: [],
        experiments: [],
        successMetrics: [
          'microsoft-inbox-rate',
          'complaint-rate',
          'hard-bounce-rate',
          'provider-acceptance-rate',
        ],
        recovery: ['recheck-placement-before-expanding'],
        dnsChangeRecommended: false,
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
    {
      name: 'unverified truthy or missing signatures fail closed without blocking verified replay',
      input: {
        canonical: { charged: 120, refunded: 30, disputed: 0 },
        events: [
          { id: 'replayed', kind: 'refund', validSignature: 'true' },
          { id: 'missing', kind: 'charge' },
          { id: 'verified', kind: 'charge', validSignature: true },
          { id: 'replayed', kind: 'refund', validSignature: true },
          { id: 'numeric', kind: 'dispute', validSignature: 1 },
          { id: 'null', kind: 'dispute', validSignature: null },
          { id: 'verified', kind: 'charge', validSignature: true },
        ],
      },
      expected: {
        state: { charged: 120, refunded: 30, disputed: 0 },
        auditIds: ['verified', 'replayed'],
        rejectedIds: ['replayed', 'missing', 'numeric', 'null'],
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
      input: { version: 1, items: ['sword', 'potion'], equippedIndex: 0 },
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
        inventory: [
          { id: 'x', kind: 'sword' },
          { id: 'x', kind: 'potion' },
        ],
        equippedId: 'x',
      },
      expected: { ok: false, error: 'duplicate-id' },
    },
    {
      name: 'corrupt version is rejected without partial state',
      input: { version: 99 },
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
    // 2: the contract never named the given input fields or the exact returned record, so a correct
    // candidate that read budget.maxLatencyMs/maxTokens as latencyMs/tokens scored zero. The naming
    // repair leaves the accounting, fallback eligibility and outcome classification unchanged.
    generation: 2,
    contract: `Input is exactly {budget:{maxLatencyMs,maxTokens}, primary:{status,latencyMs,tokens,envelope}, fallback:{status,latencyMs,tokens,envelope}}. Budget fields are maxLatencyMs and maxTokens, not latencyMs and tokens, and a provider's own latencyMs/tokens are its spent amount. Normalize provider responses into {category,confidence}. Primary uses envelope.output.{category,confidence}; fallback uses envelope.result.{label,score}. A valid category is a nonempty string and confidence/score is a finite number in [0,1]. Try primary first. Use fallback only for timeout/rate-limit/refusal/malformed primary. Total latency and tokens across attempted providers must remain <= budget; if exceeded return null category/confidence/provider, fallbackUsed reflecting whether fallback was attempted, outcome budget-exceeded. A valid provider returns outcome route. If both fail within budget return outcome unavailable. Return exactly {category,confidence,provider,fallbackUsed,outcome}, where provider is 'primary', 'fallback' or null, and nothing else.`,
    vectors: llmAppProviderVectors,
  },
  {
    id: 'llm-application-engineering-full-task-2-individual',
    skill: 'llm-application-engineering',
    generation: 2,
    contract: `Authorize a refund proposal deterministically before any tool execution.
Input is exactly {sessionUser,accountUser,confirmed,order,proposal,priorReceipts}. sessionUser and accountUser are user ID strings; confirmed is a boolean; order is {id,version,refundable,refunded}; proposal is {orderId,expectedVersion,amount}; priorReceipts is an array of idempotency-key strings. These are top-level fields, not nested subject/request/account objects.
Return exactly {decision,idempotencyKey,audit,reason}, with no extra fields. decision is 'execute', 'already-complete', or 'reject'; idempotencyKey is a string for execute/already-complete and null for reject; reason is null for execute/already-complete and a string for reject; audit is an ordered string array.
Check sessionUser === accountUser before receipt lookup or eligibility. Cross-account identity returns {decision:'reject',idempotencyKey:null,audit:[],reason:'unauthorized'}. For authorized proposals, compute key refund:<proposal.orderId>:<proposal.expectedVersion>:<proposal.amount>. If priorReceipts contains the key, return {decision:'already-complete',idempotencyKey:key,audit:['authorized','receipt-found'],reason:null} without another execution, even if order.refunded is true.
Otherwise require order.refundable === true and order.refunded === false, explicit confirmed === true, and exact proposal.expectedVersion === order.version, in that order. Audit successful gates as authorized,eligible,confirmed,fresh. A stale version returns {decision:'reject',idempotencyKey:null,audit:['authorized','eligible','confirmed'],reason:'stale-state'}. Only after all gates succeed return {decision:'execute',idempotencyKey:key,audit:['authorized','eligible','confirmed','fresh'],reason:null}. Reject invalid or unconfirmed actions without executing a tool.`,
    vectors: llmAppToolVectors,
  },
  {
    id: 'ml-evaluation-full-task-1-individual',
    skill: 'ml-evaluation',
    // 4: the concept harness no longer labels an unwritten candidate module as an evaluator
    // integrity failure, so this skill's recorded integrity block must be re-derived.
    generation: 4,
    contract: `Input is exactly {cutoff,reviewCapacity,train,rows}. cutoff is a finite numeric timestamp; reviewCapacity is a nonnegative integer. train is an array of {id,account,fingerprint}; rows is an array of {id,account,fingerprint,time,label,probability}, with string identifiers, finite numeric time in the same units as cutoff, and finite probability in [0,1]. rows are not prefiltered to the final period.
First exclude invalid/missing labels from eligibility, leakageIds, ranking and every metric denominator: only numeric label === 0 or label === 1 is valid (null, omitted, strings, booleans and other numbers are invalid). For labeled rows, the final period requires row.time > cutoff; rows at or before cutoff are temporal leakage. A row also leaks when its account or fingerprint appears in train. Report each leaking row once in leakageIds even if multiple leakage conditions apply; remaining labeled final-period rows are eligible.
Review the highest probability eligible rows up to reviewCapacity, ties by id ascending. precision is positives among reviewed / reviewed; recall is positives among reviewed / positives among all eligible, with 0 for empty denominators. Round to three decimals. Return exactly {eligibleIds,leakageIds,reviewedIds,precision,recall}, with no extra fields. eligibleIds and leakageIds are string arrays in input order; reviewedIds is a string array in score order; precision and recall are numbers.`,
    vectors: mlBinaryVectors,
  },
  {
    id: 'ml-evaluation-full-task-2-individual',
    skill: 'ml-evaluation',
    generation: 4,
    contract: `Exclude invalid rows and any row whose thread appears in trainThreads. Return eligibleIds and leakageIds in input order. accuracy is exact predicted/truth matches over eligible. criticalRecall is correctly predicted critical / eligible truth=critical, or 0 when no critical cases. Round to three decimals. Never hide the rare critical slice inside aggregate accuracy.`,
    vectors: mlMulticlassVectors,
  },
  {
    id: 'mlops-full-task-1-individual',
    skill: 'mlops',
    contract: `Input is one record whose lineage fields sit inside lineage: {lineage:{data,features,code,env,modelDigest,signatureValid}, evaluationPassed, approved, featureParity, canary:{health,quality}, rollbackDigest}. Only evaluationPassed, approved, featureParity, canary, rollbackDigest and lineage are read, and the signature flag is lineage.signatureValid. lineageKey is data|features|code|env|modelDigest joined with a pipe in that order. Promotion requires lineage.signatureValid, evaluationPassed, approved, featureParity, canary.health, canary.quality and a nonempty rollbackDigest. Return exactly {promotable, lineageKey, rollbackReady, blockers}, where blockers is the sorted list of failed gate names drawn from approval, artifact-signature, evaluation, feature-parity, canary-health, canary-quality, rollback, and rollbackReady is whether rollbackDigest is a nonempty string.`,
    vectors: mlopsLineageVectors,
  },
  {
    id: 'mlops-full-task-2-individual',
    skill: 'mlops',
    contract: `Input is exactly {runId, duplicateRunIds, stages:[{id,status}], monitors:{health,freshness,schema,drift,delayedQuality}, candidatePassed}. Canonical run identity is runId regardless of duplicate triggers. nextStage is the first stage whose status is failed or pending, else null. rollback is true when any production monitor in health,freshness,schema,drift,delayedQuality is false, and it is independent of candidatePassed. promote is true only when candidatePassed is true, no monitor failed and no stage is failed or pending. Return exactly {canonicalRunId, nextStage, promote, rollback}.`,
    vectors: mlopsMonitoringVectors,
  },
  {
    id: 'finops-cloud-cost-full-task-1-individual',
    skill: 'finops-cloud-cost',
    generation: 2,
    blockers: [
      'The component vectors do not furnish the billing export/schema/currency reconciliation, complete allocation and unit-economics evidence, driver decomposition, optimization scenarios, or before/after realized-savings and reliability guardrails required by the full task.',
    ],
    contract: `Reconcile all row costs to invoiceTotal within exact fixture arithmetic. Direct team rows allocate to that team. shared rows allocate by sharedWeights when weights sum to 1; otherwise remain unallocated. unitCost for a team is allocated cost / that team's direct transactions when transactions>0. Return allocated and unitCost objects by team key, unallocated, reconciled. Round unit costs to three decimals.`,
    vectors: finopsAllocationVectors,
  },
  {
    id: 'finops-cloud-cost-full-task-2-individual',
    skill: 'finops-cloud-cost',
    generation: 2,
    blockers: [
      'The component vectors do not furnish reconciled billing history, existing commitment inventory, demand/migration/seasonality scenarios, provider recommendation provenance, or post-purchase reliability and realized-savings evidence required by the full task.',
    ],
    contract: `maxSafeCommit is min(hourlyEligible)*utilizationFloor, rounded to three decimals. Purchase is allowed only when proposedHourlyCommit<=maxSafeCommit, cashAllowed=true, migrationRisk=false. reasons are sorted among proposed-above-safe,cash-constraint,migration-risk.`,
    vectors: finopsCommitmentVectors,
  },
  {
    id: 'email-delivery-full-task-1-individual',
    skill: 'email-delivery',
    generation: 6,
    contract: `Produce a structured deliverability investigation record from evidence, not a classifier or completion claim. Input is {authentication:{dnsRecords:{spf,dkim,dmarc},received:{spf:{result,aligned,domain},dkim:{result,aligned,domain,selector},dmarc:{result}},faultSurface},identity:{fromDomain,returnPathDomain,dkimDomain},placement:{gmail,microsoft},complaints,bounces,volumeJump,contentRisk,controls:{stream,suppressionBeforeProvider,unsubscribe,templateRender,providerEvents,rateLimit,retry,failover}}. Return exactly {authentication,identity,evidencePriority,evidenceStatus,signals,operatingGaps,hypotheses,experiments,successMetrics,recovery,dnsChangeRecommended}. Preserve identity, complaints, and bounces unchanged. evidencePriority is exactly ['received-headers','dns-and-provider-config','provider-events','seed-placement']. Authentication evidence is present only when all three dnsRecords strings and the received SPF result/domain, DKIM result/domain/selector, and DMARC result are nonempty. Missing evidence => authentication=unresolved, reputation=unresolved-until-auth-evidence, evidenceStatus.authentication=unavailable, hypotheses=['authentication-evidence-gap'], one authentication-evidence-control experiment, DNS change false, and recovery begins ['do-not-change-dns-without-fault-localization','recheck-placement-after-auth-evidence']. Present DNS evidence is structurally valid only when the trimmed SPF record starts with 'v=spf1', the trimmed DKIM record starts with 'v=DKIM1;', and the trimmed DMARC record starts with 'v=DMARC1;'. Present but structurally invalid DNS evidence => authentication=unresolved, reputation=unresolved-until-auth-evidence, evidenceStatus.authentication=unresolved, hypotheses=['authentication-evidence-invalid'], one authentication-evidence-validation experiment, DNS change false, and recovery begins ['do-not-change-dns-without-validating-record-evidence','recheck-placement-after-auth-evidence']. With present structurally valid evidence, authentication=misaligned when DMARC result is not pass or neither SPF nor DKIM is aligned; otherwise aligned. Misaligned => reputation=unresolved-until-auth-control, reputation status unresolved, hypotheses=['alignment'], header-alignment-control, auth success metrics, and dnsChangeRecommended=true only when faultSurface='dns-record'. Aligned Gmail=inbox plus Microsoft=junk => reputation=provider-specific-hypothesis with evidenceStatus.reputation=inferred and hypotheses start ['provider-reputation']; any other placement leaves reputation and its status unresolved. Append warm-up when volumeJump>=3, complaints when complaints=elevated, bounces when bounces=elevated, and message-construction when contentRisk=true, in that order. Add microsoft-seed-control only for the differential Gmail/Microsoft placement, volume-ramp only when volumeJump>=3, and message-construction-control only when contentRisk=true. Aligned successMetrics are ['microsoft-inbox-rate','complaint-rate','hard-bounce-rate','provider-acceptance-rate']. evidenceStatus records placement as observed only when both mailbox results are inbox, spam, or junk; otherwise unavailable; providerEvents/rendering from controls observed or unavailable; unsubscribe as not-applicable/observed/gap; retry and failover as observed/gap. operatingGaps are ordered among stream-boundary, suppression-before-provider, unsubscribe-policy, rate-limit-policy, retry-policy, failover-state from the supplied controls. If operatingGaps is nonempty append block-expansion-until-operating-gaps-close to recovery. dnsChangeRecommended=false for aligned or unresolved authentication and for misalignment localized to provider-config or unknown.
\nExact synthetic JSON semantics: the scorer compares complete JSON values, including nested field names, array order, and string tokens. Do not invent extra properties or use alternative labels. Control values describe policies and are strings where indicated; never treat them as booleans. Safe controls are stream='transactional-isolated', suppressionBeforeProvider===true, unsubscribe='not-applicable' or 'required-configured', templateRender='observed', providerEvents='observed', rateLimit='bounded-deferral', retry='transient-only', failover='state-preserving'. Any other control value is the corresponding operating gap, except unavailable rendering/provider events, which are evidence states. Missing fields are unavailable rather than verified.
signals is exactly {reputation,complaints,bounces,content}; content is 'observed-risk' when contentRisk===true, else 'no-observed-risk'. Do not echo volumeJump or contentRisk in signals. evidenceStatus is exactly {authentication,reputation,placement,providerEvents,rendering,unsubscribe,retry,failover}: authentication is observed for present structurally valid evidence, unavailable for a missing required field, and unresolved for a present malformed DNS record. placement is observed only when both gmail and microsoft placements are one of inbox, spam, junk; otherwise unavailable. providerEvents/rendering are observed only for control value 'observed', else unavailable. unsubscribe is not-applicable when specified, observed for required-configured, else gap. retry/failover are observed only for transient-only/state-preserving respectively, else gap.
Each experiments entry is exactly {id,change,bound}. Use these triples, in the conditional order given above: authentication-evidence-control/collect-dns-and-received-auth-evidence/one-sending-subdomain (missing evidence); authentication-evidence-validation/validate-dns-record-shape-and-received-auth-fields/one-sending-subdomain (invalid DNS shape); header-alignment-control/align-authenticated-identities/one-sending-subdomain (misaligned); microsoft-seed-control/hold-content-and-auth-constant/microsoft-seed-cohort (differential placement); volume-ramp/step-volume-only/new-sending-subdomain (volumeJump>=3 with present valid authentication evidence); message-construction-control/remove-one-content-risk/seed-cohort-only (contentRisk===true with present valid authentication evidence). Empty experiments is [].
For unresolved or misaligned authentication, successMetrics is exactly ['dmarc-pass-rate','microsoft-inbox-rate','gmail-inbox-rate']; for aligned authentication, use the four aligned metrics defined above. recovery for misalignment is ['revert-identity-change-if-auth-regresses','recheck-placement-after-auth-control']. For aligned authentication, recovery is ['restore-original-message-if-placement-worsens','keep-elevated-complaint-or-bounce-signal-open','recheck-placement-before-expanding'] if contentRisk===true; otherwise ['stop-ramp-on-complaint-or-bounce-regression','recheck-placement-before-expanding'] if volumeJump>=3; otherwise ['recheck-placement-before-expanding']. Missing/invalid evidence recoveries are defined above. Append 'block-expansion-until-operating-gaps-close' exactly once at the end of recovery if any operating gap exists. Never infer that a synthetic trace verifies live sending, mailbox delivery, or inbox placement.
`,
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
    generation: 2,
    contract: `Input is exactly {orderId,prior,attempt,webhook,restart}. prior is null or {providerId,state}. attempt is null or {providerOutcome,providerId}, where providerOutcome can be accepted-response-lost, accepted, or declined. webhook is null or {providerId,state}. Return exactly {idempotencyKey,providerCalls,state,capturedCharges,providerId}. One logical order uses idempotencyKey payment:<orderId>. If prior payment exists, make zero provider calls, preserve its providerId, and begin from its state; a matching authoritative webhook may move reconcile to captured. With no prior, one non-null attempt creates exactly one provider call. accepted-response-lost preserves the attempt providerId, returns state reconcile, and capturedCharges=1 because the provider accepted even though the response was lost. accepted returns captured with capturedCharges=1; declined returns declined with capturedCharges=0. Restart never creates a second provider identity or provider call.`,
    vectors: paymentAttemptVectors,
  },
  {
    id: 'payment-integration-full-task-2-individual',
    skill: 'payment-integration',
    generation: 3,
    contract: `Input is exactly {canonical,events}. canonical is the authoritative provider lookup object. Each event is {id,kind,validSignature}, where validSignature is the independently verified signature result and may be missing or malformed. Return exactly {state,auditIds,rejectedIds}. Only events with validSignature === true are authenticated; reject false, missing, null, and truthy non-boolean results before audit/state changes and append their ids to rejectedIds in input order. For verified events, append each stable id at most once to auditIds in first-delivery order. A rejected delivery must not reserve its id: later verified delivery of the same id enters the audit once. Event kind and delivery order do not derive the payment totals: final state equals canonical exactly so shuffled, duplicate, delayed, and replayed deliveries converge to the authoritative provider lookup.`,
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
    generation: 2,
    contract: `Compute the GC root map of a paused JIT frame. solve(input) receives \`{ live: Array<{ vreg: string; kind: 'ref' | 'ref-dead' | 'int'; location: string }>, safepoint: boolean }\`. When \`safepoint\` is true, roots are exactly the \`location\` values of entries whose \`kind\` is 'ref', in the order the live entries appear. Ignore 'int' entries entirely and ignore 'ref-dead' entries: a dead reference contributes no root and its register or spill slot must not be reported. When \`safepoint\` is false the frame is not being collected, so return no roots. Always return \`{ roots: string[] }\`, including the empty array. Example: live [{vreg:'r1',kind:'ref',location:'stack:24'},{vreg:'i1',kind:'int',location:'reg:x0'}] at a safepoint yields { roots: ['stack:24'] }.`,
    vectors: gcRootVectors,
  },
  {
    id: 'refactor-implementation-full-task-1-individual',
    skill: 'refactor-implementation',
    generation: 2,
    contract: `Implement the public parser behavior independent of internal tokenizer/syntax/semantic structure. Each nonempty line must be key=value. Missing '=' yields one expected-equals diagnostic with 1-based line and no value. Unknown keys yield unknown-key diagnostics. If any diagnostic exists return {ok:false,value:null,diagnostics}; otherwise return parsed string values. Preserve diagnostic messages exactly as specified in vectors. Implement in candidate.ts, with optional candidate.test.ts tests. README.md, contract.json, and package.json are evaluator-owned fixed inputs; do not edit or replace them, including for documentation.`,
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
    generation: 2,
    contract: `Load save data atomically. Version 1 has items[] and equippedIndex; migrate to version 2 inventory entries {id:'item-<index>',kind} and equippedId or null. Version 2 must reject duplicate ids and otherwise preserve inventory/equippedId. Unknown version returns {ok:false,error:'unsupported-version'}. Invalid duplicate returns duplicate-id. Successful result includes ok:true,version:2,inventory,equippedId.`,
    vectors: saveMigrationVectors,
  },
  {
    id: 'networking-systems-full-task-1-individual',
    skill: 'networking-systems',
    generation: 2,
    contract: `Implement the pure solve(input) export in candidate.ts. Input is a synthetic trace with: dns { a:boolean, aaaa:boolean } (record presence by address family), routes { ipv4:boolean|null, ipv6:boolean|null }, tcp { ipv4:boolean|null, ipv6:boolean|null }, tls { ipv4:boolean|null, ipv6:boolean|null, reason?:string }, http { ipv4:boolean|null, ipv6:boolean|null }. Localize the first failed layer from evidence, without assuming topology. If DNS resolves but an address-family route is false, return {failingLayer:'route-<family>', nextProbe:'compare-<family>-route-source', safeControl:'prefer-<other>-temporarily'} when the other family works, otherwise a safe preserve control. If route/TCP succeed but TLS fails with reason 'certificate-name', return {failingLayer:'tls-sni-certificate', nextProbe:'verify-sni-and-certificate-chain', safeControl:'rollback-lb-tls-config'}. Inputs vary identifiers, values, ordering, and failure paths.`,
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
    generation: 2,
    contract: `Implement the pure solve(input) export in candidate.ts. Input has unit {user?:string, after?:string[], env?:Record<string,string>}, dropins: Array<{user?:string, after?:string[], env?:Record<string,string>}> applied in order, permissions { serviceUserCanWriteConfig:boolean }, and journal { cleanStart:boolean }. Compute effective systemd-like config by starting with unit then applying dropins in order (later layer overrides user when present; merge env by key with later override; after is stable unique concatenation preserving first-seen order). safe is true only when effective user is nonempty and not root-like (root or 0), permissions.serviceUserCanWriteConfig is false, and journal.cleanStart is true. Return {effective:{user,after,env},safe}.`,
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
    generation: 2,
    contract: `Build reference facts from active contract/runtime sources. Input is {openapi:{fields,errors},validator:{omittedDefaults,nullAllowed},handlerErrors,staleProseFields}. Return exactly {fields,errors,defaults,nullAllowed,deprecated,ignoredStaleFields}. fields are Object.keys(openapi.fields) in declaration order. errors are stable-unique openapi.errors followed by handlerErrors. defaults is validator.omittedDefaults and nullAllowed is validator.nullAllowed, preserving their supplied shapes. deprecated contains the field names whose openapi.fields entry has deprecated=true. ignoredStaleFields is staleProseFields unchanged. Do not invent behavior absent from active sources.`,
    vectors: apiReferenceVectors,
  },
  {
    id: 'reference-communication-full-task-2-individual',
    skill: 'reference-communication',
    generation: 2,
    contract: `Runtime behavior is authoritative when schema conflicts. Input is {schema:{enum,default},runtime:{enum,computedDefault},env:{name,omissionSensitive},cli:{flag,aliases}}. Return exactly {acceptedValues,default,conflicts,env,cli,deprecatedAliases}. acceptedValues is runtime.enum in runtime order. default is runtime.computedDefault. Add conflict schema-runtime-enum when the sorted schema.enum and runtime.enum sets differ; otherwise conflicts is empty. env is env.name, cli is cli.flag, and deprecatedAliases is cli.aliases unchanged.`,
    vectors: settingsReferenceVectors,
  },
];

const fixtures = createConceptFixtures(SYSTEMS_PROTOCOL_CONCEPTS);
export const SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS = fixtures.materializers;
export const SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS = fixtures.scorers;
