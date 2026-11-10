# Koryphaios admin CLI

`koryphaios` manages running Koryphaios instances from a terminal. It is an
administrative interface for headless setup, pairing, and configuration. All
changes go through the same authenticated APIs as Settings and are visible in
the app. It does not generate code or accept coding prompts.

## Run or install

From a source checkout:

```bash
bun run koryphaios --help
bun run koryphaios --port 3001 status
```

For a local `koryphaios` command, run `bun link` in the checkout, with Bun's bin
directory on your PATH. The remote-instance installer builds a standalone
`/usr/local/bin/koryphaios` binary, so VPS operators do not need Bun on their
PATH or access to the service user's source directory.

The CLI discovers one healthy backend on ports 3001/3000. If more than one is
running, choose explicitly using `--port`. `--url` accepts a loopback HTTP origin
only; reach a remote backend through SSH instead of exposing its API:

```bash
ssh -N -L 18001:127.0.0.1:3001 user@vps.example.com
koryphaios --port 18001 status
```

`--json` emits compact JSON for scripts. Commands return nonzero on failure.
The local API session is created per invocation and revoked afterward. No
authentication token or device private key appears in command output.

## Pair both sides entirely with commands

Both instances must use the same relay. Each stores its own relay URL (for an
SSH-tunnel relay, their loopback ports may differ):

```bash
# Desktop
koryphaios --port 3001 config set device.relay https://relay.example.com

# VPS (over SSH)
koryphaios --port 3001 config set device.relay https://relay.example.com
```

Then:

```bash
# VPS creates an expiring code
koryphaios --port 3001 devices invite

# Desktop enters the VPS code and prints its verification check and device ID
koryphaios --port 3001 devices pair XXXXX-XXXXX-XXXXX-XXXXX

# VPS prints the requesting desktop's ID and check
koryphaios --port 3001 devices pending

# Compare both checks, then approve from the VPS terminal
koryphaios --port 3001 devices approve <desktop-device-id> --check "123 456"

# Confirm the link from both terminals
koryphaios --port 3001 devices list
```

Approval checks the supplied digits against the current unexpired request. It
does not require a GUI. `devices decline <id>` refuses a request, `devices
cancel` retires the local invite, and `devices unlink <id>` revokes a link.

Agent delegation is a separate, explicitly enabled grant:

```bash
# On the source, allow its managers to route to the target
koryphaios devices grants <target-id> --outgoing on

# On the target, allow managers from that source
koryphaios devices grants <source-id> --incoming on
```

Omitted directions retain their previous setting. Both begin off. To verify
the transport without generating a response:

```bash
koryphaios devices workspaces <peer-id>
```

## Configuration and diagnostics

```bash
koryphaios doctor
koryphaios config show
koryphaios config get device.relay
koryphaios config set device.name "Build server"
koryphaios config set agent.permissionMode guarded
koryphaios --project /srv/project config set agent.criticMode auto
koryphaios workspace status
koryphaios workspace open /srv/workspaces
koryphaios workspace select /srv/workspaces/my-project
koryphaios providers list
koryphaios providers refresh openai
```

Agent setting keys and values are listed by `--help`. Only supported non-secret
settings are accepted. Provider refresh is a connection/catalog probe, with
generation disabled. Provider credentials remain managed by their existing
configuration/login surfaces. Workspace paths are interpreted by the receiving
instance; a path sent through a tunnel must use the remote machine's OS syntax.

`config set device.relay ""` disables linking while retaining the identity and
peer grants. A saved relay override persists across backend restarts and takes
precedence over `RELAY_URL`; it affects device transport only, not the legacy
team-session relay.

## Run headlessly

With the source runtime and Bun installed:

```bash
koryphaios serve --data-dir /srv/kory-data \
  --runtime-dir /opt/koryphaios --port 3001 \
  --relay https://relay.example.com --workspace /srv/workspaces
```

This starts the normal backend in the foreground, bound to loopback, with its
own persistent data directory. SIGINT/SIGTERM are forwarded to it. Use `--bun`
when Bun is not on PATH. Provider credentials and other backend environment
variables retain their normal meanings. The VPS installer's systemd service
remains the managed startup path; the CLI works with that running service.

## Verification

The CLI is covered by command/authentication tests, including mismatch rejection,
grant direction preservation, validated settings, secret-free output, error cleanup,
and non-generating provider probes. A live headless `serve` startup was verified in
an isolated data directory and shut down cleanly. The real macOS desktop and Linux
VPS were paired using `devices invite`, `pair`, `pending`, and `approve`; workspace
discovery succeeded in both directions. This is transport/admin verification,
independent of model generation.
