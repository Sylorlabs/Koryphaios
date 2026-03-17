# Security Policy

## Overview

Koryphaios is a **local-first, single-user desktop application**. All data—including API keys, conversation history, and files—stays on your machine. This document outlines the security architecture and best practices.

---

## Architecture: Local-First by Design

Koryphaios is designed as a **local desktop application**, not a multi-tenant web service:

- **Database**: SQLite file stored locally in `.koryphaios/koryphaios.db` (no external database)
- **Data**: All session history, messages, and metadata stored locally
- **Network**: WebSocket/HTTP only for frontend↔backend communication on localhost
- **Encryption**: API keys encrypted at rest using envelope encryption

---

## Reporting Security Issues

**DO NOT** open public GitHub issues for security vulnerabilities.

Contact the maintainers directly at: [security contact - TBD]

---

## Implemented Security Measures

### 1. Encryption at Rest (Envelope Encryption)

API keys and sensitive credentials are encrypted using **envelope encryption** with AES-256-GCM:

**How It Works:**
1. A unique Data Encryption Key (DEK) is generated for each API key
2. The DEK is encrypted by a Key Encryption Key (KEK) from your chosen KMS provider
3. The encrypted DEK + encrypted data are stored together (the "envelope")
4. At runtime, the KEK decrypts the DEK, which then decrypts the data

**KMS Providers Supported:**

| Provider | Environment Variable | Use Case |
|----------|---------------------|----------|
| **Local** (default) | `KORYPHAIOS_MASTER_KEY` | Single-user desktop, development |
| **AWS KMS** | `KORYPHAIOS_KMS_KEY_ID` | Enterprise AWS deployments |
| **HashiCorp Vault** | `VAULT_ADDR`, `VAULT_TOKEN` | Enterprise secret management |
| **Azure Key Vault** | `KORYPHAIOS_KMS_VAULT_NAME` | Azure environments |
| **GCP KMS** | `GCP_PROJECT_ID` | Google Cloud environments |

**Setup (Local/Default):**
```bash
# Generate a strong master key
openssl rand -hex 32

# Add to .env
KORYPHAIOS_MASTER_KEY=your-64-character-hex-key-here
```

**Production/Enterprise Setup:**
```bash
# Use AWS KMS instead of local key
KORYPHAIOS_KMS_PROVIDER=aws-kms
KORYPHAIOS_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789:key/your-key-id
AWS_REGION=us-east-1
```

### 2. Authentication & Session Management

- **No User Accounts**: Koryphaios operates without user accounts or passwords
- **Session Tokens**: Short-lived JWT tokens for API access (derived from `JWT_SECRET`)
- **Root Token**: Generated on startup, displayed once in console, stored in `.koryphaios/.root-token` (mode 600)

**Important:** Set a strong `JWT_SECRET` in your `.env`:
```bash
JWT_SECRET=$(openssl rand -hex 32)  # 64 characters minimum
```

### 3. Filesystem Scope Enforcement

- **Fail-Close Default**: All file operations denied by default
- **Project Root Restriction**: Agent can only access files within the project directory
- **Path Traversal Prevention**: `../` and absolute paths (`/etc/passwd`) are blocked
- **Sandbox Mode**: Workers operate in sandboxed git worktrees for isolation

### 4. Network Security

- **CORS Allowlist**: Only configured origins can access the API (defaults to localhost only)
- **Rate Limiting**: IP-based rate limiting prevents abuse
- **SSRF Protection**: URL validation blocks private networks and cloud metadata endpoints
- **No External Exposure**: Designed to run on localhost only

---

## Security Model

### Threat Model

**In Scope (Protected Against):**
- API key theft from local storage
- Path traversal attacks
- SSRF attacks against internal services
- Accidental exposure of credentials in logs

**Out of Scope (Accept Risks):**
- Physical access to your machine (attacker with root can read memory)
- Malicious code execution (bash tool can run arbitrary commands)
- Network interception (use HTTPS reverse proxy for remote access)

### Bash Execution Warning

⚠️ The `bash` tool executes commands as your user. While destructive commands (`rm -rf /`, `mkfs`) are blocked heuristically, this is **not sandboxed execution**.

**Recommendations:**
- Run Koryphaios in a container (Docker/Podman) for untrusted code
- Use the "critic" agent to review changes before applying
- Keep backups of important projects

---

## Getting Started Securely

### 1. Generate Required Secrets

```bash
# Create .env file with secure values
cat > .env << 'EOF'
# Required: 64+ character JWT secret
JWT_SECRET=$(openssl rand -hex 32)

# Required: Master key for API key encryption
KORYPHAIOS_MASTER_KEY=$(openssl rand -hex 32)

# Optional: Your LLM provider API keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
EOF
```

### 2. Validate Security on Startup

The server validates security configuration on startup and will **fail fast** if:
- `JWT_SECRET` is missing or < 64 characters
- `KORYPHAIOS_MASTER_KEY` is missing (in production mode)

### 3. Store API Keys Securely

Use the Settings UI or API to store provider credentials—they will be automatically encrypted:

```bash
# API keys are encrypted before storage
curl -X PUT http://localhost:3000/api/providers/anthropic \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "sk-ant-..."}'
# Stored as: env:eyJkZWtFbmNyeXB0ZWQiOiJhYmNkLi4u
```

---

## Known Limitations

### GDPR/CCPA

Not compliant with data privacy regulations (intentionally single-user system). Data never leaves your machine except when sent to LLM providers per their terms.

### No Multi-User Support

Koryphaios is designed for single-developer use. There's no concept of user accounts, permissions, or access control.

### Container Recommendation

For running untrusted code or AI-generated bash commands, use a container:

```dockerfile
FROM oven/bun:latest
WORKDIR /workspace
COPY . .
RUN bun install
EXPOSE 3000
CMD ["bun", "run", "dev"]
```

---

## Best Practices

1. **Never commit `.env`** — Add to `.gitignore`
2. **Use strong secrets** — 64+ characters for `JWT_SECRET` and `KORYPHAIOS_MASTER_KEY`
3. **Rotate keys regularly** — Regenerate `KORYPHAIOS_MASTER_KEY` periodically
4. **Backup `.koryphaios/`** — Contains your SQLite database and encrypted keys
5. **Use HTTPS for remote** — If accessing remotely, use Nginx/Caddy with HTTPS

---

## Security Checklist

Before deploying in a sensitive environment:

- [ ] `JWT_SECRET` set to 64+ character random string
- [ ] `KORYPHAIOS_MASTER_KEY` set (or enterprise KMS configured)
- [ ] `.env` added to `.gitignore`
- [ ] `.koryphaios/` directory has restricted permissions (0700)
- [ ] CORS origins explicitly configured (not using defaults)
- [ ] Running behind HTTPS reverse proxy (if remote access needed)
- [ ] Regular backups of `.koryphaios/koryphaios.db`

---

**Last Updated:** 2026-03-10
**Version:** 1.0.0
