# Koryphaios configuration

Koryphaios is configured through a combination of environment variables, a
user-owned `koryphaios.json` file, and code-level defaults. This doc explains
which keys are user-owned vs. code-defaulted, so you know what survives a
reinstall and what doesn't.

## Configuration sources (precedence highest first)

1. **Process environment** — set by the launcher (Tauri shell, systemd,
   `launch-desktop.ts`). Always wins.
2. **`~/.config/koryphaios/secrets.env`** — user-owned secrets, outside the
   repo tree. Loaded by `backend/src/runtime/env.ts`. This is where
   `JWT_SECRET`, `SESSION_TOKEN_SECRET`, `RELAY_HOST_SECRET`, and
   `KORYPHAIOS_KMS_PASSPHRASE` belong. See `docs/secrets-rotation.md`.
3. **`<repo>/.env`** — repo-local dev overrides. Provider API keys for
   local dev, `RELAY_URL`, non-secret overrides. **Should not hold
   production secrets.**
4. **`koryphaios.json`** (in the data dir) — agent settings, permissions,
   tool policies. User-owned; survives reinstalls. See below.
5. **Code defaults** (`backend/src/agent-settings.ts:
DEFAULT_AGENT_SETTINGS`) — the fallback when `koryphaios.json` doesn't
   set a key. Only affects fresh installs or keys the user never set.

## Provider credentials and verification

Direct API keys and bearer tokens entered in Settings are removed from
`koryphaios.json` and stored in `<data-dir>/.koryphaios/credentials.json` with
owner-only (`0600`) permissions. This store is plaintext, not an operating-system
keychain. Disconnecting a provider deletes its direct-store entry even if the
settings file or provider entry is already missing; an unreadable store produces
an explicit error instead of reporting a successful disconnect.

A provider is `verified` only when its protocol-specific check returns the
expected authenticated metadata. Model-catalog checks require valid JSON and at
least one provider-shaped model entry; HTML, malformed JSON, arbitrary objects,
and empty lists do not verify a provider. Azure API keys use the `api-key` header,
while Microsoft Entra tokens use `Authorization: Bearer`; configure only one.
AWS Bedrock `ListFoundationModels` proves regional catalog access only, so it is
reported as `detected`/`catalog` until an actual inference request proves
`InvokeModel` permission and model entitlement.

## `koryphaios.json` — user-owned vs. code-defaulted

`koryphaios.json` is the source of truth for agent behavior. It's
gitignored because it holds user preferences and (potentially) secrets.
The merge logic in `loadAgentSettings` is:

```ts
{ ...DEFAULT_AGENT_SETTINGS, ...userSettings }
```

This means:

- **Keys you explicitly set** in `koryphaios.json` always win. Changing a
  code default does not override your choice.
- **Keys you never set** fall back to the code default. When we ship a
  safer default (e.g. `autoRunTools: false`), only fresh installs and
  users who never touched that key get the new default.

### Notable keys

| Key                    | Default (fresh install) | Your config keeps your value?    |
| ---------------------- | ----------------------- | -------------------------------- |
| `permissionMode`       | `'guarded'`             | Yes — your `'yolo'` stays        |
| `autoRunTools`         | `false` (was `true`)    | Yes — your explicit `true` stays |
| `bashCommandAllowlist` | `[]`                    | Yes                              |
| `bashCommandBlocklist` | `[]`                    | Yes                              |
| `pathConfinement`      | workspace root          | Yes                              |

If you want to reset to the new defaults, delete the key from your
`koryphaios.json` and restart. The merge will pick up the code default.

## Environment variables

### Secrets (load from `~/.config/koryphaios/secrets.env`)

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `JWT_SECRET`                | JWT signing for user auth tokens               |
| `SESSION_TOKEN_SECRET`      | HMAC signing for session tokens                |
| `RELAY_HOST_SECRET`         | Host authentication on the collaboration relay |
| `KORYPHAIOS_KMS_PASSPHRASE` | Passphrase for the local KMS master key        |

### Server

| Variable                     | Purpose                                                    | Default               |
| ---------------------------- | ---------------------------------------------------------- | --------------------- |
| `KORYPHAIOS_HOST`            | Bind address                                               | `127.0.0.1`           |
| `KORYPHAIOS_PORT`            | Bind port                                                  | `3001`                |
| `KORYPHAIOS_TRUSTED_PROXIES` | CIDR list of trusted reverse proxies (for X-Forwarded-For) | (empty — XFF ignored) |
| `KORYPHAIOS_OS_SANDBOX`      | Enable OS-level command sandbox (`1`/`0`)                  | `0` (opt-in)          |

### KMS provider

| Variable                              | Purpose                                                 | Default           |
| ------------------------------------- | ------------------------------------------------------- | ----------------- |
| `KORYPHAIOS_KMS_PROVIDER`             | Operational KMS backend: `local`, `aws-kms`, or `vault` | `local`           |
| `KORYPHAIOS_ALLOW_LOCAL_KMS`          | Allow local KMS on non-loopback hosts (`1`)             | (unset — refused) |
| `KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS` | Allow local KMS without a passphrase (`1`)              | (unset — refused) |

#### AWS KMS

| Variable                               | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `KORYPHAIOS_KMS_AWS_REGION`            | AWS region (required)                              |
| `KORYPHAIOS_KMS_AWS_KEY_ID`            | KMS key ID (required)                              |
| `KORYPHAIOS_KMS_AWS_ACCESS_KEY_ID`     | AWS access key (optional — uses IAM role if unset) |
| `KORYPHAIOS_KMS_AWS_SECRET_ACCESS_KEY` | AWS secret key (optional)                          |
| `KORYPHAIOS_KMS_AWS_SESSION_TOKEN`     | AWS session token (optional — for STS credentials) |
| `KORYPHAIOS_KMS_AWS_ENDPOINT`          | Custom endpoint (optional — for LocalStack etc.)   |

#### HashiCorp Vault

| Variable                           | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `KORYPHAIOS_KMS_VAULT_ADDRESS`     | Vault server address (required)                          |
| `KORYPHAIOS_KMS_VAULT_KEY_NAME`    | Transit key name (required)                              |
| `KORYPHAIOS_KMS_VAULT_AUTH_METHOD` | `token`, `approle`, or `kubernetes` (default: `token`)   |
| `KORYPHAIOS_KMS_VAULT_TOKEN`       | Vault token (for `token` auth)                           |
| `KORYPHAIOS_KMS_VAULT_ROLE_ID`     | AppRole role ID (for `approle` auth)                     |
| `KORYPHAIOS_KMS_VAULT_SECRET_ID`   | AppRole secret ID (for `approle` auth)                   |
| `KORYPHAIOS_KMS_VAULT_K8S_ROLE`    | Kubernetes auth role (for `kubernetes` auth)             |
| `KORYPHAIOS_KMS_VAULT_K8S_JWT`     | Kubernetes service account JWT (for `kubernetes` auth)   |
| `KORYPHAIOS_KMS_VAULT_NAMESPACE`   | Vault namespace (optional — for Vault Enterprise)        |
| `KORYPHAIOS_KMS_VAULT_MOUNT_PATH`  | Auth mount path (optional — defaults to the method name) |
| `KORYPHAIOS_KMS_VAULT_CA_CERT`     | CA cert path for TLS (optional)                          |

`gcp-kms`, `azure-kv`, and `cloudflare` are recognized compatibility names,
but their environment mapping is not implemented in the factory. Selecting
one fails startup encryption with an actionable unavailable error; it never
falls back to local key storage. In production, any local-KMS initialization
failure aborts backend startup. In development, the backend may start without
envelope encryption, but encrypted credential writes and legacy credential
migration remain disabled rather than being stored with a development key.

## OS sandbox

The OS sandbox (`KORYPHAIOS_OS_SANDBOX=1`) confines sandboxed agent
commands at the kernel level:

- **Linux**: uses `bwrap` (bubblewrap) for mount-namespace + network
  isolation. Install with `apt install bubblewrap` (Debian/Ubuntu) or
  `dnf install bubblewrap` (Fedora). If `bwrap` is unavailable, a
  sandbox-required command is rejected before it spawns.
- **macOS**: uses `sandbox-exec` with a generated profile that allows
  the workspace root and denies network when requested.
- **Windows / unsupported**: kernel path confinement is unavailable, so a
  sandbox-required command is rejected before it spawns.

When the OS sandbox is off, Koryphaios does not describe argv parsing or a
working-directory check as containment. A workflow whose policy requires path
confinement fails closed. Explicitly user-authorized unsandboxed agent commands
remain a separate mode: they run with provider/backend secrets removed from
the child environment, resource limits, process provenance, and the normal
catastrophic-command approval floor. Manual user services have their own
explicit lifecycle and environment contract.
