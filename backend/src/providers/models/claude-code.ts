import type { ModelDef } from '@koryphaios/shared';

// Claude Code subscription models — served through the official `claude` CLI harness
// (Pro/Max OAuth subscription), NEVER via direct Anthropic API calls. The `apiModelId`
// is the alias passed to `claude --model <alias>`. Costs are 0 because the subscription
// is flat-rate; quota is tracked as rate-limit windows, not per-token spend.
//
// Names include the real version resolved by the alias (e.g. "Claude Opus 4.8") so the
// UI shows the actual model, not just a family name. The ClaudeCodeProvider refreshes
// these in the background via lightweight alias probes and updates names dynamically.
//
// IDs are deliberately distinct from the API-key `anthropic` catalog so that selecting
// one routes to the ClaudeCodeProvider (CLI harness) instead of the AnthropicProvider.
export const ClaudeCodeModels: ModelDef[] = [
  {
    id: 'claude-code-fable',
    name: 'Claude Fable 5',
    provider: 'claude',
    apiModelId: 'fable',
    realModelId: 'claude-fable-5',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    // Fallback until the live catalog probe lands (capabilitiesToLevels over
    // the CLI binary's embedded model catalog is the runtime source of truth).
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'claude-code-opus',
    name: 'Claude Opus 4.8',
    provider: 'claude',
    apiModelId: 'opus',
    realModelId: 'claude-opus-4-8',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    // Fallback until the live catalog probe lands (capabilitiesToLevels over
    // the CLI binary's embedded model catalog is the runtime source of truth).
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'claude-code-sonnet',
    name: 'Claude Sonnet 5',
    provider: 'claude',
    apiModelId: 'sonnet',
    realModelId: 'claude-sonnet-5',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    // Fallback until the live catalog probe lands (capabilitiesToLevels over
    // the CLI binary's embedded model catalog is the runtime source of truth).
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'claude-code-haiku',
    name: 'Claude Haiku 4.5',
    provider: 'claude',
    apiModelId: 'haiku',
    realModelId: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    // Haiku 4.5 supports extended thinking (verified: the CLI streams
    // thinking_delta events for it, with and without --effort).
    canReason: true,
    // Haiku 4.5 thinks but exposes NO effort control in the CLI's own catalog
    // (no 'effort' capability) — empty array means "no picker", verified.
    reasoningLevels: [],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'fast',
  },
];
