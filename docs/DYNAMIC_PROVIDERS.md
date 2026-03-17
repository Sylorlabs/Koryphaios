# Dynamic Providers & Reasoning Modes

**Date:** 2026-03-17  
**Status:** ✅ Core Implementation Complete

---

## Overview

Koryphaios supports **unlimited OpenAI-compatible providers** via the dynamic provider system, plus **custom reasoning/thinking modes** for compatible models.

### Provider Count

```
10 Core Providers      (Anthropic, OpenAI, Google, xAI, Groq, OpenRouter, Copilot, DeepSeek, Ollama, Azure)
5 Extended Providers   (Bedrock, VertexAI, Mistral, TogetherAI, Fireworks)
10 Dynamic Presets     (Fireworks, Together, Perplexity, DeepInfra, Cerebras, Mistral, AI21, Hyperbolic, Novita, SiliconFlow)
∞ Custom Providers     (Any OpenAI-compatible endpoint)
────────────────────────────────────────────────────────────────────────────────
25+ Curated Providers + Unlimited Custom Endpoints
```

---

## Dynamic Provider System

### Built-in Presets

| Preset | Description | Environment Variable |
|--------|-------------|---------------------|
| `fireworks` | Fireworks AI inference | `FIREWORKS_API_KEY` |
| `together` | Together AI | `TOGETHER_API_KEY` |
| `perplexity` | Perplexity API | `PERPLEXITY_API_KEY` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` |
| `mistral` | Mistral AI | `MISTRAL_API_KEY` |
| `ai21` | AI21 Labs | `AI21_API_KEY` |
| `hyperbolic` | Hyperbolic | `HYPERBOLIC_API_KEY` |
| `novita` | Novita AI | `NOVITA_API_KEY` |
| `siliconflow` | SiliconFlow | `SILICONFLOW_API_KEY` |

### Config-Based Usage

Add to `koryphaios.json`:

```json
{
  "dynamicProviders": [
    {
      "name": "fireworks",
      "preset": "fireworks",
      "apiKey": "fw_xxx"
    },
    {
      "name": "my-custom-llm",
      "preset": "custom",
      "displayName": "Corporate LLM",
      "baseUrl": "https://llm.internal.company.com/v1",
      "apiKey": "internal-key",
      "headers": {
        "X-Department": "engineering"
      }
    }
  ]
}
```

### Programmatic Usage

```typescript
import { createProviderFromPreset, createCustomProvider } from "./providers/dynamic";

// From preset with reasoning
const fireworks = createProviderFromPreset("fireworks", "fw_xxx", {
  reasoning: { mode: "high" }
});

// Custom provider
const custom = createCustomProvider(
  "my-llm",
  "https://api.example.com/v1",
  "key",
  { 
    displayName: "My LLM",
    reasoning: { mode: "medium" }
  }
);
```

---

## Reasoning Mode Configuration

### Supported Providers

| Provider | Models | Configuration |
|----------|--------|---------------|
| OpenAI | o1, o3-mini, o4-mini | `reasoning_effort`: `low`/`medium`/`high` |
| Anthropic | Claude 3.7+ | `thinking`: budget tokens |
| Google | Gemini 2.0 | Limited reasoning controls |

### Reasoning Modes

| Mode | Description | Cost Multiplier |
|------|-------------|-----------------|
| `disabled` | No reasoning - fastest, lowest cost | 1.0x |
| `minimal` | Minimal reasoning | 1.1x |
| `low` | Low effort, faster responses | 1.3x |
| `medium` | Balanced (default) | 1.6x |
| `high` | High effort, thorough reasoning | 2.2x |
| `max` | Maximum reasoning | 3.0x |

### Config Example with Reasoning

```json
{
  "dynamicProviders": [
    {
      "name": "fireworks",
      "preset": "fireworks",
      "apiKey": "fw_xxx",
      "reasoning": {
        "mode": "high",
        "includeThoughts": false
      },
      "modelReasoning": {
        "accounts/fireworks/models/llama-v3p1-405b-instruct": {
          "mode": "medium",
          "budgetTokens": 4096
        }
      }
    }
  ]
}
```

### Per-Model Override

```typescript
// Set provider-wide reasoning
provider.setReasoningConfig({ mode: "high" });

// Set per-model reasoning (takes precedence)
provider.setModelReasoningConfig("model-id", {
  mode: "max",
  budgetTokens: 8192
});
```

---

## Feature Parity

| Feature | Native | Dynamic | Notes |
|---------|--------|---------|-------|
| Cost Tracking | ✅ | ✅ | Via `createUsageInterceptingFetch()` |
| Circuit Breakers | ✅ | ✅ | Same registry logic |
| Model Discovery | ✅ | ✅ | Fetches from `/models` endpoint |
| Custom Headers | ✅ | ✅ | Configurable per provider |
| Auth (API Key) | ✅ | ✅ | Standard bearer token |
| Streaming | ✅ | ✅ | Full SSE support |
| Tool Calling | ✅ | ✅* | *If provider supports OpenAI functions |
| Reasoning | ✅ | ✅* | *If provider supports reasoning params |

---

## Remaining Work

### Backend API (~2 hours)
- [ ] REST endpoints for dynamic provider CRUD
- [ ] REST endpoints for reasoning config
- [ ] Config persistence API

### Frontend (~4 hours)
- [ ] "Add Provider" modal with preset grid
- [ ] Custom provider form
- [ ] Reasoning mode selector
- [ ] Per-model reasoning overrides UI

### Testing (~2 hours)
- [ ] Unit tests for DynamicOpenAIProvider
- [ ] Integration tests for reasoning

### Documentation (~1 hour)
- [ ] API documentation updates
- [ ] User guide

**Total remaining: ~11 hours for full feature completeness**

---

## Files

- `backend/src/providers/dynamic.ts` - Dynamic provider implementation
- `shared/src/providers/ReasoningConfig.ts` - Reasoning configuration types
- `backend/src/providers/core-providers.ts` - Provider preset helpers

---

