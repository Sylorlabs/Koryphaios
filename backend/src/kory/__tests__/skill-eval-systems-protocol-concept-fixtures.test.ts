import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SYSTEMS_PROTOCOL_CONCEPTS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-systems-protocol-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('systems protocol concept fixtures', () => {
  test('explicit scenarios honor the selected full-task materializer and its blockers', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    const dedicatedFinopsMaterializers = new Map([
      [
        'finops-cloud-cost-full-task-1-individual',
        'finops-cloud-cost/reconciled-ledger-full-task@3',
      ],
      [
        'finops-cloud-cost-full-task-2-individual',
        'finops-cloud-cost/commitment-ledger-full-task@4',
      ],
    ]);
    expect(SYSTEMS_PROTOCOL_CONCEPTS).toHaveLength(26);
    for (const definition of SYSTEMS_PROTOCOL_CONCEPTS) {
      const row = readiness.find((item) => item.scenarioId === definition.id);
      const dedicatedFinopsMaterializer = dedicatedFinopsMaterializers.get(definition.id);
      if (dedicatedFinopsMaterializer) {
        expect(row?.materializerId, definition.id).toBe(dedicatedFinopsMaterializer);
        expect(row?.ready, definition.id).toBe(true);
      } else {
        expect(row?.ready, definition.id).toBe(!definition.blockers?.length);
      }
    }
  }, 30_000);

  test('representative scenarios start red before implementation', async () => {
    for (const definition of [
      SYSTEMS_PROTOCOL_CONCEPTS[0]!,
      SYSTEMS_PROTOCOL_CONCEPTS[10]!,
      SYSTEMS_PROTOCOL_CONCEPTS[14]!,
      SYSTEMS_PROTOCOL_CONCEPTS[20]!,
    ]) {
      const skillPackage = loadV5SkillPackages().packages.find(
        (item) => item.sidecar.name === definition.skill,
      )!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (item) => item.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-systems-protocol-test-'));
      roots.push(root);
      const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      await materializer.materialize(root, scenario);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scenario.id).toBe(false);
    }
  }, 20_000);

  test('email deliverability contract requires evidence status and task-scoped operating coverage', async () => {
    const definition = SYSTEMS_PROTOCOL_CONCEPTS.find(
      (item) => item.id === 'email-delivery-full-task-1-individual',
    )!;
    expect(definition.generation).toBe(6);
    expect(definition.vectors()).toHaveLength(8);
    for (const term of [
      'authentication:{dnsRecords:{spf,dkim,dmarc}',
      'evidenceStatus',
      'Preserve identity, complaints, and bounces unchanged',
      'provider-specific-hypothesis',
      "dnsChangeRecommended=true only when faultSurface='dns-record'",
      "trimmed DKIM record starts with 'v=DKIM1;'",
      'operatingGaps are ordered among stream-boundary',
      "stream='transactional-isolated'",
      "retry='transient-only'",
      'signals is exactly {reputation,complaints,bounces,content}',
      'Each experiments entry is exactly {id,change,bound}',
      'placement is observed only when both gmail and microsoft placements',
      'recovery for misalignment is',
    ])
      expect(definition.contract).toContain(term);
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === definition.skill,
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === definition.id,
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-email-delivery-test-'));
    roots.push(root);
    const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    expect(materializer.id).toEndWith('/concept@6');
    expect(scorer.id).toEndWith('/concept-scorer@6');
    await materializer.materialize(root, scenario);

    writeFileSync(
      join(root, 'candidate.ts'),
      `export function solve(input: any) {
  const authProblem = !input.authentication.dmarcPass || (!input.authentication.spfAligned && !input.authentication.dkimAligned);
  return { authProblem, likelyFocus: authProblem ? ['alignment'] : ['provider-reputation'], experiment: authProblem ? 'header-alignment-control' : 'controlled-seed-and-volume-ramp' };
}\n`,
    );
    const narrow = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(narrow.passed).toBe(false);
    expect(narrow.quality).toBe(0);

    const completeCandidate = `export function solve(input: any) {
  const evidencePriority = ['received-headers', 'dns-and-provider-config', 'provider-events', 'seed-placement'];
  const controls = input.controls;
  const operatingGaps = [];
  if (controls.stream !== 'transactional-isolated') operatingGaps.push('stream-boundary');
  if (!controls.suppressionBeforeProvider) operatingGaps.push('suppression-before-provider');
  if (controls.unsubscribe === 'required-missing') operatingGaps.push('unsubscribe-policy');
  if (controls.rateLimit !== 'bounded-deferral') operatingGaps.push('rate-limit-policy');
  if (controls.retry !== 'transient-only') operatingGaps.push('retry-policy');
  if (controls.failover !== 'state-preserving') operatingGaps.push('failover-state');
  const auth = input.authentication;
  const authComplete = Boolean(auth.dnsRecords.spf && auth.dnsRecords.dkim && auth.dnsRecords.dmarc && auth.received.spf?.result && auth.received.spf?.domain && auth.received.dkim?.result && auth.received.dkim?.domain && auth.received.dkim?.selector && auth.received.dmarc?.result);
  const evidenceStatus = {
    authentication: authComplete ? 'observed' : 'unavailable',
    reputation: 'unresolved',
    placement: ['inbox', 'spam', 'junk'].includes(input.placement?.gmail) && ['inbox', 'spam', 'junk'].includes(input.placement?.microsoft) ? 'observed' : 'unavailable',
    providerEvents: controls.providerEvents === 'observed' ? 'observed' : 'unavailable',
    rendering: controls.templateRender === 'observed' ? 'observed' : 'unavailable',
    unsubscribe: controls.unsubscribe === 'not-applicable' ? 'not-applicable' : controls.unsubscribe === 'required-configured' ? 'observed' : 'gap',
    retry: controls.retry === 'transient-only' ? 'observed' : 'gap',
    failover: controls.failover === 'state-preserving' ? 'observed' : 'gap',
  };
  const finishRecovery = (items: string[]) => operatingGaps.length ? [...items, 'block-expansion-until-operating-gaps-close'] : items;
  if (!authComplete) return {
    authentication: 'unresolved', identity: input.identity, evidencePriority, evidenceStatus,
    signals: { reputation: 'unresolved-until-auth-evidence', complaints: input.complaints, bounces: input.bounces, content: input.contentRisk ? 'observed-risk' : 'no-observed-risk' },
    operatingGaps,
    hypotheses: ['authentication-evidence-gap'],
    experiments: [{ id: 'authentication-evidence-control', change: 'collect-dns-and-received-auth-evidence', bound: 'one-sending-subdomain' }],
    successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
    recovery: finishRecovery(['do-not-change-dns-without-fault-localization', 'recheck-placement-after-auth-evidence']),
    dnsChangeRecommended: false,
  };
  const authShapeValid = auth.dnsRecords.spf.trim().startsWith('v=spf1')
    && auth.dnsRecords.dkim.trim().startsWith('v=DKIM1;')
    && auth.dnsRecords.dmarc.trim().startsWith('v=DMARC1;');
  if (!authShapeValid) return {
    authentication: 'unresolved', identity: input.identity, evidencePriority, evidenceStatus: { ...evidenceStatus, authentication: 'unresolved' },
    signals: { reputation: 'unresolved-until-auth-evidence', complaints: input.complaints, bounces: input.bounces, content: input.contentRisk ? 'observed-risk' : 'no-observed-risk' },
    operatingGaps,
    hypotheses: ['authentication-evidence-invalid'],
    experiments: [{ id: 'authentication-evidence-validation', change: 'validate-dns-record-shape-and-received-auth-fields', bound: 'one-sending-subdomain' }],
    successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
    recovery: finishRecovery(['do-not-change-dns-without-validating-record-evidence', 'recheck-placement-after-auth-evidence']),
    dnsChangeRecommended: false,
  };
  const misaligned = auth.received.dmarc.result !== 'pass' || (!auth.received.spf.aligned && !auth.received.dkim.aligned);
  if (misaligned) return {
    authentication: 'misaligned', identity: input.identity, evidencePriority, evidenceStatus,
    signals: { reputation: 'unresolved-until-auth-control', complaints: input.complaints, bounces: input.bounces, content: input.contentRisk ? 'observed-risk' : 'no-observed-risk' },
    operatingGaps,
    hypotheses: ['alignment'],
    experiments: [{ id: 'header-alignment-control', change: 'align-authenticated-identities', bound: 'one-sending-subdomain' }],
    successMetrics: ['dmarc-pass-rate', 'microsoft-inbox-rate', 'gmail-inbox-rate'],
    recovery: finishRecovery(['revert-identity-change-if-auth-regresses', 'recheck-placement-after-auth-control']),
    dnsChangeRecommended: auth.faultSurface === 'dns-record',
  };
  const providerSpecific = input.placement.gmail === 'inbox' && input.placement.microsoft === 'junk';
  evidenceStatus.reputation = providerSpecific ? 'inferred' : 'unresolved';
  const hypotheses = providerSpecific ? ['provider-reputation'] : [];
  if (input.volumeJump >= 3) hypotheses.push('warm-up');
  if (input.complaints === 'elevated') hypotheses.push('complaints');
  if (input.bounces === 'elevated') hypotheses.push('bounces');
  if (input.contentRisk) hypotheses.push('message-construction');
  const experiments: any[] = [];
  if (providerSpecific) experiments.push({ id: 'microsoft-seed-control', change: 'hold-content-and-auth-constant', bound: 'microsoft-seed-cohort' });
  if (input.volumeJump >= 3) experiments.push({ id: 'volume-ramp', change: 'step-volume-only', bound: 'new-sending-subdomain' });
  if (input.contentRisk) experiments.push({ id: 'message-construction-control', change: 'remove-one-content-risk', bound: 'seed-cohort-only' });
  const successMetrics = ['microsoft-inbox-rate', 'complaint-rate', 'hard-bounce-rate', 'provider-acceptance-rate'];
  const recovery = input.contentRisk
    ? ['restore-original-message-if-placement-worsens', 'keep-elevated-complaint-or-bounce-signal-open', 'recheck-placement-before-expanding']
    : input.volumeJump >= 3
      ? ['stop-ramp-on-complaint-or-bounce-regression', 'recheck-placement-before-expanding']
      : ['recheck-placement-before-expanding'];
  return {
    authentication: 'aligned', identity: input.identity, evidencePriority, evidenceStatus,
    signals: { reputation: providerSpecific ? 'provider-specific-hypothesis' : 'unresolved', complaints: input.complaints, bounces: input.bounces, content: input.contentRisk ? 'observed-risk' : 'no-observed-risk' },
    operatingGaps, hypotheses, experiments, successMetrics, recovery: finishRecovery(recovery), dnsChangeRecommended: false,
  };
}\n`;
    writeFileSync(join(root, 'candidate.ts'), completeCandidate);
    const complete = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(complete.passed).toBe(true);
    expect(complete.quality).toBe(1);
    expect(complete.verification).toBe(1);

    // The archived failed candidates labeled every placement 'observed', even without evidence.
    const unconditionalPlacement = completeCandidate.replace(
      "placement: ['inbox', 'spam', 'junk'].includes(input.placement?.gmail) && ['inbox', 'spam', 'junk'].includes(input.placement?.microsoft) ? 'observed' : 'unavailable',",
      "placement: 'observed',",
    );
    expect(unconditionalPlacement).not.toBe(completeCandidate);
    writeFileSync(join(root, 'candidate.ts'), unconditionalPlacement);
    const regression = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(regression.passed).toBe(false);
    expect(regression.quality).toBe(7 / 8);
  });

  test('payment contracts expose the exact input and output structures scored by deep equality', async () => {
    const packages = loadV5SkillPackages().packages;
    const cases = [
      {
        id: 'payment-integration-full-task-1-individual',
        generation: 2,
        requiredContractTerms: [
          'Input is exactly {orderId,prior,attempt,webhook,restart}',
          'prior is null or {providerId,state}',
          'attempt is null or {providerOutcome,providerId}',
          'Return exactly {idempotencyKey,providerCalls,state,capturedCharges,providerId}',
        ],
        candidate: `export function solve(input: any) {
  const idempotencyKey = \`payment:\${input.orderId}\`;
  const providerCalls = input.prior ? 0 : input.attempt ? 1 : 0;
  const providerId = input.prior?.providerId ?? input.attempt?.providerId;
  let state = input.prior?.state ?? 'pending';
  let capturedCharges = state === 'captured' ? 1 : 0;
  if (!input.prior && input.attempt) {
    if (input.attempt.providerOutcome === 'accepted-response-lost') {
      state = 'reconcile';
      capturedCharges = 1;
    } else if (input.attempt.providerOutcome === 'accepted') {
      state = 'captured';
      capturedCharges = 1;
    } else if (input.attempt.providerOutcome === 'declined') {
      state = 'declined';
      capturedCharges = 0;
    }
  }
  if (input.webhook?.providerId === providerId && input.webhook.state === 'captured') {
    state = 'captured';
    capturedCharges = 1;
  }
  return { idempotencyKey, providerCalls, state, capturedCharges, providerId };
}\n`,
      },
      {
        id: 'payment-integration-full-task-2-individual',
        generation: 3,
        requiredContractTerms: [
          'Input is exactly {canonical,events}',
          'Each event is {id,kind,validSignature}',
          'Return exactly {state,auditIds,rejectedIds}',
          'Only events with validSignature === true are authenticated',
          'A rejected delivery must not reserve its id',
          'final state equals canonical exactly',
        ],
        candidate: `export function solve(input: any) {
  const auditIds: string[] = [];
  const rejectedIds: string[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (event.validSignature !== true) {
      rejectedIds.push(event.id);
      continue;
    }
    if (!seen.has(event.id)) {
      seen.add(event.id);
      auditIds.push(event.id);
    }
  }
  return { state: input.canonical, auditIds, rejectedIds };
}\n`,
      },
    ] as const;

    for (const item of cases) {
      const definition = SYSTEMS_PROTOCOL_CONCEPTS.find((entry) => entry.id === item.id)!;
      expect(definition.generation).toBe(item.generation);
      for (const term of item.requiredContractTerms) expect(definition.contract).toContain(term);

      const skillPackage = packages.find((entry) => entry.sidecar.name === definition.skill)!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (entry) => entry.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-payment-integration-test-'));
      roots.push(root);
      const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((entry) =>
        entry.matches(scenario),
      )!;
      const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((entry) =>
        entry.scenarioIds.includes(scenario.id),
      )!;
      expect(materializer.id).toEndWith(`/concept@${item.generation}`);
      expect(scorer.id).toEndWith(`/concept-scorer@${item.generation}`);

      await materializer.materialize(root, scenario);
      if (item.id === 'payment-integration-full-task-2-individual') {
        // This literal-false check passed the prior 2-vector oracle even though
        // truthy non-boolean values were incorrectly admitted as authenticated.
        writeFileSync(
          join(root, 'candidate.ts'),
          `export function solve(input: any) {
  const auditIds: string[] = [];
  const rejectedIds: string[] = [];
  const seen = new Set<string>();
  for (const event of input.events) {
    if (event.validSignature === false) {
      rejectedIds.push(event.id);
      continue;
    }
    if (!seen.has(event.id)) {
      seen.add(event.id);
      auditIds.push(event.id);
    }
  }
  return { state: input.canonical, auditIds, rejectedIds };
}\n`,
        );
        const unsafe = await scorer.score({
          scenario,
          experiment: {} as never,
          workingDirectory: root,
          observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
        });
        expect(unsafe.passed).toBe(false);
        expect(unsafe.quality).toBeCloseTo(2 / 3);
        expect(unsafe.verification).toBe(0);
        expect(
          unsafe.evidence.some((line) => line.includes('unverified truthy or missing signatures')),
        ).toBe(true);
      }
      writeFileSync(join(root, 'candidate.ts'), item.candidate);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, item.id).toBe(true);
      expect(score.quality, item.id).toBe(1);
      expect(score.verification, item.id).toBe(1);
    }
  });

  test('reference communication contracts expose the source representation they score', async () => {
    const packages = loadV5SkillPackages().packages;
    const cases = [
      {
        id: 'reference-communication-full-task-1-individual',
        requiredContractTerms: [
          'validator:{omittedDefaults,nullAllowed}',
          'handlerErrors',
          'staleProseFields',
          'ignoredStaleFields',
        ],
        candidate: `export function solve(input: any) {
  const fields = Object.keys(input.openapi.fields);
  return {
    fields,
    errors: [...new Set([...input.openapi.errors, ...input.handlerErrors])],
    defaults: input.validator.omittedDefaults,
    nullAllowed: input.validator.nullAllowed,
    deprecated: fields.filter((field) => input.openapi.fields[field].deprecated === true),
    ignoredStaleFields: input.staleProseFields,
  };
}\n`,
      },
      {
        id: 'reference-communication-full-task-2-individual',
        requiredContractTerms: [
          'cli:{flag,aliases}',
          'Return exactly {acceptedValues,default,conflicts,env,cli,deprecatedAliases}',
        ],
        candidate: `function normalizedSet(values: string[]) {
  return [...new Set(values)].sort();
}
export function solve(input: any) {
  const schema = normalizedSet(input.schema.enum);
  const runtime = normalizedSet(input.runtime.enum);
  const same = schema.length === runtime.length && schema.every((value, index) => value === runtime[index]);
  return {
    acceptedValues: [...input.runtime.enum],
    default: input.runtime.computedDefault,
    conflicts: same ? [] : ['schema-runtime-enum'],
    env: input.env.name,
    cli: input.cli.flag,
    deprecatedAliases: [...input.cli.aliases],
  };
}\n`,
      },
    ] as const;

    for (const item of cases) {
      const definition = SYSTEMS_PROTOCOL_CONCEPTS.find((entry) => entry.id === item.id)!;
      expect(definition.generation).toBe(2);
      for (const term of item.requiredContractTerms) expect(definition.contract).toContain(term);

      const skillPackage = packages.find((entry) => entry.sidecar.name === definition.skill)!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (entry) => entry.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-reference-communication-test-'));
      roots.push(root);
      const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((entry) =>
        entry.matches(scenario),
      )!;
      const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((entry) =>
        entry.scenarioIds.includes(scenario.id),
      )!;
      expect(materializer.id).toEndWith('/concept@2');
      expect(scorer.id).toEndWith('/concept-scorer@2');

      await materializer.materialize(root, scenario);
      writeFileSync(join(root, 'candidate.ts'), item.candidate);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, item.id).toBe(true);
      expect(score.quality, item.id).toBe(1);
      expect(score.verification, item.id).toBe(1);
    }
  });
});
