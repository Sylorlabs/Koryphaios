# Provider integrity rules

Koryphaios must fail closed when a credential belongs to a different provider than the selected integration.

Examples:

- OpenCode Zen + OpenRouter key → reject before model discovery.
- OpenRouter + OpenAI key → reject before catalog loading.

Credential format compatibility is not provider compatibility.

A provider may only load models after:

1. Credential ownership matches the selected provider.
2. The provider catalog endpoint is verified.
3. Returned model IDs belong to the provider route being displayed.

Fallback catalogs from unrelated providers are prohibited.
