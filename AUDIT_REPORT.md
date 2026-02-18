# Koryphaios Provider & Security Audit Report

This document details the findings from a "harshest critic" review of the Koryphaios backend provider system and security implementation.

## 1. Summary of Findings

The current implementation is **functional but fragile**. It relies heavily on external CLI tools (`gemini`, `codex`, `gh`, `claude`) being present in the environment, and fails catastrophically (crashes) if they are missing or behave unexpectedly. The security measures for API keys are "security theater" rather than robust protection.

**Critical Issues:**
- **Runtime Crashes:** The application crashed immediately upon startup in a clean environment due to missing CLI tools and buggy constructor logic in `CopilotProvider`. (Fixed during audit to allow verification).
- **Synchronous Network Calls:** The `CopilotProvider` constructor performs a synchronous `curl` request to exchange tokens. This blocks the entire Node/Bun event loop, freezing the server during provider initialization.
- **Weak Encryption:** API key encryption uses a hardcoded salt and machine-specific seed (hostname/uid), making it trivial to decrypt if the code is known.
- **SSRF Vulnerability:** The `validateUrl` function is vulnerable to DNS rebinding attacks (time-of-check vs time-of-use).
- **"Antigravity" Anomaly:** The `GoogleAuthManager` includes logic for an "Antigravity" provider that appears to be an internal Google tool or a hack. It spawns a local server on port 51121 and refers to "hijacking" sessions.

## 2. Detailed Verification Results

An automated audit script was executed to verify provider connectivity and configuration.

| Provider | Status | Result | Root Cause / Notes |
| :--- | :--- | :--- | :--- |
| **Anthropic** | Failed | `Missing apiKey or authToken` | Expected. Requires `ANTHROPIC_API_KEY` or `claude` CLI login. |
| **OpenAI** | Failed | `Missing token` | Expected. Requires `OPENAI_API_KEY`. |
| **Google** | Failed | `gemini CLI not found` | **Fragile.** Relies on `gemini` CLI being in PATH if no API key is provided. |
| **Copilot** | Failed | `GitHub Copilot auth token not found` | **Critical Fix Applied.** The constructor originally crashed the process. Now fails gracefully. |
| **Cline** | Failed | `Missing authToken` | Expected. |
| **Codex** | Failed | `codex CLI not found` | **Fragile.** Relies on `codex` CLI wrapper. |
| **Azure** | Failed | `Missing apiKey` | Expected. |
| **Bedrock** | Failed | `AWS credentials not detected` | Expected. |
| **VertexAI** | Failed | `Vertex AI credentials not detected` | Expected. |

## 3. Codebase Analysis

### 3.1. `backend/src/providers/copilot.ts`
- **Bug:** The constructor attempted to assign to a readonly getter `this.client = ...`, causing a runtime crash. *Fixed during audit.*
- **Performance:** Uses `Bun.spawnSync("curl", ...)` to exchange tokens. This halts the entire backend process for up to 15 seconds (timeout) if the network is slow. **Must be async.**

### 3.2. `backend/src/providers/auth-utils.ts`
- **Bug:** `spawnSync` calls for CLI detection (e.g., `claude status`, `gh auth`) threw `ENOENT` when the tool was missing, crashing the app. *Fixed during audit by adding try-catch blocks.*
- **Logic:** CLI detection is "optimistic" and doesn't verify if the tool is actually usable, just if it exists/returns 0.

### 3.3. `backend/src/security.ts`
- **Encryption:**
  ```typescript
  const SALT = "koryphaios-key-salt-v1"; // Hardcoded
  const seed = `${hostname}:${uid}:${SALT}`;
  ```
  This offers zero protection against an attacker who has file access (to read the code and the encrypted keys). It only obfuscates keys from casual inspection.
- **URL Validation:** `validateUrl` resolves DNS, checks the IP, and then returns `true`. The subsequent `fetch` does a *new* DNS resolution. A malicious DNS server can return a safe IP first, then a local IP (127.0.0.1) second, bypassing the check.

### 3.4. `backend/src/providers/google-auth.ts` ("Antigravity")
- **Suspicious Code:** The "Antigravity" provider integration seems to be a reverse-engineered or internal-only feature. It uses a custom OAuth client ID and "hijacks" a session. This is likely to break at any time if Google changes their internal endpoints.

## 4. Recommendations & Fix Plan

1.  **Async Initialization:** Rewrite `CopilotProvider` (and others) to perform token exchange asynchronously, not in the constructor. The constructor should be lightweight.
2.  **Robust CLI Wrappers:** Ensure all CLI wrappers (`gemini`, `codex`) check for tool existence *safely* without crashing.
3.  **Secure Encryption:** Move the encryption key/salt to an environment variable (`KORYPHAIOS_MASTER_KEY`). If not present, warn the user or disable encryption (don't use a hardcoded default).
4.  **Fix SSRF:** Use a custom `Dispatcher` for `undici` (Bun's fetch underlying lib) or similar mechanism to pin the DNS resolution to the checked IP.
5.  **Remove/Flag Antigravity:** Decide if "Antigravity" is a supported feature. If not, remove it. If so, mark it as "Experimental/Internal".

## 5. Conclusion

The "harshest critic" assessment is that the system is currently **alpha-quality**. It works only on the developer's machine where all tools are installed and configured perfectly. In a production or CI environment, it is unstable and insecure.
