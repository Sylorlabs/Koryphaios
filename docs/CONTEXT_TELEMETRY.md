# Context Telemetry Reliability Rules

This app now treats context usage as **reliable only when both of these are true**:

1. The active agent reports real token usage from provider `usage_update` events.
2. The model context window is trusted for that provider/model pair.

If either is missing, the session context bar is hidden.

## How Updates Work

- Providers emit streaming events (`usage_update`) with token counters.
- Manager converts those into WebSocket `stream.usage` events and sends:
  - `tokensIn`, `tokensOut`, `tokensUsed`
  - `usageKnown` (provider actually reported counters)
  - `contextWindow` (if trusted)
  - `contextKnown`
- Frontend shows the context bar only when `contextUsage.isReliable === true`.

## Reliability Policy

Context metadata is treated as trusted only for providers with first-party model context docs
validated on February 16, 2026:

- OpenAI: https://platform.openai.com/docs/models
- Anthropic: https://docs.anthropic.com/en/docs/about-claude/models/all-models
- Google Gemini: https://ai.google.dev/gemini-api/docs/models
- Groq: https://console.groq.com/docs/models
- xAI: https://docs.x.ai/docs/models

Unknown/generic models and unverified providers are marked `contextKnown = false`,
so context UI is suppressed instead of showing potentially wrong numbers.
