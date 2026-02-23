# Auth Tokens & API Keys — Security Audit & Remediation Plan

**Harsh critic review** aligned with OWASP Secrets Management, REST Security, and token-handling best practices. Every touchpoint is listed; gaps and a prioritized remediation plan follow.

---

## 1. Touchpoint Map

### 1.1 Provider API keys / auth tokens (LLM providers)

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 1 | **Frontend: SettingsDrawer.svelte** | User types `apiKey` / `authToken` into form inputs; values held in `keyInputs` / `tokenInputs` (in-memory). Sent in `PUT /api/providers/:name` body. | **HIGH**: Inputs and request body are in memory/network; any XSS or proxy log can capture. No server-side rate limit on credential attempts. |
| 2 | **Backend: server.ts PUT /api/providers/:name** | Parses `body.apiKey`, `body.authToken`, `body.baseUrl`; passes to `setCredentials` and `verifyConnection`; persists via `persistEnvVar(..., getExpectedEnvVar(providerName, "apiKey"|"authToken"|"baseUrl"), await encryptForStorage(apiKey))`. | **MED**: Credentials in request body (HTTPS only). Ensure body/parsed values are never logged. |
| 3 | **Backend: runtime/env.ts** | `persistEnvVar` reads/writes project root `.env`; writes `key=value` (value is encrypted string when envelope encryption used). Sets `process.env[key] = value`. | **MED**: `.env` in project root can be backed up or copied; must stay gitignored and permission-restricted. |
| 4 | **Backend: security.ts** | `encryptForStorage` → envelope encryption (preferred) or legacy `encryptApiKey`. `decryptApiKey` / `secureDecrypt` for reads. Legacy uses hostname+uid+static salt (weak). | **HIGH**: Legacy encryption is deprecated and weak; anyone with code/codebase can derive key. Envelope path is correct. |
| 5 | **Backend: providers/registry.ts** | `buildProviderConfig` loads from `process.env` via `detectEnvKey`, `detectEnvAuthToken`, `detectEnvUrl`. Configs (with decrypted secrets) live in `providerConfigs` Map and are passed to provider instances. | **MED**: Secrets in process memory; acceptable if no dumping/logging. Ensure no log includes config.apiKey/authToken. |
| 6 | **Backend: server.ts Cline OAuth callback** | Exchanges code for token; `setCredentials("cline", { authToken })`; `persistEnvVar(..., getExpectedEnvVar("cline", "authToken"), await encryptForStorage(authToken))`. | **LOW** if token only in memory and encrypted at rest. |
| 7 | **Backend: server.ts Copilot device flow** | Poll for token; same persist pattern with `authToken`. | Same as #6. |

### 1.2 Session (JWT) access token

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 8 | **Frontend: auth.svelte.ts** | JWT stored in **localStorage** under `koryphaios-session-token`. Read on init; sent in `Authorization: Bearer` via `api.ts` (getAuthHeaders). | **HIGH**: OWASP and frontend security guidance: localStorage is vulnerable to XSS; any script can read it. Prefer in-memory + HttpOnly cookie for refresh. |
| 9 | **Backend: auth/auth.ts** | `JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(64).toString("hex")`. If not set, secret changes every restart (sessions invalidate). | **CRITICAL** in production: must require `JWT_SECRET` (min 32 chars) in prod; fail startup if unset. |
| 10 | **Backend: middleware/auth.ts** | `extractBearerToken(req)`; validates JWT or `kor_*` API key. Token string passed through. | **LOW** if token never logged. |

### 1.3 Programmatic API keys (kor_*)

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 11 | **Backend: apikeys/service.ts** | Create: plaintext key generated, shown once; stored as SHA-256 hash. Validate: prefix lookup, hash comparison. | **GOOD**: Key never stored in plaintext; only hash and prefix. |
| 12 | **Backend: server.ts** | API key sent as `Authorization: Bearer kor_xxx`. Validated by apikeys service; no persistence of plaintext. | **LOW** if Bearer value never logged. |

### 1.4 Persistence and env

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 13 | **.env file** | Written by `persistEnvVar` (project root). Values are `env:...` (envelope) or `enc:...` (legacy) or plaintext if encryption init failed. | **HIGH** if plaintext; **MED** if encrypted (file still sensitive). Ensure .env never committed; restrict permissions. |
| 14 | **process.env** | Provider credentials and JWT_SECRET read from env. Env is process-wide. | **MED**: Child processes or debuggers could see; avoid passing full env to subprocesses (e.g. bash tool). |

### 1.5 Logging, metrics, audit

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 15 | **Backend: serverLog / providerLog / authLog** | Various `serverLog.debug({ key }, "Persisted environment variable")` — key name only, no value. | **LOW** if no log ever gets value. Audit codebase for any `log.*(.*apiKey|.*authToken|.*password|.*token.*)` with value. |
| 16 | **Backend: metrics** | `credentials_stored` gauge by `provider`; `credential_operations_total` by `operation`, `result`. No key material. | **LOW**. |
| 17 | **Backend: audit** | Audit entries have `metadata?: Record<string, any>`. If any caller passes credential into metadata, it would be stored. | **MED**: Enforce that audit metadata must never contain apiKey, authToken, password, or raw tokens. |

### 1.6 Outbound use of credentials

| # | Location | What happens | Risk |
|---|----------|--------------|------|
| 18 | **Backend: providers (openai, anthropic, etc.)** | Config with apiKey/authToken passed to SDKs; sent in outbound HTTP (e.g. Authorization header). | **LOW** over TLS; ensure no provider SDK logs the key. |
| 19 | **Backend: tools/bash.ts** | `env: { ...process.env, PATH }` passed to subprocess. | **CRITICAL**: Full process.env can include all provider keys and JWT_SECRET. Subprocess or any child can leak them. |
| 20 | **Backend: providers/codex.ts / gemini.ts** | Some providers pass `env: { ...process.env }` or similar to CLI. | Same as #19. |

---

## 2. Gaps (Harsh Summary)

- **Session token in localStorage**: High XSS exposure; does not follow “store access token in memory only, refresh in HttpOnly cookie”.
- **JWT_SECRET default**: Production must require explicit JWT_SECRET; random fallback is insecure and breaks sessions on restart.
- **Legacy encryption**: Static key derivation (hostname + uid + salt) is weak and deprecated; migration to envelope encryption must be complete and legacy removed.
- **process.env passed to subprocesses**: Bash (and any CLI provider) must not receive full `process.env`; only a minimal allowlist (e.g. PATH, non-secret vars).
- **No explicit “never log credentials” rule**: No single place that redacts or forbids logging of body.apiKey, body.authToken, or Bearer token value.
- **.env permissions and backup**: No documented requirement for file mode (e.g. 0600) or exclusion from backups that go to untrusted storage.
- **Audit metadata**: No validation that metadata is free of credential fields.

---

## 3. Remediation Plan (Prioritized)

### P0 — Critical (do first)

| Id | Action | Owners |
|----|--------|--------|
| P0-1 | **JWT_SECRET** | Require `JWT_SECRET` in production (e.g. in config-schema or server startup): length ≥ 32, fail startup if unset when `NODE_ENV=production`. Remove `randomBytes` fallback for production. |
| P0-2 | **Subprocess env** | Stop passing full `process.env` to bash (and any CLI tool). Introduce an allowlist (e.g. `PATH`, `HOME`, `LANG`, optional `HTTP_PROXY`/`NO_PROXY`). Explicitly exclude all `*_API_KEY`, `*_AUTH_TOKEN`, `*_SECRET`, `JWT_SECRET`, and provider env vars. |
| P0-3 | **Cline/Copilot/OAuth** | Ensure OAuth callback and device-flow handlers never log the token or the code. |

### P1 — High

| Id | Action | Owners |
|----|--------|--------|
| P1-1 | **Session token storage** | Move session access token out of localStorage: keep only in memory (e.g. Svelte store), and use HttpOnly, Secure, SameSite=Strict cookie for refresh token (or short-lived access in cookie). Backend sets cookie on login/refresh; frontend sends cookie automatically and does not read token from JS. |
| P1-2 | **Legacy encryption** | Finish migration to envelope encryption for all persisted provider credentials. Remove or gate legacy `encryptApiKey`/`decryptApiKey` (e.g. only when envelope init fails and a “legacy mode” flag is set). Document migration in ENCRYPTION_MIGRATION_GUIDE. |
| P1-3 | **Request body and auth headers** | Add a single “safe request log” helper: when logging requests, redact `body.apiKey`, `body.authToken`, `body.baseUrl` (or entire body for PUT /api/providers/*), and strip or redact `Authorization` header (e.g. “Bearer ***”). Use it everywhere request data is logged. |
| P1-4 | **.env handling** | On write, set file mode to 0600 (owner read/write only). Document that .env must be excluded from backups to untrusted storage and must remain in .gitignore. |

### P2 — Medium

| Id | Action | Owners |
|----|--------|--------|
| P2-1 | **Audit metadata** | Before writing audit entries, sanitize `metadata`: remove or redact any key that matches `apiKey`, `authToken`, `password`, `token`, `secret`, or similar. Consider a allowlist of safe keys. |
| P2-2 | **Provider config in memory** | Document that provider configs (with decrypted secrets) must not be serialized or sent to frontend. Ensure getStatus() and any provider list API return only auth status (e.g. “authenticated” boolean), not keys or tokens. |
| P2-3 | **Rate limiting** | Apply rate limiting to PUT /api/providers/:name (and login/OAuth) to reduce brute-force and credential-stuffing risk. |
| P2-4 | **CORS and CSRF** | Confirm CORS is allowlist-only (no wildcard in production). If cookies are used for refresh/session, add CSRF protection (e.g. double-submit or SameSite). |

### P3 — Hardening

| Id | Action | Owners |
|----|--------|--------|
| P3-1 | **Key rotation** | Document how to rotate provider API keys and JWT_SECRET without downtime; support re-encryption of .env values when KEK rotates. |
| P3-2 | **Secrets scanning** | Add pre-commit or CI check (e.g. gitleaks, truffleHog) to block commits that contain API keys or tokens. |
| P3-3 | **Security headers** | Ensure all API and app responses send security headers (X-Content-Type-Options, X-Frame-Options, etc.); already partially done in security.ts. |

---

## 4. Checklist (Quick Reference)

- [x] JWT_SECRET required in production, no random fallback.
- [x] Subprocess env allowlist; no provider or auth env vars passed to bash/CLI.
- [x] No logging of request body (provider PUT) or Authorization header value; redactForLog/redactAuthorizationHeader available.
- [x] Session token not in localStorage; HttpOnly cookies (koryphaios_session, koryphaios_refresh).
- [x] Legacy encryption gated; production requires envelope encryption.
- [x] .env file mode 0600 on write (cross-platform).
- [x] Audit metadata sanitized (no credential fields).
- [x] Rate limiting on credential-setting and auth endpoints.
- [x] SameSite=Strict cookies for cookie-based auth (CSRF mitigation).

---

## 5. File Reference (for implementation)

| Concern | Files |
|--------|--------|
| Provider credentials flow | `frontend/src/lib/components/SettingsDrawer.svelte`, `backend/src/server.ts` (PUT /api/providers), `backend/src/providers/registry.ts`, `backend/src/runtime/env.ts` |
| Encryption | `backend/src/security.ts`, `backend/src/crypto/` |
| Session/JWT | `frontend/src/lib/stores/auth.svelte.ts`, `backend/src/auth/auth.ts`, `frontend/src/lib/api.ts` |
| Subprocess env | `backend/src/tools/bash.ts`, `backend/src/providers/codex.ts`, `backend/src/providers/gemini.ts` |
| API keys (kor_*) | `backend/src/apikeys/service.ts`, `backend/src/middleware/auth.ts` |
| Audit | `backend/src/services/audit.ts` |
| Config validation | `backend/src/config-schema.ts` |

This plan should be tracked (e.g. in SECURITY.md or project board) and each item closed with a short “done” note and PR reference.
