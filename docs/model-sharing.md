# Model sharing

In **Settings → Team access → Models you share**:

1. Enter a **Host name** (the label recipients will see).
2. Enable connected inference providers and use **Configure models** to select the models to expose.
3. Click **Share models**. Koryphaios displays and copies an eight-character **model-sharing code**.
4. The recipient enters the code under **Use someone's models** and clicks **Use shared models**. Selected models appear under labels such as `Micah · OpenAI`.

**Update sharing** applies the current name and selection. Name changes are sent to connected recipients. The active code is restored when reopening settings in the same backend process. **Stop sharing** revokes the code and signed invitations and terminates active remote requests. Starting again creates a new code.

Sharing updates and stop/start requests are applied in order, including overlapping settings requests. Cancelling or ending a recipient's response stream early cancels the corresponding host inference.

## Authority and credentials

Model-sharing codes grant inference access, not access to a host workspace, session history, shell, MCP bridge, native agent, login, or credential store. Native CLI/SDK agents are excluded from model-code catalogs and refused server-side, including requests that forge their `agentic` flag. Connected remote providers cannot be re-shared through this surface.

Guest requests are validated and projected onto a bounded inference contract. Local session IDs, paths, permission modes, roles, authentication fields and bridge authority supplied by a guest are discarded. The backend pins execution to the shared provider, so an availability change cannot fall through to a native adapter. Function definitions may be sent to the model, but function calls are returned to the recipient's local agent loop; the host does not execute them.

Credentials are used by host-side provider adapters. Catalogs expose only public model metadata; output strips non-contract fields, filters known credential values across streamed chunks, and keeps raw upstream errors host-local. Internet sharing requires HTTPS/WSS; plain HTTP is supported only for loopback testing.

Codes use cryptographic randomness. The relay limits code lookups to 20 attempts per minute per source address. Each model-sharing session permits at most two concurrent inferences and 30 requests per minute, with a two-minute request timeout and bounded output settings. Anyone holding a code can consume the selected provider's inference quota until it is revoked; code possession does not grant host execution rights.

Prompt injection can still affect generated text. Host protection comes from the lack of host execution authority, not from asking the model to ignore malicious instructions. Recipients' local tools remain subject to their own Koryphaios permission policy.

Deploy the updated `relay/server.ts` with the backend/frontend. Model sharing refuses relays without model-only isolation and invitation-revocation support.
