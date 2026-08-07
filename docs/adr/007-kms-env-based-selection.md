# ADR-007: Env-based KMS provider selection

## Status

Accepted

## Context

The prior `createKMSProviderFromEnv()` function always returned a `LocalKMSProvider`, regardless of environment. The comment said "In production, this could check for AWS, GCP, Azure, etc." — but it never did.

This meant:
- In production, encryption keys were stored in a local file (unencrypted at rest)
- The codebase had 7 KMS provider implementations (AWS, Azure, GCP, Vault, Cloudflare, Age, Local) but none were wired up
- Operators had no way to select a cloud KMS without modifying code

## Decision

Implement env-based selection via `KMS_PROVIDER` environment variable:

| Value | Required env vars | Provider |
|-------|-------------------|----------|
| `local` (default) | none | `LocalKMSProvider` |
| `aws` | `AWS_REGION` or `AWS_DEFAULT_REGION` | `AWSKMSProvider` |
| `azure` | `AZURE_KEY_VAULT_URL` | `AzureKMSProvider` |
| `gcp` | `GCP_KMS_KEY_RING` | `GCPKMSProvider` |
| `vault` | `VAULT_ADDR` | `VaultKMSProvider` |
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID` | `CloudflareKMSProvider` |
| `age` | `AGE_RECIPIENT` | `AgeKMSProvider` |

If the selected provider's required env vars are missing, the function falls back to `LocalKMSProvider` with a warning. In production, the warning is elevated to `fatal` to encourage proper configuration.

## Consequences

- **Positive**: Operators can select a cloud KMS via env vars without code changes.
- **Positive**: Missing configuration degrades gracefully to local KMS with a visible warning.
- **Positive**: All 7 provider implementations are now reachable.
- **Negative**: Each provider's constructor expects different config shapes — the selection code has provider-specific env var mapping.
- **Negative**: No health check before returning the provider — a misconfigured provider will fail on first use, not at startup.

## Alternatives considered

- **Hardcode a single cloud provider**: Too rigid for a product that may run on different clouds.
- **Config file instead of env vars**: Env vars are simpler for containerized deployments and match the existing `validateEnvironment()` pattern.
- **Auto-detect from cloud metadata**: Fragile and surprising. Explicit selection is clearer.
