import { expect, test } from 'bun:test';
import {
  applySkillEvalExecutorReadiness,
  parseSkillEvalExecutorMode,
  resolveSkillEvalExecutor,
  selectSkillEvalExecutor,
  skillEvalCampaignHarnessVersion,
  SkillEvalExecutorUnavailableError,
  type SkillEvalExecutorDependencies,
  type SkillEvalExecutorDescriptor,
  type SkillEvalExecutorSelection,
} from './skill-v5-qualification-executor';
import type {
  SkillEvalExecutor,
  SkillEvalExecutionReadiness,
} from '../backend/src/eval/skills/skill-eval-execution';
import type { V5EvalEnvironmentKind } from '../backend/src/kory/skill-packages';

test('qualification executor parsing supports explicit modes and the legacy alias', () => {
  expect(parseSkillEvalExecutorMode(['--executor=omnirush-text-patch'], {})).toBe(
    'omnirush-text-patch',
  );
  expect(parseSkillEvalExecutorMode(['--executor=openrouter-text-patch'], {})).toBe(
    'openrouter-text-patch',
  );
  expect(parseSkillEvalExecutorMode(['--executor=opencode-text-patch'], {})).toBe(
    'opencode-text-patch',
  );
  expect(parseSkillEvalExecutorMode(['--executor=opencode-stateless-text-patch'], {})).toBe(
    'opencode-stateless-text-patch',
  );
  expect(
    parseSkillEvalExecutorMode([], { KORY_SKILL_EVAL_EXECUTOR: 'opencode-stateless-text-patch' }),
  ).toBe('opencode-stateless-text-patch');
  expect(parseSkillEvalExecutorMode(['--executor=native-stateless-text-patch'], {})).toBe(
    'native-stateless-text-patch',
  );
  expect(parseSkillEvalExecutorMode(['--executor=local-llama-text-patch'], {})).toBe(
    'local-llama-text-patch',
  );
  expect(parseSkillEvalExecutorMode(['--executor=codex'], {})).toBe('codex');
  expect(parseSkillEvalExecutorMode(['--text-patch'], {})).toBe('codex-text-patch');
  expect(parseSkillEvalExecutorMode([], { KORY_SKILL_EVAL_EXECUTOR: 'codex-text-patch' })).toBe(
    'codex-text-patch',
  );
  expect(parseSkillEvalExecutorMode([], {})).toBe('auto');
});

test('an invalid explicit executor fails closed', () => {
  expect(() => parseSkillEvalExecutorMode(['--executor=unknown'], {})).toThrow(
    'expected auto|codex|codex-text-patch|omnirush-text-patch|openrouter-text-patch|opencode-text-patch',
  );
});

function fixtureDependencies(
  options: {
    env?: NodeJS.ProcessEnv;
    codexAvailable?: boolean;
    factory?: SkillEvalExecutorDependencies['create'];
  } = {},
) {
  const calls: Parameters<SkillEvalExecutorDependencies['create']>[0][] = [];
  let probes = 0;
  const dependencies: SkillEvalExecutorDependencies = {
    env: options.env ?? {},
    isCodexAvailable: () => {
      probes += 1;
      return options.codexAvailable ?? true;
    },
    create: (input) => {
      calls.push(input);
      return options.factory?.(input) ?? fakeExecutor(input);
    },
  };
  return { dependencies, calls, probes: () => probes };
}

function fakeExecutor(
  input: Parameters<SkillEvalExecutorDependencies['create']>[0],
): SkillEvalExecutor {
  return {
    id: `fixture:${input.mode}`,
    subject: input.mode === 'codex' || input.mode === 'codex-text-patch' ? 'codex' : 'other',
    provider:
      input.mode === 'omnirush-text-patch'
        ? 'omnirush'
        : input.mode === 'openrouter-text-patch'
          ? 'openrouter'
          : input.mode === 'opencode-text-patch' || input.mode === 'opencode-stateless-text-patch'
            ? 'opencode'
            : input.mode === 'local-llama-text-patch'
              ? 'local-llama'
              : input.mode === 'native-stateless-text-patch'
                ? 'native-cli'
                : 'codex',
    model: input.model,
    runtimeIdentity: `fixture-runtime:${input.mode}`,
    tools: [],
    budget: { wallClockMs: input.wallClockMs },
    execute: async () => {
      throw new Error('Selection tests must never execute a campaign.');
    },
  };
}

const selectionOptions = { wallClockMs: 180_000, reasoningEffort: 'none' };

test('native stateless selection is explicit, uses its measured model, and never probes Codex', () => {
  const fixture = fixtureDependencies({
    env: { KORY_SKILL_EVAL_MODEL: 'wrong-ambient-model' },
    codexAvailable: false,
  });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'native-stateless-text-patch' },
    fixture.dependencies,
  );
  expect(fixture.calls.map((call) => [call.mode, call.model])).toEqual([
    ['native-stateless-text-patch', 'gpt-6.1-sol'],
  ]);
  expect(selected.descriptor.provider).toBe('native-cli');
  expect(fixture.probes()).toBe(0);
  const readiness = applySkillEvalExecutorReadiness(
    ['synthetic', 'repository', 'cli', 'browser'].map((kind) => ({
      skill: 'test-skill',
      scenarioId: kind,
      startingState: 'red',
      materializerId: 'fixture',
      deterministicScorerId: 'fixture',
      ready: true,
      reasons: [],
    })),
    ['synthetic', 'repository', 'cli', 'browser'].map((kind) => ({
      skill: 'test-skill',
      id: kind,
      environmentKind: kind as V5EvalEnvironmentKind,
    })),
    selected,
  );
  expect(readiness.map((row) => row.ready)).toEqual([true, true, true, false]);
  expect(readiness[3]!.reasons[0]).toContain('cannot execute browser');
});

test('local llama selection does not use Codex and cannot contribute unverified promotion evidence', () => {
  const fixture = fixtureDependencies({ codexAvailable: false });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'local-llama-text-patch' },
    fixture.dependencies,
  );
  expect(selected.descriptor.provider).toBe('local-llama');
  expect(selected.descriptor.model).toBe('qwen2.5-coder-14b-instruct-q4_k_m');
  expect(fixture.probes()).toBe(0);
  const readiness = applySkillEvalExecutorReadiness(
    [
      {
        skill: 'planning',
        scenarioId: 'task1',
        startingState: 'red',
        materializerId: 'fixture',
        deterministicScorerId: 'fixture',
        ready: true,
        reasons: [],
      },
    ],
    [{ skill: 'planning', id: 'task1', environmentKind: 'synthetic' }],
    selected,
  );
  expect(readiness[0]!.ready).toBe(false);
  expect(readiness[0]!.reasons.join(' ')).toContain('quarantined');
});

test('explicit native unavailable route never falls back to Codex', () => {
  const fixture = fixtureDependencies({
    factory: () => {
      throw new Error('Native stateless text-patch executor is unavailable: details redacted.');
    },
  });
  const selected = resolveSkillEvalExecutor(
    { ...selectionOptions, mode: 'native-stateless-text-patch', dryRun: true },
    fixture.dependencies,
  );
  expect(selected.status).toBe('unavailable');
  expect(fixture.calls.map((call) => call.mode)).toEqual(['native-stateless-text-patch']);
  expect(fixture.probes()).toBe(0);
});

test('auto prefers OmniRush and retains the single factory result and its real identity', () => {
  let constructed: SkillEvalExecutor | undefined;
  const fixture = fixtureDependencies({
    factory: (input) => {
      constructed = fakeExecutor(input);
      return constructed;
    },
  });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'auto' },
    fixture.dependencies,
  );
  expect(fixture.calls.map((call) => [call.mode, call.model])).toEqual([
    ['omnirush-text-patch', 'gpt-6-astra'],
  ]);
  expect(fixture.calls[0]?.reasoningEffort).toBe('none');
  expect(fixture.probes()).toBe(0);
  expect(selected.executor).toBe(constructed!);
  expect(selected.descriptor).toEqual({
    mode: 'omnirush-text-patch',
    id: constructed!.id,
    provider: constructed!.provider,
    model: constructed!.model,
    runtimeIdentity: constructed!.runtimeIdentity,
  });
});

test('model defaults are ecosystem-specific, including after auto fallback', () => {
  const env = {
    KORY_SKILL_EVAL_MODEL: ' codex-default ',
    KORY_SKILL_EVAL_OMNIRUSH_MODEL: ' omnirush-default ',
  };
  for (const mode of [
    'omnirush-text-patch',
    'openrouter-text-patch',
    'opencode-text-patch',
    'opencode-stateless-text-patch',
    'codex',
    'codex-text-patch',
  ] as const) {
    const fixture = fixtureDependencies({ env });
    const selected = selectSkillEvalExecutor({ ...selectionOptions, mode }, fixture.dependencies);
    expect(selected.descriptor.model).toBe(
      mode === 'omnirush-text-patch'
        ? 'omnirush-default'
        : mode === 'openrouter-text-patch'
          ? 'openrouter/openrouter/free'
          : mode === 'opencode-text-patch' || mode === 'opencode-stateless-text-patch'
            ? 'openrouter/openrouter/free'
            : 'codex-default',
    );
  }
  const fixture = fixtureDependencies({
    env,
    factory: (input) => {
      if (input.mode === 'omnirush-text-patch')
        throw new SkillEvalExecutorUnavailableError('candidate missing');
      return fakeExecutor(input);
    },
  });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'auto' },
    fixture.dependencies,
  );
  expect(selected.descriptor.mode).toBe('codex');
  expect(fixture.calls.map((call) => call.model)).toEqual(['omnirush-default', 'codex-default']);
});

test('auto treats an installed but unusable OmniRush runtime as an unavailable candidate', () => {
  const fixture = fixtureDependencies({
    factory: (input) => {
      if (input.mode === 'omnirush-text-patch')
        throw new Error('Omnirush CLI version probe failed.');
      return fakeExecutor(input);
    },
  });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'auto' },
    fixture.dependencies,
  );
  expect(selected.descriptor.mode).toBe('codex');
  expect(fixture.calls.map((call) => call.mode)).toEqual(['omnirush-text-patch', 'codex']);
});

test('the generic Codex environment model cannot override the OmniRush default', () => {
  const fixture = fixtureDependencies({ env: { KORY_SKILL_EVAL_MODEL: 'codex-only' } });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'auto' },
    fixture.dependencies,
  );
  expect(selected.descriptor.model).toBe('gpt-6-astra');
});

test('explicit model overrides defaults and stays explicit on auto fallback', () => {
  const fixture = fixtureDependencies({
    env: { KORY_SKILL_EVAL_MODEL: 'ignored', KORY_SKILL_EVAL_OMNIRUSH_MODEL: 'ignored' },
    factory: (input) => {
      if (input.mode === 'omnirush-text-patch')
        throw new SkillEvalExecutorUnavailableError('candidate missing');
      return fakeExecutor(input);
    },
  });
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'auto', model: ' explicit-model ' },
    fixture.dependencies,
  );
  expect(selected.descriptor.model).toBe('explicit-model');
  expect(fixture.calls.map((call) => call.model)).toEqual(['explicit-model', 'explicit-model']);
});

test('invalid model is fatal rather than treated as a missing candidate, even in dry-run auto', () => {
  for (const message of [
    'OmniRush model invalid is not present in its authoritative CLI catalog.',
    'Model not found',
  ]) {
    const fixture = fixtureDependencies({
      factory: () => {
        throw new Error(message);
      },
    });
    expect(() =>
      resolveSkillEvalExecutor(
        { ...selectionOptions, mode: 'auto', model: 'invalid', dryRun: true },
        fixture.dependencies,
      ),
    ).toThrow(message);
    expect(fixture.calls.map((call) => call.mode)).toEqual(['omnirush-text-patch']);
    expect(fixture.probes()).toBe(0);
  }
});

test('explicit modes select exactly that path without fallback', () => {
  for (const mode of [
    'codex',
    'codex-text-patch',
    'omnirush-text-patch',
    'openrouter-text-patch',
    'opencode-text-patch',
    'opencode-stateless-text-patch',
  ] as const) {
    const fixture = fixtureDependencies();
    const selected = selectSkillEvalExecutor({ ...selectionOptions, mode }, fixture.dependencies);
    expect(selected.descriptor.mode).toBe(mode);
    expect(fixture.calls.map((call) => call.mode)).toEqual([mode]);
    const unavailable = fixtureDependencies({
      factory: () => {
        throw new SkillEvalExecutorUnavailableError('candidate missing');
      },
    });
    expect(() =>
      selectSkillEvalExecutor({ ...selectionOptions, mode }, unavailable.dependencies),
    ).toThrow('candidate missing');
    expect(unavailable.calls.map((call) => call.mode)).toEqual([mode]);
  }
});

test('Codex binary/auth absence fails before factory construction', () => {
  const fixture = fixtureDependencies({ codexAvailable: false });
  expect(() =>
    selectSkillEvalExecutor({ ...selectionOptions, mode: 'codex' }, fixture.dependencies),
  ).toThrow(SkillEvalExecutorUnavailableError);
  expect(fixture.calls).toEqual([]);
  expect(fixture.probes()).toBe(1);
});

test('unavailable dry-run reports no executable descriptor and cannot mark scenarios ready', () => {
  for (const mode of [
    'auto',
    'codex',
    'codex-text-patch',
    'omnirush-text-patch',
    'openrouter-text-patch',
    'opencode-text-patch',
    'opencode-stateless-text-patch',
  ] as const) {
    const fixture = fixtureDependencies({
      codexAvailable: false,
      factory: () => {
        throw new SkillEvalExecutorUnavailableError('candidate missing');
      },
    });
    const selected = resolveSkillEvalExecutor(
      { ...selectionOptions, mode, dryRun: true },
      fixture.dependencies,
    );
    expect(selected.status).toBe('unavailable');
    expect(selected.descriptor).toBeNull();
    expect(selected.executor).toBeNull();
    const rows = applySkillEvalExecutorReadiness(
      [readyRow('task')],
      [{ skill: 'fixture', id: 'task', environmentKind: 'repository' }],
      selected,
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.reasons.join(' ')).toContain('Executor unavailable/unverified');
    expect(() =>
      resolveSkillEvalExecutor({ ...selectionOptions, mode, dryRun: false }, fixture.dependencies),
    ).toThrow(SkillEvalExecutorUnavailableError);
  }
});

test('factory provider/model mismatches and empty runtime identities fail before dispatch', () => {
  for (const overrides of [
    { provider: 'codex' },
    { model: 'different' },
    { id: '' },
    { runtimeIdentity: '' },
  ]) {
    const fixture = fixtureDependencies({
      factory: (input) => ({ ...fakeExecutor(input), ...overrides }),
    });
    expect(() =>
      selectSkillEvalExecutor({ ...selectionOptions, mode: 'auto' }, fixture.dependencies),
    ).toThrow('factory returned');
    expect(fixture.calls).toHaveLength(1);
  }
});

function readyRow(scenarioId: string): SkillEvalExecutionReadiness {
  return {
    skill: 'fixture',
    scenarioId,
    startingState: 'fixture-start',
    materializerId: 'fixture-materializer',
    deterministicScorerId: 'fixture-scorer',
    ready: true,
    reasons: [],
  };
}

test('supported text-patch paths block browser/device/public-web before queue selection', () => {
  const kinds: V5EvalEnvironmentKind[] = [
    'synthetic',
    'repository',
    'cli',
    'browser',
    'device',
    'public-web',
  ];
  const original = kinds.map(readyRow);
  const scenarios = kinds.map((kind) => ({ skill: 'fixture', id: kind, environmentKind: kind }));
  for (const mode of [
    'omnirush-text-patch',
    'codex-text-patch',
    'openrouter-text-patch',
    'codex',
  ] as const) {
    const selected = selectSkillEvalExecutor(
      { ...selectionOptions, mode },
      fixtureDependencies().dependencies,
    );
    const rows = applySkillEvalExecutorReadiness(original, scenarios, selected);
    expect(rows.filter((row) => row.ready).map((row) => row.scenarioId)).toEqual(
      mode === 'codex' ? kinds : kinds.slice(0, 3),
    );
    for (const row of rows.filter((row) => !row.ready)) {
      expect(row.reasons.join(' ')).toContain(
        `${mode} cannot execute ${row.scenarioId} environments`,
      );
    }
  }
  expect(original.every((row) => row.ready && row.reasons.length === 0)).toBe(true);
});

test('quarantined OpenCode execution cannot queue locally ready or external scenarios', () => {
  const kinds: V5EvalEnvironmentKind[] = [
    'synthetic',
    'repository',
    'cli',
    'browser',
    'device',
    'public-web',
  ];
  const original = kinds.map(readyRow);
  for (const mode of ['opencode-text-patch', 'opencode-stateless-text-patch'] as const) {
    const selected = selectSkillEvalExecutor(
      { ...selectionOptions, mode },
      fixtureDependencies().dependencies,
    );
    const rows = applySkillEvalExecutorReadiness(
      original,
      kinds.map((kind) => ({ skill: 'fixture', id: kind, environmentKind: kind })),
      selected,
    );
    expect(rows.every((row) => !row.ready)).toBe(true);
    expect(rows.every((row) => row.reasons.join(' ').includes('isolation boundary'))).toBe(true);
  }
  expect(original.every((row) => row.ready && row.reasons.length === 0)).toBe(true);
});

test('executor compatibility preserves existing host blockers and fails closed on missing environment', () => {
  const selected = selectSkillEvalExecutor(
    { ...selectionOptions, mode: 'omnirush-text-patch' },
    fixtureDependencies().dependencies,
  );
  const blocked = { ...readyRow('blocked'), ready: false, reasons: ['host runtime missing'] };
  const rows = applySkillEvalExecutorReadiness(
    [blocked, readyRow('unknown')],
    [{ skill: 'fixture', id: 'blocked', environmentKind: 'browser' }],
    selected,
  );
  expect(rows.every((row) => !row.ready)).toBe(true);
  expect(rows[0]!.reasons).toHaveLength(2);
  expect(rows[0]!.reasons[0]).toBe('host runtime missing');
  expect(rows[1]!.reasons.join(' ')).toContain('unknown environments');
});

test('harness identity stays distinct across paths and execution-affecting settings', () => {
  const selections = [
    'codex',
    'codex-text-patch',
    'omnirush-text-patch',
    'openrouter-text-patch',
    'opencode-text-patch',
    'opencode-stateless-text-patch',
  ].map((mode) =>
    selectSkillEvalExecutor(
      { ...selectionOptions, mode: mode as SkillEvalExecutorDescriptor['mode'] },
      fixtureDependencies().dependencies,
    ),
  );
  const version = (
    selection: Extract<SkillEvalExecutorSelection, { status: 'available' }>,
    overrides: Partial<Parameters<typeof skillEvalCampaignHarnessVersion>[0]> = {},
  ) =>
    skillEvalCampaignHarnessVersion({
      descriptor: selection.descriptor,
      executionMode: 'multi-turn',
      reasoningEffort: 'none',
      wallClockMs: 180_000,
      evaluationContractHash: 'contract',
      ...overrides,
    });
  expect(new Set(selections.map((selection) => version(selection))).size).toBe(6);
  const selection = selections[0]!;
  const baseline = version(selection);
  for (const field of ['mode', 'id', 'provider', 'model', 'runtimeIdentity'] as const) {
    const descriptor = {
      ...selection.descriptor,
      [field]: field === 'mode' ? 'codex-text-patch' : 'different',
    } as SkillEvalExecutorDescriptor;
    expect(version(selection, { descriptor })).not.toBe(baseline);
  }
  for (const overrides of [
    { executionMode: 'single-native-call' },
    { reasoningEffort: 'high' },
    { wallClockMs: 200_000 },
    { evaluationContractHash: 'new-contract' },
  ]) {
    expect(version(selection, overrides)).not.toBe(baseline);
  }
});

test('explicit mode beats legacy switches and force never changes the default executor', () => {
  const env = { KORY_SKILL_EVAL_EXECUTOR: 'omnirush-text-patch', KORY_SKILL_EVAL_TEXT_PATCH: '1' };
  expect(parseSkillEvalExecutorMode(['--executor=codex', '--text-patch', '--force'], env)).toBe(
    'codex',
  );
  expect(parseSkillEvalExecutorMode(['--executor=auto', '--text-patch'], env)).toBe('auto');
  expect(parseSkillEvalExecutorMode(['--force'], {})).toBe('auto');
  expect(() => parseSkillEvalExecutorMode(['--executor='], env)).toThrow('requires a mode');
});

test('stateless runtime absence is unavailable in dry-run without any Codex probe or fallback', () => {
  const fixture = fixtureDependencies({
    factory: () => {
      throw new Error('OpenCode stateless text-patch executor is unavailable: uninspected version');
    },
  });
  const selected = resolveSkillEvalExecutor(
    { ...selectionOptions, mode: 'opencode-stateless-text-patch', dryRun: true },
    fixture.dependencies,
  );
  expect(selected.status).toBe('unavailable');
  expect(fixture.calls.map((call) => call.mode)).toEqual(['opencode-stateless-text-patch']);
  expect(fixture.probes()).toBe(0);
});
