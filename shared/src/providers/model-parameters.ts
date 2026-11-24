// User-tunable model request parameters
// Domain: provider-reported sampling/limits controls surfaced in the composer

export type ModelParameterKey =
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'top_a'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'repetition_penalty'
  | 'seed'
  | 'max_tokens'
  | 'verbosity';

export interface ModelParameterDef {
  key: ModelParameterKey;
  label: string;
  kind: 'float' | 'integer' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Provider-reported model default, else the documented conventional
   *  default. Absent when no value is known — the provider still applies its
   *  own default when the key is unset. */
  default?: number | string;
  defaultSource?: 'provider' | 'documented';
  /** One short sentence shown under the label in the settings panel. */
  description: string;
}

export type ModelParameterValues = Partial<Record<ModelParameterKey, number | string>>;

/** Parameter keys owned by the harness — they must never become user
 *  controls, even when a provider lists them in `supported_parameters`. */
export const HARNESS_OWNED_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'response_format',
  'tools',
  'tool_choice',
  'structured_outputs',
  'include_reasoning',
  'reasoning',
  'reasoning_effort',
  'stop',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'parallel_tool_calls',
  'web_search_options',
  'prediction',
]);

type Spec = Omit<ModelParameterDef, 'default' | 'defaultSource'> & {
  documentedDefault?: number | string;
};

export const MODEL_PARAMETER_SPECS: Record<ModelParameterKey, Spec> = {
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    kind: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    documentedDefault: 1,
    description: 'How random the output is; lower is more deterministic.',
  },
  top_p: {
    key: 'top_p',
    label: 'Top P',
    kind: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    documentedDefault: 1,
    description:
      'Nucleus sampling: only the most likely tokens whose mass sums to this value are considered.',
  },
  top_k: {
    key: 'top_k',
    label: 'Top K',
    kind: 'integer',
    min: 0,
    step: 1,
    documentedDefault: 0,
    description: 'Sample from at most this many tokens; 0 disables the limit.',
  },
  min_p: {
    key: 'min_p',
    label: 'Min P',
    kind: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    documentedDefault: 0,
    description: 'Cut off tokens below this fraction of the most likely token.',
  },
  top_a: {
    key: 'top_a',
    label: 'Top A',
    kind: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    documentedDefault: 0,
    description: 'Keep only tokens with sufficient probability; 0 disables the limit.',
  },
  frequency_penalty: {
    key: 'frequency_penalty',
    label: 'Frequency penalty',
    kind: 'float',
    min: -2,
    max: 2,
    step: 0.01,
    documentedDefault: 0,
    description: 'Penalizes tokens in proportion to how often they already appeared.',
  },
  presence_penalty: {
    key: 'presence_penalty',
    label: 'Presence penalty',
    kind: 'float',
    min: -2,
    max: 2,
    step: 0.01,
    documentedDefault: 0,
    description: 'Penalizes tokens that appeared at all, steering toward new topics.',
  },
  repetition_penalty: {
    key: 'repetition_penalty',
    label: 'Repetition penalty',
    kind: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    documentedDefault: 1,
    description: 'Scales down repeated tokens; 1 means no penalty.',
  },
  seed: {
    key: 'seed',
    label: 'Seed',
    kind: 'integer',
    step: 1,
    description: 'Fixes sampling to a deterministic seed for repeatable output.',
  },
  max_tokens: {
    key: 'max_tokens',
    label: 'Max output tokens',
    kind: 'integer',
    min: 1,
    step: 1,
    description: 'Upper bound on tokens the model may generate in the reply.',
  },
  verbosity: {
    key: 'verbosity',
    label: 'Verbosity',
    kind: 'enum',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
    documentedDefault: 'medium',
    description:
      'How long and detailed replies are. Separate from reasoning effort, which controls how much the model thinks before answering.',
  },
};

/** Order the settings panel lists parameters in. */
const PARAMETER_ORDER: readonly ModelParameterKey[] = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'max_tokens',
  'seed',
  'verbosity',
];

/** Provider spellings that map onto a known parameter key. */
const PARAMETER_ALIASES: Record<string, ModelParameterKey> = {
  max_completion_tokens: 'max_tokens',
};

function providerDefaultInRange(spec: Spec, value: unknown): number | string | undefined {
  if (spec.kind === 'enum') {
    return typeof value === 'string' && spec.options?.includes(value) ? value : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (spec.kind === 'integer' && !Number.isInteger(value)) return undefined;
  if (spec.min !== undefined && value < spec.min) return undefined;
  if (spec.max !== undefined && value > spec.max) return undefined;
  return value;
}

/** Build the ordered list of user-tunable parameters for a model from the
 *  provider's `supported_parameters` plus its reported defaults.
 *  `max_tokens` is included only when `maxOutputTokens > 0` so the control can
 *  be capped at the model's real output limit. Harness-owned and unknown keys
 *  are ignored. */
export function buildModelParameters(
  supported: readonly string[],
  defaults?: Record<string, unknown> | null,
  maxOutputTokens?: number,
): ModelParameterDef[] {
  const keys = new Set<ModelParameterKey>();
  for (const raw of supported ?? []) {
    if (typeof raw !== 'string') continue;
    if (HARNESS_OWNED_PARAMETER_KEYS.has(raw)) continue;
    const key = (MODEL_PARAMETER_SPECS as Record<string, Spec | undefined>)[raw]
      ? (raw as ModelParameterKey)
      : PARAMETER_ALIASES[raw];
    if (key) keys.add(key);
  }
  const defs: ModelParameterDef[] = [];
  for (const key of PARAMETER_ORDER) {
    if (!keys.has(key)) continue;
    const spec = MODEL_PARAMETER_SPECS[key];
    const def: ModelParameterDef = {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      ...(spec.min !== undefined && { min: spec.min }),
      ...(spec.max !== undefined && { max: spec.max }),
      ...(spec.step !== undefined && { step: spec.step }),
      ...(spec.options && { options: spec.options }),
      description: spec.description,
    };
    if (key === 'max_tokens') {
      if (!maxOutputTokens || maxOutputTokens <= 0) continue;
      def.max = maxOutputTokens;
    }
    const reported = defaults
      ? providerDefaultInRange(
          spec,
          defaults[key] ?? (key === 'max_tokens' ? defaults['max_completion_tokens'] : undefined),
        )
      : undefined;
    if (reported !== undefined) {
      def.default = reported;
      def.defaultSource = 'provider';
    } else if (spec.documentedDefault !== undefined) {
      def.default = spec.documentedDefault;
      def.defaultSource = 'documented';
    }
    defs.push(def);
  }
  return defs;
}

/** Keep only values the model's parameter list actually declares. Numbers are
 *  finite and clamped into range, integers rounded, enums restricted to their
 *  options; anything else is dropped. Never throws. */
export function sanitizeModelParameterValues(
  defs: readonly ModelParameterDef[] | undefined,
  values: unknown,
): ModelParameterValues {
  const out: ModelParameterValues = {};
  if (!defs || !values || typeof values !== 'object' || Array.isArray(values)) return out;
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    const def = byKey.get(key as ModelParameterKey);
    if (!def) continue;
    if (def.kind === 'enum') {
      if (typeof value === 'string' && def.options?.includes(value)) {
        out[def.key] = value;
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    let v = value;
    if (def.min !== undefined && v < def.min) v = def.min;
    if (def.max !== undefined && v > def.max) v = def.max;
    if (def.kind === 'integer') v = Math.round(v);
    out[def.key] = v;
  }
  return out;
}
