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
   - API keys are encrypted before storage in `.env`
   - Uses symmetric encryption with derived key
   - Keys are decrypted only in memory at runtime

2. **Environment Isolation**
   - Keys stored in `.env` (gitignored)
   - Never logged or exposed in error messages
   - Separate keys per environment (dev/staging/prod)

3. **In-Transit Protection**
   - HTTPS required for production deployments
   - WebSocket connections use WSS in production
   - No keys transmitted to frontend

### Access Control

1. **CORS Policy**
   - Origin allowlist (not wildcard `*`)
   - Configured in `security.ts`
   - Rejects unauthorized origins

2. **Rate Limiting**
   - **Current:** 120 requests/minute per IP
   - Applied to all API endpoints
   - Returns 429 Too Many Requests when exceeded

3. **Input Validation**
   - Session IDs: alphanumeric, length-limited
   - Provider names: enum validation
   - Content: sanitized, max 100KB per message
   - Paths: normalized to prevent traversal

### Data Protection

1. **Session Isolation**
   - Each session has unique ID
   - Messages scoped to session
   - No cross-session data leakage

2. **File System Access**
   - Tools restricted to current working directory
   - Path normalization prevents `../` attacks
   - Read-only mode available (future)

3. **Logging**
   - Structured logging with Pino
   - API keys redacted from logs
   - Sensitive data filtered

---

## Security Best Practices

### For Deployment

1. **Environment Variables**
   ```bash
   # Never commit .env to version control
   echo ".env" >> .gitignore

   # Use strong, unique keys per environment
   # Rotate keys quarterly
   ```

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

## Known Limitations

### Current Implementation

1. **Encryption Key Derivation**
   - ⚠️ Uses basic symmetric encryption
   - ⚠️ Key derived from static seed
   - **TODO:** Migrate to proper KMS or vault

2. **Session Authentication**
   - ⚠️ No user authentication system
   - ⚠️ Sessions accessible to anyone with ID
   - **TODO:** Add session tokens/JWT

3. **Rate Limiting**
   - ⚠️ IP-based only (can be spoofed with proxies)
   - ⚠️ No per-user or per-session limits
   - **TODO:** Multi-factor rate limiting

4. **File System Access**
   - ⚠️ Tools have full read/write to CWD
   - ⚠️ No granular permission system
   - **TODO:** Sandbox file operations

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

### Near Term (v0.2)

- [ ] Migrate to proper key derivation (PBKDF2/Argon2)
- [ ] Add environment variable validation on startup
- [ ] Implement session token authentication
- [ ] Add per-session rate limiting
- [ ] Security headers middleware

### Medium Term (v0.3)

- [ ] File system sandboxing
- [ ] User authentication system
- [ ] API key rotation mechanism
- [ ] Audit log export
- [ ] Permission system for tool execution

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

**Last Updated:** 2026-02-15
**Version:** 0.1.0
