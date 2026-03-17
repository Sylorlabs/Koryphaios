// Core Providers Configuration
// Focused on top 10 verified, well-maintained AI providers
// Plus dynamic OpenAI-compatible presets

import type { ProviderName } from "@koryphaios/shared";
import { DYNAMIC_PROVIDER_PRESETS, type ProviderPreset } from "./dynamic";

/**
 * Core providers are the recommended, battle-tested providers.
 * These are actively maintained and have the best reliability.
 */
export const CORE_PROVIDERS: ProviderName[] = [
  "anthropic",    // Claude 3.x/4.x series - best coding performance
  "openai",       // GPT-4, GPT-4o - industry standard
  "google",       // Gemini 1.5/2.x - strong context window
  "xai",          // Grok - competitive pricing
  "groq",         // Fast inference for open models
  "openrouter",   // Universal router - access to many models
  "copilot",      // GitHub Copilot Chat - subscription-based
  "deepseek",     // Strong open-weight models
  "ollama",       // Local models - no API key needed
  "azure",        // Enterprise OpenAI
];

/**
 * Extended providers are available but not shown by default.
 * Users can enable these in advanced settings.
 */
export const EXTENDED_PROVIDERS: ProviderName[] = [
  "bedrock",      // AWS - requires AWS setup
  "vertexai",     // Google Cloud - requires GCP setup
  "mistral",      // European provider
  "togetherai",   // Open model hosting
  "fireworks",    // Fast inference
];

/**
 * Check if a provider is a core provider
 */
export function isCoreProvider(provider: string): provider is ProviderName {
  return CORE_PROVIDERS.includes(provider as ProviderName);
}

/**
 * Check if a provider is available (core or extended)
 */
export function isAvailableProvider(provider: string): provider is ProviderName {
  return isCoreProvider(provider) || EXTENDED_PROVIDERS.includes(provider as ProviderName);
}

/**
 * Get recommended provider order for UI
 * Most reliable/popular providers first
 */
export function getRecommendedProviderOrder(): ProviderName[] {
  return [...CORE_PROVIDERS];
}

/**
 * Get provider tier - used for UI labeling
 */
export function getProviderTier(provider: ProviderName): "core" | "extended" | "experimental" {
  if (CORE_PROVIDERS.includes(provider)) return "core";
  if (EXTENDED_PROVIDERS.includes(provider)) return "extended";
  return "experimental";
}

/**
 * Environment variable mappings for core providers only
 */
export const CORE_PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  copilot: [], // Auth-only via GitHub
  deepseek: ["DEEPSEEK_API_KEY"],
  ollama: [], // Local - no key needed
  azure: ["AZURE_OPENAI_API_KEY"],
};

/**
 * Default base URLs for core providers
 */
export const CORE_PROVIDER_BASE_URLS: Partial<Record<ProviderName, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434",
  deepseek: "https://api.deepseek.com",
};

/**
 * Provider descriptions for UI
 */
export const CORE_PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: "Claude 3.5/4 Sonnet & Opus - Excellent for coding tasks",
  openai: "GPT-4, GPT-4o, o1 - Industry standard models",
  google: "Gemini 1.5 Pro/Flash - 2M token context window",
  xai: "Grok - Competitive pricing, fast responses",
  groq: "Lightning-fast inference for Llama, Mixtral, and more",
  openrouter: "Access 100+ models with one API key",
  copilot: "GitHub Copilot - Use your existing subscription",
  deepseek: "DeepSeek Coder & Chat - Strong open models",
  ollama: "Run models locally - Llama, Mistral, Phi, etc.",
  azure: "Enterprise OpenAI via Microsoft Azure",
};

// ─── Dynamic Provider Presets ───────────────────────────────────────────────

/**
 * Get all available dynamic provider presets
 * These are OpenAI-compatible providers that can be added dynamically
 */
export function getDynamicProviderPresets(): ProviderPreset[] {
  return Object.values(DYNAMIC_PROVIDER_PRESETS).filter(p => p.name !== "custom");
}

/**
 * Get dynamic provider preset by name
 */
export function getDynamicPreset(name: string): ProviderPreset | undefined {
  return DYNAMIC_PROVIDER_PRESETS[name];
}

/**
 * Check if a provider name is a dynamic preset
 */
export function isDynamicPreset(name: string): boolean {
  return name in DYNAMIC_PROVIDER_PRESETS && name !== "custom";
}

/**
 * Get all provider names including dynamic presets
 */
export function getAllProviderOptions(): string[] {
  return [
    ...CORE_PROVIDERS,
    ...EXTENDED_PROVIDERS,
    ...getDynamicProviderPresets().map(p => p.name),
  ];
}

/**
 * Get total provider count (for marketing - be honest!)
 * - 10 core providers
 * - 5 extended providers  
 * - 10+ dynamic presets
 * - Unlimited custom providers
 */
export function getProviderStats(): {
  core: number;
  extended: number;
  dynamicPresets: number;
  totalPresets: number;
  supportsUnlimited: boolean;
} {
  const dynamicPresets = getDynamicProviderPresets().length;
  return {
    core: CORE_PROVIDERS.length,
    extended: EXTENDED_PROVIDERS.length,
    dynamicPresets,
    totalPresets: CORE_PROVIDERS.length + EXTENDED_PROVIDERS.length + dynamicPresets,
    supportsUnlimited: true,
  };
}
