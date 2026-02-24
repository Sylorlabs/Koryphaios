# AI Providers Taxonomy (2026)
**Company-first, beginner-friendly guide to authentication patterns.**

---

## 1) What Beginners Use First

### OpenAI
- **OpenAI API** → **API key** via **Bearer auth**; env var: `OPENAI_API_KEY`
  - Endpoint: `https://api.openai.com/v1`
  - Used for: GPT-4, GPT-4o, o1
  - [OpenAI Developers](https://developers.openai.com/api/reference/overview/)

- **GitHub Copilot** → **GitHub account sign-in**; subscription-based or pay-per-use
  - IDE/editor plugin
  - [VS Code Setup](https://code.visualstudio.com/docs/copilot/setup)

### Anthropic
- **Claude API** → **API key** via **Bearer auth**; env var: `ANTHROPIC_API_KEY`
  - Endpoint: `https://api.anthropic.com`
  - Used for: Claude 3, Sonnet, Opus, Haiku
  - [Anthropic API](https://docs.anthropic.com/)

### Google
- **Gemini API** → **API key**; env var: `GOOGLE_API_KEY`
  - Endpoint: `https://generativelanguage.googleapis.com/v1beta/models`
  - Free tier available
  - [Google AI Studio](https://aistudio.google.com)

- **Vertex AI** → **Google Cloud service account** (IAM-based); not a simple API key
  - Requires GCP project + authentication via Application Default Credentials
  - [Google Cloud Docs](https://cloud.google.com/vertex-ai/docs)

- **Chrome Built-in AI** (Gemini Nano) → **No auth**; runs locally in browser
  - Available in Chrome 123+; uses origin trials
  - [Chrome for Developers](https://developer.chrome.com/docs/ai/built-in-apis)

### Mistral AI
- **Mistral API** → **API key**; env var: `MISTRAL_API_KEY`
  - Endpoint: `https://api.mistral.ai/v1`
  - OpenAI-compatible format
  - [Mistral Docs](https://docs.mistral.ai)

### Perplexity AI
- **Perplexity API** → **API key**; env var: `PERPLEXITY_API_KEY`
  - Endpoint: `https://api.perplexity.ai`
  - OpenAI-compatible
  - [Perplexity Docs](https://docs.perplexity.ai)

### Local Runtimes (No Auth)
- **Ollama** → runs locally on your machine; no API key needed
  - [Ollama](https://ollama.ai)

- **LM Studio** → local UI/runtime; no API key needed
  - [LM Studio](https://lmstudio.ai)

- **llama.cpp** → C++ library; no API key needed
  - [llama.cpp](https://github.com/ggerganov/llama.cpp)

---

## 2) Model Labs (Foundation Model Creators)

### xAI
- **Grok API** → **API key**-based; [verify in docs](https://docs.x.ai/)

### Alibaba Cloud
- **DashScope / Qwen** → **API key**; env var: `DASHSCOPE_API_KEY`
  - [Alibaba Cloud DashScope](https://dashscope.aliyuncs.com/)

### DeepSeek
- **DeepSeek API** → **API key**-based
  - [DeepSeek](https://www.deepseek.com/)

### Cohere
- **Cohere API** → **API key**; env var: `COHERE_API_KEY`
  - [Cohere Docs](https://docs.cohere.com/)

### Moonshot AI
- **Kimi API** → **API key**-based
  - [Moonshot Docs](https://platform.moonshot.cn/docs)

### MiniMax
- **MiniMax API** → **API key**-based
  - [MiniMax Docs](https://www.minimaxi.com/)

### StepFun
- **StepFun API** → OpenAI-compatible format
  - [StepFun Docs](https://www.stepfun.com/)

---

## 3) Hyperscalers & Enterprise Platforms

### Amazon Web Services
- **Amazon Bedrock** → **AWS IAM (SigV4 signed requests)**
  - Not a simple API key; requires AWS credentials
  - [AWS Bedrock Docs](https://docs.aws.amazon.com/bedrock/)

### Microsoft
- **Azure OpenAI Service** → **API key** (`api-key` header) OR **Microsoft Entra ID**
  - Endpoint format: `https://{resource}.openai.azure.com`
  - [Azure OpenAI Docs](https://learn.microsoft.com/en-us/azure/ai-services/openai/)

- **Azure AI Services** → varies by service; typically API key or Entra ID
  - [Azure AI Docs](https://learn.microsoft.com/en-us/azure/ai-services/)

### Google Cloud
- See **Vertex AI** (above under "What Beginners Use First")

### SAP
- **SAP AI Core** → **OAuth2 client-credentials** (client ID + secret + token URL)
  - [SAP AI SDK](https://sap.github.io/ai-sdk/)

---

## 4) Hosted Inference Platforms (Run Models for You)

### Groq
- **Groq OpenAI-compatible API** → **API key**; env var: `GROQ_API_KEY`
  - Base URL: `https://api.groq.com/openai/v1`
  - [GroqCloud Docs](https://console.groq.com/docs/overview)

### Together AI
- **Together AI API** → **API key**; env var: `TOGETHER_API_KEY`
  - OpenAI-compatible
  - [Together AI Docs](https://www.together.ai/docs)

### Baseten
- **Baseten API** → **API key**-based
  - [Baseten Docs](https://docs.baseten.co)

### FriendliAI
- **FriendliAI API** → **token/key**-based
  - [FriendliAI Docs](https://docs.friendli.ai)

### Replicate
- **Replicate API** → **API token**
  - [Replicate Docs](https://replicate.com/docs/api)

### Modal
- **Modal API** → **account + token**-based
  - [Modal Docs](https://modal.com/docs)

### Scaleway
- **Scaleway APIs** → **access key + secret key**; env vars: `SCW_ACCESS_KEY` / `SCW_SECRET_KEY`
  - [Scaleway Docs](https://www.scaleway.com/en/developers/)

### OVHcloud
- **OVHcloud APIs** → **application key + secret + consumer key**
  - [OVHcloud API Guide](https://help.ovhcloud.com/)

### STACKIT
- **STACKIT AI Model Serving** → OpenAI-compatible; **API key** auth
  - [STACKIT Docs](https://www.stackit.de/)

### Nebius
- **Nebius AI Studio** → **API key**; env var: `NEBIUS_API_KEY`
  - [Nebius Docs](https://docs.nebius.com)

---

## 5) Aggregators (One API/Key → Many Models)

### OpenRouter
- **Unified Model API** → **API key**; routes to 100+ models across labs
  - [OpenRouter Docs](https://openrouter.ai/docs)

### Poe
- **Poe API** → **API key**-based
  - [Poe Docs](https://developer.poe.com)

### 302.AI
- **Unified API** → **API key**-based
  - [302.AI](https://302.ai)

### Requesty
- **Unified API** → **API key**-based
  - [Requesty](https://requesty.io)

### Cortecs
- **Unified API Layer** → **API key**-based
  - [Cortecs Docs](https://docs.cortecs.ai)

### Venice AI
- **Venice API** → **API key**-based
  - [Venice Docs](https://docs.venice.ai)

---

## 6) Gateways & Observability (Proxy + Logging + Policy)

### Cloudflare
- **AI Gateway** → gateway sits in front of your provider; you manage upstream keys
  - [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)

### Vercel
- **AI Gateway** → gateway + optional federated auth patterns
  - [Vercel AI Docs](https://sdk.vercel.ai)

### Portkey
- **Gateway + Observability** → **API key**-based
  - [Portkey Docs](https://portkey.ai/docs)

### Helicone
- **Gateway + Monitoring** → **API key**-based
  - [Helicone Docs](https://docs.helicone.ai)

---

## 7) Embeddings & Retrieval (RAG Building Blocks)

### Voyage AI
- **Embeddings / Rerank API** → **API key**-based
  - [Voyage Docs](https://docs.voyageai.com)

### Mixedbread AI
- **Rerank / Embeddings** → **API key**-based
  - [Mixedbread Docs](https://www.mixedbread.ai/docs)

### Jina AI
- **Embeddings API** → **API key**-based
  - [Jina Docs](https://jina.ai/embeddings/)

### Mem0
- **Memory Layer** → varies (hosted vs self-hosted)
  - [Mem0 Docs](https://mem0.ai/docs)

### Letta
- **Agent Framework** → uses *other* provider keys, not its own
  - [Letta Docs](https://docs.letta.ai)

---

## 8) Voice & Audio APIs (Specialized Modalities)

### ElevenLabs
- **Text-to-Speech API** → **API key** (header-based)
  - [ElevenLabs Docs](https://elevenlabs.io/docs)

### Deepgram
- **Speech-to-Text API** → **API key**-based
  - [Deepgram Docs](https://developers.deepgram.com)

### AssemblyAI
- **Speech-to-Text API** → **API key** (`Authorization` header)
  - [AssemblyAI Docs](https://www.assemblyai.com/docs)

### Gladia
- **Speech-to-Text API** → **API key** (`x-gladia-key` header)
  - [Gladia Docs](https://docs.gladia.io)

### LMNT
- **Audio Synthesis API** → **API key**; env var: `LMNT_API_KEY`
  - [LMNT Docs](https://docs.lmnt.com)

### Prodia
- **Image/Inference API** → **API key** (`Authorization: Bearer …`)
  - Base URL: `https://inference.prodia.com`
  - [Prodia Docs](https://docs.prodia.com)

---

## Quick Auth Cheatsheet

| Auth Pattern | Examples | Setup |
|---|---|---|
| **API Key (Bearer)** | OpenAI, Anthropic, Google, Mistral | `export API_KEY=sk-...` → `Authorization: Bearer $API_KEY` |
| **API Key (Header)** | ElevenLabs, Deepgram | `export API_KEY=...` → `X-API-Key: $API_KEY` |
| **AWS IAM (SigV4)** | Amazon Bedrock | Use AWS SDK; signs requests automatically |
| **OAuth2 Client Creds** | SAP AI Core | Exchange client ID + secret for token |
| **GitHub Token** | GitHub Models, Copilot | Use GitHub PAT as Bearer token |
| **No Auth** | Ollama, LM Studio, llama.cpp | Runs locally; no credentials needed |

---

## For Koryphaios Integration

When adding providers to Koryphaios:

1. **Determine auth type** from cheatsheet above
2. **Store credentials securely** (environment variables, secrets manager)
3. **Test endpoint reachability** before enabling in UI
4. **Document fallback behavior** if API is down
5. **Set rate limits** to avoid quota exhaustion

For **dev/testing**: Use free tiers or local runtimes (Ollama, llama.cpp).

---

*Last updated: 2026-02-17. For latest docs, check each provider's official documentation.*
