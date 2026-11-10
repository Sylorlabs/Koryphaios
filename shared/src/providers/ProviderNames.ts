// Provider Names - Central registry of all supported LLM providers
// Domain: Provider identification and enumeration

export const ProviderName = {
  // Frontier (Major providers with full implementations)
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  Google: 'google',
  AIStudio: 'aistudio',
  XAI: 'xai',

  // Aggregators (OpenAI-compatible APIs with implementations)
  OpenRouter: 'openrouter',
  AgentRouter: 'agentrouter',
  UnoRouter: 'unorouter',
  TokenRouter: 'tokenrouter',
  ExperientialLabs: 'experientiallabs',
  TokenHarbor: 'tokenharbor',
  Logfare: 'logfare',
  APInex: 'apinex',
  Gwarden: 'gwarden',
  VyceAI: 'vyceai',
  Respan: 'respan',
  Groq: 'groq',
  DigitalOcean: 'digitalocean',
  CommandCode: 'commandcode',
  Notion: 'notion',

  // Hosted API-key providers
  Beam: 'beam',
  Cline: 'cline',

  // Auth-only providers (OAuth/CLI based)
  Claude: 'claude',
  Antigravity: 'antigravity',
  Copilot: 'copilot',
  Codex: 'codex',
  CodexAuth: 'codex-auth',
  Cursor: 'cursor',
  Devin: 'devin',
  Freebuff: 'freebuff',
  Omnirush: 'omnirush',
  OpenCodeCli: 'opencode',
  Codebuff: 'codebuff',
  Grok: 'grok',
  CodeBuddy: 'codebuddy',
  Hoplite: 'hoplite',
  KiloCode: 'kilocode',
  // WorkBuddy AI desktop app host runtime (distinct from the `codebuddy`
  // standalone CLI and the `workbuddy` cloud API).
  WorkBuddyDesktop: 'workbuddy-desktop',

  // Curated coding models
  OpenCodeZen: 'opencodezen',
  OpenCodeGo: 'opencodego',

  // Enterprise (with implementations)
  Azure: 'azure',
  Bedrock: 'bedrock',
  VertexAI: 'vertexai',

  // Local/Custom endpoints (OpenAI-compatible)
  Local: 'local',
  Ollama: 'ollama',

  // OpenCode parity and additional providers
  '302AI': '302ai',
  AzureCognitive: 'azurecognitive',
  Baseten: 'baseten',
  Cerebras: 'cerebras',
  Cloudflare: 'cloudflare',
  Cortecs: 'cortecs',
  DeepSeek: 'deepseek',
  DeepInfra: 'deepinfra',
  Fireworks: 'fireworks',
  GitLab: 'gitlab',
  HuggingFace: 'huggingface',
  Helicone: 'helicone',
  LlamaCpp: 'llamacpp',
  IoNet: 'ionet',
  LMStudio: 'lmstudio',
  Mistral: 'mistral',
  KimiCode: 'kimicode',
  Moonshot: 'moonshot',
  MiniMax: 'minimax',
  Nebius: 'nebius',
  OllamaCloud: 'ollamacloud',
  SAPAI: 'sapai',
  Stackit: 'stackit',
  OVHcloud: 'ovhcloud',
  Scaleway: 'scaleway',
  TogetherAI: 'togetherai',
  Venice: 'venice',
  Vercel: 'vercel',
  ZAI: 'zai',
  ZenMux: 'zenmux',
  Poe: 'poe',
  WorkBuddy: 'workbuddy',
} as const;

export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName] | string;

// Helper to validate provider names
export function isValidProvider(name: string): boolean {
  return (Object.values(ProviderName) as readonly string[]).includes(name);
}

// Get all provider names as array
export function getAllProviderNames(): string[] {
  return Object.values(ProviderName);
}
