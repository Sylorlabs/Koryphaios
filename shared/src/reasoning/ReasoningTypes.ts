// Reasoning Configuration Types
// Domain: Extended thinking and reasoning effort configuration for LLM providers

export type ReasoningLevel = string;

export interface ReasoningConfig {
  parameter: string;
  options: ReasoningOption[];
  defaultValue: string;
  supportsModelSpecific?: boolean;
}

export interface ReasoningOption {
  value: string;
  label: string;
  description: string;
}

export interface ReasoningRule {
  provider: string;
  modelPattern?: RegExp;
  config: ReasoningConfig | null;
}
