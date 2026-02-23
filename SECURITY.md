# Security Policy

## Overview

Koryphaios handles sensitive data including API keys, conversation history, and file system access. This document outlines security practices and guidelines.

---

## Reporting Security Issues

**DO NOT** open public GitHub issues for security vulnerabilities.

Contact the maintainers directly at: [security contact - TBD]

---

## Current Security Measures

### API Key Management

1. **Encryption at Rest**
   - Envelope encryption (KMS/local) initialized at startup when available
   - New credentials stored with envelope format; legacy `enc:` format still supported for decryption
   - Keys decrypted only in memory at runtime; never logged or exposed

2. **Session Auth**
   - Browser sessions use HttpOnly, SameSite=Strict cookies (no token in JS/localStorage).
   - `JWT_SECRET` is required in production (min 32 chars); startup fails if unset when `NODE_ENV=production`.

3. **Environment Isolation**
   - Keys stored in `.env` (gitignored)
   - Never logged or exposed in error messages
   - Separate keys per environment (dev/staging/prod)

4. **In-Transit Protection**
   - HTTPS required for production deployments
   - WebSocket connections use WSS in production
   - No keys transmitted to frontend

### Access Control

1. **CORS Policy**
   - Origin allowlist (not wildcard `*`)
   - Configured in `security.ts`
   - Rejects unauthorized origins

2. **Rate Limiting**
   - 120 requests/minute per IP (general API)
   - 15 requests/minute per IP for auth (login, register, refresh)
   - 20 requests/minute per IP for credential-setting (PUT /api/providers)
   - Per-user rate limit on critical routes (e.g. POST /api/sessions)
   - Returns 429 Too Many Requests when exceeded

3. **Input Validation**
   - Session IDs: alphanumeric, length-limited
   - Provider names: enum validation
   - Content: sanitized, max 100KB per message; JSON body max 1 MB
   - Paths: resolved and enforced under working directory (no traversal)
   - Git file paths and branch names validated

### Data Protection

1. **Session Isolation**
   - Each session has unique ID and owner (userId)
   - REST and WebSocket: session access and subscribe/user_input/accept/reject enforce ownership
   - No cross-session data leakage

2. **File System Access**
   - All file tools resolve paths under working directory; traversal attempts rejected
   - Optional allowedPaths further restricts worker access when set
   - Read-only mode available (future)

3. **Logging**
   - Structured logging with Pino
   - API keys redacted from logs
   - Sensitive data filtered

---

## Security Best Practices

### For Deployment

1. **Environment Variables**
   - `.env` is written with mode `0600` (owner read/write only) by the server.
   - Never commit `.env` to version control; keep it in `.gitignore`.
   - Exclude `.env` from backups to untrusted or shared storage.
   - Use strong, unique keys per environment; rotate keys periodically.

2. **Network Configuration**
   ```bash
   # Production should use reverse proxy (nginx/Caddy)
   # Enable HTTPS/TLS
   # Use firewall to restrict access
   ```

3. **Monitoring**
   ```bash
   # Monitor for unusual patterns:
   # - High rate limit triggers
   # - Failed authentication attempts
   # - Large file operations
   ```

### For Development

1. **Local Development**
   - Use separate API keys for dev (lower rate limits)
   - Never share `.env` files
   - Review `.gitignore` before committing

2. **Code Review**
   - Check for hardcoded secrets
   - Validate input sanitization
   - Review permission checks

3. **Dependencies**
   ```bash
   # Regularly audit dependencies
   bun audit
   
   # Keep runtime updated
   bun upgrade
   ```

---

## Security Improvements (Completed)

### Authentication
- ✅ **Real user authentication** with username/password
- ✅ **Argon2id password hashing** (memory-hard, GPU-resistant)
- ✅ **JWT access tokens** (15-min expiry); **JWT_SECRET** required in production
- ✅ **Refresh tokens** (7-day expiry), stored in database
- ✅ **Session ownership** - REST and WebSocket enforce ownership for sessions and actions
- ✅ **Default admin:** in production, **ADMIN_INITIAL_PASSWORD** (min 16 chars) required when using CREATE_DEFAULT_ADMIN
- ✅ **Bearer token auth** (JWT or `kor_` API key)

### Provider System
- ✅ **Removed 100+ fantasy providers** - only real providers remain
- ✅ **Circuit breaker pattern** - stops calling failing providers
- ✅ **Retry logic with exponential backoff** - handles transient failures

### Remaining Limitations

1. **Encryption**
   - Legacy credentials (pre-envelope) still use host-derived key when envelope init is unavailable
   - **Recommendation:** Set `KORYPHAIOS_KMS_PROVIDER` (e.g. local with passphrase) in production

2. **Rate Limiting**
   - IP can be spoofed via `X-Forwarded-For`; use a trusted proxy and single header in production
   - Per-user limits applied on critical routes; full per-user on all authenticated routes is optional

3. **File System Access**
   - Tools have read/write under project root (path traversal blocked)
   - **TODO:** Optional sandbox (e.g. Docker) for untrusted or high-risk tasks

---

## Threat Model

### In Scope

- API key theft/exposure
- Unauthorized API access
- Session hijacking
- Path traversal attacks
- Denial of service (rate limit bypass)
- XSS/injection via user input

### Out of Scope

- Physical access to server
- Social engineering
- Provider-side vulnerabilities
- Client-side malware

---

## Compliance

### Data Handling

- **Conversation History:** Stored locally in `.koryphaios/`
- **Retention:** No automatic cleanup (manual deletion required)
- **Third Parties:** Data sent to configured AI providers per their terms
- **GDPR/CCPA:** Not currently compliant (single-user system)

### Audit Trail

- All API requests logged with timestamps
- Tool executions recorded per session
- Provider authentications logged
- No PII collected by default

---

## Roadmap

### Near Term

- [x] Envelope encryption init at startup; secureEncrypt for new credentials
- [x] Environment validation (JWT_SECRET, CORS in production)
- [x] Session ownership on WebSocket (subscribe, user_input, accept/reject)
- [x] Per-user rate limiting on critical routes
- [x] Security headers on API responses
- [ ] Optional file system sandbox (Docker) for high-risk tool runs

### Medium Term

- [ ] API key rotation mechanism
- [ ] Audit log export
- [ ] Stricter CORS in production (require explicit origins)

### Long Term (v1.0)

- [ ] Integration with secrets managers (Vault, AWS Secrets)
- [ ] Multi-tenancy support
- [ ] End-to-end encryption for sessions
- [ ] Compliance certifications (SOC2, etc.)

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Bun Security Best Practices](https://bun.sh/docs/runtime/security)
- [Anthropic API Security](https://docs.anthropic.com/claude/docs/security)
- [OpenAI API Security](https://platform.openai.com/docs/guides/safety-best-practices)

---

**Last Updated:** 2026-02-21  
**Version:** 1.0.0
