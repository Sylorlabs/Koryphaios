// Extended OpenAI SDK parameter types for Koryphaios provider-specific options.
//
// The OpenAI SDK's ChatCompletionCreateParamsStreaming doesn't include
// provider-specific fields like `service_tier`, `thinking`, `reasoning_effort`,
// `enable_thinking`, or `chat_template_kwargs` — these are added by individual
// providers (DeepSeek, GLM, Together, etc.) on top of the OpenAI-compatible API.
//
// The prior code used `(params as any).field = value` at every call site,
// bypassing type checking entirely. This module provides a typed extension so
// the casts are typed and centralized, not scattered `as any` escapes.

import type OpenAI from 'openai';

// Provider-specific fields that extend the OpenAI chat completion params.
// We use `Omit` to remove the SDK's narrower versions of fields we override
// (e.g. the SDK's `service_tier` doesn't include 'priority', and its
// `reasoning_effort` doesn't include 'max' or 'minimal').
export interface KoryOpenAIExtensions {
  // OpenAI API Priority tier (not Codex Fast mode — that's a ChatGPT credit feature).
  // Extended beyond the SDK's 'auto' | 'default' | 'flex' to include 'priority'.
  service_tier?: 'auto' | 'default' | 'flex' | 'priority';

  // Reasoning effort for models that support it (OpenAI o-series, DeepSeek, etc.).
  // Extended beyond the SDK's 'low' | 'medium' | 'high' to include 'minimal' and 'max'.
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';

  // DeepSeek / GLM / Kimi thinking toggle.
  thinking?: {
    type: 'enabled' | 'disabled';
  };

  // Together/Qwen thinking toggle.
  enable_thinking?: boolean;

  // Together/Qwen chat template kwargs for thinking.
  chat_template_kwargs?: {
    enable_thinking?: boolean;
  };
}

// The combined type for all Koryphaios OpenAI-compatible provider calls.
// We Omit the SDK's narrower versions of overridden fields before intersecting
// so our wider types take effect. At the `create()` call site, we cast back to
// the SDK's type — the extra fields are ignored by the SDK and the widened
// enum values are valid on the wire.
export type KoryOpenAIParams = Omit<
  OpenAI.ChatCompletionCreateParamsStreaming,
  'service_tier' | 'reasoning_effort'
> & KoryOpenAIExtensions;

// Reasoning effort values that Koryphaios supports (mapped to provider-specific
// values at the call site).
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
