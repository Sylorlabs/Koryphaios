# Security & Connectivity Audit Report (Feb 2026)

## 1. API Endpoints Updated (2026 Compliance)

| Provider   | Base URL / Endpoint | Notes |
|-----------|----------------------|--------|
| **Anthropic** | `https://api.anthropic.com` | Messages API: `POST /v1/messages`. Model list: `GET /v1/models`. No change. |
| **OpenAI**    | `https://api.openai.com/v1/` | Model list: `GET /v1/models`. Responses API: `GET /v1/responses` (GPT-5.2). No change. |
| **Google Gemini** | `https://generativelanguage.googleapis.com` | Use **v1beta** for latest models (e.g. Gemini 3.1 Pro Preview). Model list: `GET /v1beta/models?key=...`. v1 is stable; v1beta has Gemini 3.1. |

All verification (minimal ping) uses **GET** to list models only; no full prompts or 1-token completions are used, to minimize cost.

---

## 2. Model Updates (Retired Models Removed from Defaults)

- **Retired (Feb 2026):** Claude 3.7 Sonnet, Claude Haiku 3.5. Removed from default fallback chains and marked legacy in catalog.
- **Default mappings updated:**
  - Manager/Coder: `claude-sonnet-4-6`
  - Task: `gpt-5-mini`
  - Fallbacks: `claude-sonnet-4-6` → `claude-sonnet-4-5` → `gpt-5-mini` → `gemini-3.1-pro`
- **Gemini 3.1** added: `gemini-3.1-pro` (apiModelId: `gemini-3.1-pro-preview`).
- **Legacy list** extended: `claude-3.7-sonnet`, `claude-3.5-haiku`, `claude-3.5-sonnet` in `isLegacyModel()`.

---

## 3. KeyValidator Utility

- **Path:** `backend/src/core/auth/KeyValidator.ts`
- **Behavior:** Minimal ping via GET to provider model-list endpoints; 5s timeout on all requests.
- **Exports:** `validateProviderKey(provider, credentials)`, `validateProviderKeys(map)`, types `KeyStatus`, `KeyValidationResult`.
- **Security:** Keys are never logged; only status and optional error message are returned.

---

## 4. Database Security Audit

- **api_keys table (koryphaios.db):**
  - Keys stored as **hashed_key** (SHA-256); no plaintext in DB.
  - `listForUser()` does not return `hashedKey`; only prefix and metadata.
  - Logging: only `keyId`, `userId`, and counts are logged; no key material.
- **user_credentials table:** Encrypted per-user; decrypt only when needed; audit log does not store credential values.
- **model_settings.is_checked:** Represents user preference for auto-routing (which models are “checked” for use). Key validity is separate; Health Check CLI reports current key status so users can align is_checked with valid keys.

---

## 5. Automated Tests

- **Path:** `backend/__tests__/auth.test.ts`
- **Coverage:**
  - NO_KEY when no apiKey/authToken
  - Mocked **401** → INVALID for anthropic, openai, google
  - Mocked **200** → VALID for anthropic, openai, google
  - Timeout / abort → INVALID
  - Unsupported provider → INVALID
  - Optional **live** connectivity test when `.env` has keys (skipped if no keys)

Run: `cd backend && bun test __tests__/auth.test.ts`

---

## 6. Health Check CLI

- **Command:** `bun run health` (from `backend/`) or `cd backend && bun run health`
- **Output format:** `[Model Name]: [VALID | INVALID | NO_KEY]`
- **Behavior:** Loads `.env` from repo root or backend; runs KeyValidator for Anthropic, OpenAI, Google, Groq, OpenRouter, xAI; all requests use 5s timeout.

---

## 7. Safe Execution (Timeout)

- **KeyValidator:** Every `fetch` uses `AbortController` + 5s timeout.
- **Provider registry:** `verifyHttp()` now uses 5s timeout to avoid Bun shell/IDE hangs.

---

## Summary

- Endpoints verified and documented; defaults point to Claude 4.6 and Gemini 3.1; retired models removed from defaults.
- KeyValidator provides minimal-ping verification with no key logging.
- Database stores only hashed/encrypted secrets; logging excludes key material.
- `auth.test.ts` passes with mocked 401/200 and optional live test.
- Health Check CLI reports `[Model Name]: [VALID/INVALID/NO_KEY]` for keys in `.env`.
