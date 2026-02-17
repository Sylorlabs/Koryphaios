# Security Policy

## Overview

Koryphaios handles sensitive data including API keys, conversation history, and file system access. This document outlines security practices and guidelines.

---

## Reporting Security Issues

**DO NOT** open public GitHub issues for security vulnerabilities.

Contact the maintainers directly at: [security contact - TBD]

---

## Implemented Security Measures

### 1. Authentication & Authorization
- **Session Tokens (JWT):** All API endpoints (except health checks) require a valid session token signed with `HS256`.
- **Root Access Control:** The server generates a unique "Root Token" on startup, printed only to the server console. This token is required to initialize client sessions.
- **WebSocket Auth:** WebSocket upgrades are protected by token validation (`?token=...`).

### 2. Encryption at Rest (AES-256-GCM)
- **Strong Key Derivation:** API keys stored in `.env` are encrypted using `AES-256-GCM`.
- **PBKDF2 Hashing:** The encryption key is derived from a user-provided `KORY_APP_SECRET` using PBKDF2 (100,000 iterations), ensuring resistance against brute-force attacks.
- **Fail-Secure:** If `KORY_APP_SECRET` is missing, the server will refuse to start in production mode (or warn loudly in dev).

### 3. Filesystem Scope Enforcement
- **Fail-Close Default:** All file operations (read, write, delete, list) are denied by default.
- **Strict Allow-List:** The agent is restricted to operating *only* within the project root directory (or configured workspace).
- **Path Traversal Prevention:** All paths are normalized and resolved. Attempts to access `../` or absolute system paths (e.g., `/etc/passwd`) are blocked at the application level.

### 4. Network Security
- **CORS Allowlist:** Strict origin checking prevents unauthorized browser requests.
- **Rate Limiting:** IP-based rate limiting with a "penalty box" mechanism for abusive clients.

---

## Getting Started Securely

1. **Generate Secrets:**
   Run the helper script to generate a strong application secret. This is required for secure encryption.
   ```bash
   bun run scripts/generate-secret.ts
   ```

2. **Start the Server:**
   ```bash
   bun run start
   ```

3. **Authenticate:**
   Copy the **Root Token** displayed in the console output. You will need this to connect your frontend or CLI client.

---

## Known Limitations

### Current Implementation

1. **Bash Execution**
   - ⚠️ While file operations are sandboxed, `bash` command execution runs as the user.
   - **Mitigation:** Destructive commands (`rm -rf /`, `mkfs`) are blocked, but this is a heuristic.
   - **Recommendation:** Run the server inside a container (Docker/Podman) for true isolation if you intend to execute untrusted code.

2. **GDPR/CCPA**
   - ⚠️ Not currently compliant (single-user system).
   - Data is stored locally in `.koryphaios/` and sent to AI providers per their terms.

---

## Best Practices for Deployment

1. **Environment Variables**
   - Never commit `.env` to version control.
   - Use `KORY_APP_SECRET` with high entropy (use the generator script).

2. **Network Configuration**
   - Always run behind a reverse proxy (Nginx/Caddy) with HTTPS enabled in production.
   - Do not expose the port (default 3000) directly to the public internet.

---

**Last Updated:** 2026-02-16
**Version:** 0.1.0
