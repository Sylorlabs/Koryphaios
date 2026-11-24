# Agent registry (`acp:<id>`)

Kory can drive any agent that speaks the Agent Client Protocol (ACP) over stdio,
without shipping a hand-written adapter for it. A registered agent becomes a
provider named `acp:<id>` that can be selected as a model, used as a delegation
target, and placed in fallback chains like any other provider.

The enforcement model is the same one the `opencode` provider uses:

- Kory tools go through the Kory MCP bridge, passed per ACP session
  (`session/new.mcpServers`) with a session-scoped grant. Nothing is written
  into the user's workspace or into the agent's own configuration.
- The agent's native mutating tools are vetoed at `session/request_permission`.
  Edit, delete, move and execute kinds are rejected, fail-closed.
- An agent is selectable only after a capability probe has passed.

## Sources

| Source | What it is | What Kory does with it |
| --- | --- | --- |
| Official registry | `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` | Read-only fetch with a 10 s timeout, redirects refused, a 2 MB cap, and a host check. Cached for 6 h on success and 10 min on failure. Entries show install instructions. Nothing is installed or downloaded by Kory. |
| PATH autodetect | Known ACP-capable CLI names found on `PATH` (for example `gemini`, `goose`, `copilot`) | Listed as `available`. Listing is never enablement. The argument sets are candidates (`argsVerified: false`) until a probe succeeds. Agents already served by a built-in provider (`opencode`, `devin`) are not listed. |
| Manual / custom | A command, arguments, env and policy entered by the user | Validated, saved, and probed when added. |
| OpenAI-compatible endpoints | `custom:*` providers | Unchanged. |

The registry index is a JSON object with `version`, `agents[]` and `extensions`.
Each agent has `id`, `name`, `version`, `description`, `repository`, `website`,
`license`, `icon`, and `distribution` (`npx`, `uvx` or `binary`). The public
schema is at `github.com/agentclientprotocol/registry`. Kory parses it
defensively and drops malformed entries.

## Lifecycle

1. **Add.** `POST /api/agents/custom` validates the input, runs the capability
   probe (unless `probe: false`), saves the definition, and registers the
   provider with the verdict.
2. **Probe.** The probe starts the agent with a minimal environment in an empty
   private directory. It runs `initialize`, requires `protocolVersion === 1`,
   and calls `session/new` with no MCP servers. It sends no prompt and attaches
   no bridge. The probe has a 20 s timeout and removes its directory afterward.
   The verdict records `ok`, the protocol version, the agent name and version,
   the model ids the agent offers, and a sanitized error.
3. **Use.** A turn spawns the agent, negotiates the session, and streams its
   updates into Kory events. An agent with no `ok` verdict refuses turns with an
   error that says to run the probe.
4. **Re-probe.** `POST /api/agents/:id/probe` runs the probe again with the
   stored environment and replaces the verdict.
5. **Remove.** `DELETE /api/agents/custom/:id` removes the definition, its
   secrets, its verdict, and the provider.

A failed probe keeps the agent, marked `probe-failed`, so the user can fix the
environment and re-probe. It is not selectable until it passes.

## Storage

| Data | Location | Notes |
| --- | --- | --- |
| Definition (`id`, `label`, `command`, `args`, `envNames`, `cwdPolicy`, `permissionProfile`, `source`, `registryId`) | `koryphaios.json`, key `acpAgents` | No secret values. Other keys in the file are preserved. |
| Env values | `<root>/.koryphaios/acp-agent-env.json`, mode 0600 | The secret store. Only the names are in config. |
| Probe verdicts | `<root>/.koryphaios/acp-agent-verdicts.json`, mode 0600 | Local state. |

`<root>` is `KORYPHAIOS_DATA_DIR` when it is set, otherwise the project root.
`syncProviderConfigsToConfig` skips `acp:*` providers, so ACP definitions persist
only under `acpAgents`.

Env names must be `UPPER_SNAKE_CASE`, at most 32 per agent. These names are
refused because they change how code loads or runs before the agent starts:
`PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `PYTHONPATH`,
`PYTHONSTARTUP`, `RUBYOPT`, `PERL5OPT`, and any name starting with `LD_`,
`DYLD_`, `BUN_` or `NODE_`.

## Child environment

Default-deny. The agent receives only an allowlist from the backend environment
(`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`,
`TMP`, `TEMP`, `USERPROFILE`, `SYSTEMROOT`, `APPDATA`, `LOCALAPPDATA`,
`HOMEDRIVE`, `HOMEPATH`, and the `XDG_*` directories), plus the secret values
bound to that agent. Provider keys and Kory bridge grants are not inherited.

## Permission profiles

Every profile answers `session/request_permission` fail-closed. Anything not on
the profile's list is rejected.

| Profile | Allowed kinds | Use |
| --- | --- | --- |
| `bridge-only` (default) | `read`, `search`, `fetch`, `think`, `other`, `switch_mode` | Normal turns. Native edit, delete, move and execute are rejected. Kory tools go through the bridge. |
| `read-only` | `read`, `search`, `think` | Used automatically for research-only and native-tools-disabled turns, and selectable per agent. |

Research-only turns also set the agent's `plan` mode when it offers one, and wire
no bridge. `nativeToolsDisabled` turns run in a private temp directory.

## Sandbox

When a turn requests a sandbox, the agent runs under `buildSoftJail` with
`wrapCommand`, as the opencode provider does. The jail HOME is empty, so an
agent that reads its login from `$HOME` will fail inside the sandbox. Give such
an agent explicit config-directory variables in its env.

## API contract

All routes are local-only and require the usual local route auth. Every mutating
route pushes `provider.status` over the WebSocket. Env values are accepted on
`POST /api/agents/custom` and are never returned.

### `GET /api/agents/registry?refresh=1`

Returns the merged listing. `refresh=1` bypasses the registry cache.

```json
{
  "ok": true,
  "data": {
    "registry": {
      "ok": true,
      "url": "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      "fetchedAt": 1790000000000,
      "source": "network"
    },
    "agents": [
      {
        "id": "my-agent",
        "name": "My Agent",
        "source": "custom",
        "status": "ready",
        "providerName": "acp:my-agent",
        "command": "/opt/agents/my-agent",
        "args": ["acp"],
        "envNames": ["MY_AGENT_TOKEN"],
        "cwdPolicy": "workspace",
        "permissionProfile": "bridge-only",
        "probe": { "ok": true, "checkedAt": 1790000000000, "durationMs": 120,
                   "models": ["fast", "deep"], "protocolVersion": 1, "agentName": "my-agent" }
      },
      {
        "id": "gemini",
        "name": "Gemini CLI",
        "source": "autodetect",
        "status": "available",
        "binaryPath": "/usr/local/bin/gemini",
        "command": "/usr/local/bin/gemini",
        "args": ["--experimental-acp"],
        "argsVerified": false
      },
      {
        "id": "agoragentic-acp",
        "name": "Agoragentic",
        "source": "registry",
        "status": "not-added",
        "version": "1.3.0",
        "install": { "kind": "npx", "command": "npx", "args": ["-y", "agoragentic-mcp@1.3.0", "--acp"],
                     "instructions": "Runs via npx: npx -y agoragentic-mcp@1.3.0 --acp" },
        "command": "npx",
        "args": ["-y", "agoragentic-mcp@1.3.0", "--acp"]
      }
    ]
  }
}
```

Status values:

- `ready`: custom, probe ok.
- `needs-probe`: custom, never probed.
- `probe-failed`: custom, probe failed. The `probe.error` field explains why.
- `available`: autodetect candidate on `PATH`. Not yet added.
- `not-added` / `added`: registry entry, and whether a custom agent references it.

For registry and autodetect rows, `command` and `args` are suggestions only. The
user reviews them and confirms through `POST /api/agents/custom`. Kory never runs
a suggestion on its own.

### `POST /api/agents/custom`

```json
{
  "label": "My Agent",
  "command": "/opt/agents/my-agent",
  "args": ["acp"],
  "env": { "MY_AGENT_TOKEN": "..." },
  "cwdPolicy": "workspace",
  "permissionProfile": "bridge-only",
  "registryId": "agoragentic-acp",
  "id": "my-agent",
  "probe": true
}
```

- `label`: required, at most 80 characters.
- `command`: a program name on `PATH`, or an absolute path. Relative paths are rejected.
- `id`: optional. Defaults to a slug of `label`.
- `probe`: defaults to `true`.

Responses:

- `200` with `data: { id, providerName, status, probe? }`.
- `409` if the id already exists.
- `422` with `error` for validation failures.

Adding an agent with a `command` that downloads on first run (for example
`npx`) will download it during the probe. That happens only because the user
added the command, but it is the one place a download can occur.

### `DELETE /api/agents/custom/:id`

Returns `{ ok: true }`, or `404` when the id is unknown.

### `POST /api/agents/:id/probe`

Re-runs the probe for a registered agent with its stored environment.

Returns `{ ok: true, data: <verdict> }`, or `404` when the id is not a registered
custom agent. The verdict is `{ ok, checkedAt, durationMs, protocolVersion?,
agentName?, agentVersion?, models, error? }`.

### Provider surface

- Provider name: `acp:<id>`.
- Model ids: the ids the agent offered in its model config option. When an agent
  offers no model option, the provider exposes one model, `default`, labelled
  "<label> (agent default)". That single model is a decision for review: it lets
  the agent be selected in a chain without inventing a catalog. A turn that
  requests a model the agent did not offer fails with an error. It never falls
  back silently.
- Trusted for routing once the user has added it, like a custom endpoint.

## Module map

| File | Role |
| --- | --- |
| `backend/src/providers/acp/protocol.ts` | ACP types, permission profiles, `session/update` mapping |
| `backend/src/providers/acp/client.ts` | Generic transport (`AcpClient`), shared by opencode and `acp:<id>` |
| `backend/src/providers/acp/agent-definitions.ts` | Validation, provider naming, probe projection |
| `backend/src/providers/acp/agent-store.ts` | `koryphaios.json` definitions, env secrets, verdicts |
| `backend/src/providers/acp/env.ts` | Default-deny child environment |
| `backend/src/providers/acp/probe.ts` | Capability probe |
| `backend/src/providers/acp/sources.ts` | Registry fetch and cache, PATH autodetect |
| `backend/src/providers/acp/provider.ts` | `AcpAgentProvider` (`acp:<id>`) |
| `backend/src/providers/acp/agent-service.ts` | List, add, remove and probe orchestration |
| `backend/src/providers/opencode-acp.ts` | Thin opencode wrapper over `AcpClient` |
| `backend/src/routes/v1/agents.ts` | `/api/agents` routes |

## Tests

- `backend/src/providers/__tests__/acp-agent-provider.test.ts`: handshake,
  streaming, permission veto, MCP bridge passing, model selection, probe verdicts
  (ok, protocol mismatch, missing command, hang, early exit), and env isolation.
  Uses a fake agent in `acp-fake-agent.ts`.
- `backend/src/providers/__tests__/acp-agent-registry.test.ts`: registry fetch
  failures (network error, redirect, foreign host, timeout, non-JSON, empty,
  cache and negative cache), PATH autodetect, validation, store, and the service
  lifecycle.
- `backend/src/providers/__tests__/acp-registry-integration.test.ts`: the
  provider registry dispatches `acp:<id>`, restores persisted agents, and keeps
  unprobed agents unavailable.

Run with `KORY_DISABLE_CLI_AUTODETECT=1 KORY_DISABLE_PROVIDER_AUTODETECT=1 bun run scripts/test-backend-isolated.ts --file <path>`.

## Known gaps

- The argument sets for PATH-autodetected agents are unverified. The probe is the
  only verdict. Verify each one against its real CLI before relying on it.
- The registry entry schema is taken from the published index and the schema
  link. It has not been checked against every registry entry.
- The route handlers have no dedicated HTTP tests. They are covered by typecheck
  and by the service tests they call.
- The sandboxed turn path uses the same jail as opencode, but it has not been run
  against a live agent in this change.
- No frontend UI is included. The API contract above is what the UI should call.
