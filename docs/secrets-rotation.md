# Secrets rotation runbook

Koryphaios uses three long-lived secrets that protect authentication and the
collaboration relay:

| Secret | Protects | Rotation scope |
|--------|----------|----------------|
| `JWT_SECRET` | JWT signing for user auth tokens | Backend only — new secret takes effect on next backend restart. All existing JWTs become invalid; users re-authenticate. |
| `SESSION_TOKEN_SECRET` | HMAC signing for session tokens | Backend only — same as above. Existing sessions are invalidated. |
| `RELAY_HOST_SECRET` | Host authentication on the collaboration relay | **Backend AND relay server.** The relay must accept the new secret; otherwise hosting fails. |

## Rotate secrets on this machine

```bash
bun run scripts/rotate-secrets.ts
```

This script:

1. Generates fresh 64-hex-char secrets using `crypto.randomBytes(32)`.
2. Writes them to `~/.config/koryphaios/secrets.env` (mode `0o600`), which
   lives **outside the repo tree** and is loaded by the backend at startup.
3. Backs up the existing repo `.env` to `.env.pre-rotation.bak` (gitignored)
   and scrubs the three secret lines plus `RELAY_URL` from the repo `.env`.

Run with `--dry-run` first to preview the changes:

```bash
bun run scripts/rotate-secrets.ts --dry-run
```

After running, restart the backend so it picks up the new secrets.

## Rotate `RELAY_HOST_SECRET` on the relay server

Generating a new `RELAY_HOST_SECRET` here does **not** invalidate the old one
on the relay. If you operate the relay host (e.g. `158.51.125.29:8080` or
whatever `RELAY_URL` points to), you must also update the secret there:

1. SSH to the relay host.
2. Update the relay's `RELAY_HOST_SECRET` to match the value in
   `~/.config/koryphaios/secrets.env`.
3. Restart the relay service.

Until you do this, the relay will reject hosts authenticating with the new
secret.

## What lives where

| Location | Contents | Gitignored? |
|----------|----------|-------------|
| `~/.config/koryphaios/secrets.env` | `JWT_SECRET`, `SESSION_TOKEN_SECRET`, `RELAY_HOST_SECRET` | N/A (outside repo) |
| `<repo>/.env` | Provider API keys for local dev, `RELAY_URL`, non-secret overrides | Yes |
| `<repo>/.env.pre-rotation.bak` | Pre-rotation backup of the repo `.env` | Yes |
| `<repo>/.env.example` | Template listing all supported env vars (no real values) | No |

## If the old secrets were committed or leaked

If the old secrets were ever pushed to a public branch or shared, treat them
as compromised:

1. Rotate all three secrets using the script above.
2. Rotate `RELAY_HOST_SECRET` on the relay host.
3. Audit relay logs for unauthorized host activity during the exposure window.
4. Rotate any provider API keys that were in the same `.env` file via each
   provider's dashboard (Anthropic, OpenAI, etc.).
