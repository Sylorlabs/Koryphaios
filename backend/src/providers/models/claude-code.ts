import type { ModelDef } from '@koryphaios/shared';

// Claude Code subscription models — served through the official `claude` CLI harness
// (Pro/Max OAuth subscription), NEVER via direct Anthropic API calls. The `apiModelId`
// is the alias passed to `claude --model <alias>`. Costs are 0 because the subscription
// is flat-rate; quota is tracked as rate-limit windows, not per-token spend.
//
// IDs are deliberately distinct from the API-key `anthropic` catalog so that selecting
// one routes to the ClaudeCodeProvider (CLI harness) instead of the AnthropicProvider.
export const ClaudeCodeModels: ModelDef[] = [
  {
    id: 'claude-code-opus',
    name: 'Claude Opus (Claude Code)',
    provider: 'claude',
    apiModelId: 'opus',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    // Fallback levels (the live set is pulled from the CLI at runtime; opus is xhigh-capable).
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'claude-code-sonnet',
    name: 'Claude Sonnet (Claude Code)',
    provider: 'claude',
    apiModelId: 'sonnet',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    // Fallback levels — Sonnet is NOT xhigh-capable (no 'xhigh'); live set pulled at runtime.
    reasoningLevels: ['low', 'medium', 'high', 'max'],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'flagship',
  },
  {
    id: 'claude-code-haiku',
    name: 'Claude Haiku (Claude Code)',
    provider: 'claude',
    apiModelId: 'haiku',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    // Haiku via Claude Code has no user-selectable effort level.
    reasoningLevels: [],
    supportsAttachments: true,
    supportsStreaming: true,
    tier: 'fast',
  },
];
