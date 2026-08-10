# ADR-007: Env-based KMS provider selection

## Status

Superseded by the fail-closed KMS factory and `docs/configuration.md`

## Context

The prior `createKMSProviderFromEnv()` function always returned a `LocalKMSProvider`, regardless of environment. The comment said "In production, this could check for AWS, GCP, Azure, etc." — but it never did.

This meant:

- In production, encryption keys were stored in a local file (unencrypted at rest)
- The codebase had 7 KMS provider implementations (AWS, Azure, GCP, Vault, Cloudflare, Age, Local) but none were wired up
- Operators had no way to select a cloud KMS without modifying code

## Decision

The original decision proposed `KMS_PROVIDER` and a seven-provider table. That
contract was never a truthful description of the factory and is superseded.
The current contract is:

| `KORYPHAIOS_KMS_PROVIDER`           | Runtime state                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `local`                             | Operational with the local passphrase and binding restrictions               |
| `aws-kms`                           | Operational when region and key ID are configured                            |
| `vault`                             | Operational with a complete token, AppRole, or Kubernetes auth configuration |
| `gcp-kms`, `azure-kv`, `cloudflare` | Recognized but unavailable; selection throws                                 |
| Any other value                     | Invalid; selection throws                                                    |

This historical fallback is no longer permitted. The current factory uses
`KORYPHAIOS_KMS_PROVIDER`, implements `local`, `aws-kms`, and `vault`, and
throws when a selected provider is missing required configuration. Recognized
but unwired providers return an explicit unavailable error. Local KMS requires
a passphrase unless the user sets the documented insecure acknowledgement,
and it is refused on non-loopback bindings unless separately acknowledged.
Production encryption initialization failures abort startup.

## Consequences

- **Positive**: Operators can select a cloud KMS via env vars without code changes.
- **Positive**: Missing external configuration cannot silently redirect secrets to local key storage.
- **Positive**: Operational and recognized-but-unavailable providers are distinguished explicitly.
- **Negative**: Each provider's constructor expects different config shapes — the selection code has provider-specific env var mapping.
- **Negative**: GCP KMS, Azure Key Vault, and Cloudflare KMS remain unavailable until their factory mapping and live health checks are implemented.

## Alternatives considered

- **Hardcode a single cloud provider**: Too rigid for a product that may run on different clouds.
- **Config file instead of env vars**: Env vars are simpler for containerized deployments and match the existing `validateEnvironment()` pattern.
- **Auto-detect from cloud metadata**: Fragile and surprising. Explicit selection is clearer.
