# Headless remote Koryphaios instance

For instance-wide desktop/phone linking and the big **+** desktop/workspace
chooser, see [Linked devices](linked-devices.md). Its host-confirmed device
codes and controls are independent of the legacy hosted-chat flow below.

Koryphaios can run a second instance on a VPS and control it from the desktop
app through the existing collaboration relay. The VPS backend binds to
loopback; it makes an outbound WebSocket connection to the relay and does not
need an exposed Koryphaios HTTP port.

## Prerequisites

- A relay deployed from [`relay/deploy.sh`](../relay/deploy.sh).
- Root SSH access to a Debian, Ubuntu, or Arch Linux VPS.
- `RELAY_URL` and the relay's `RELAY_HOST_SECRET`.
- The desktop backend configured with the same `RELAY_URL`.

Deploy from this checkout:

```bash
RELAY_URL=https://relay.example.com \
RELAY_HOST_SECRET='relay-secret' \
./scripts/deploy-remote-instance.sh root@vps.example.com
```

The installer creates a dedicated `koryphaios` service user, installs Bun,
installs this repository, overlays a matching backend/shared runtime and
dependency manifests from this checkout,
creates an isolated Git workspace, and starts
`koryphaios-remote.service`. Provider credentials remain on the VPS. For example,
add `OPENAI_API_KEY="..."` to `/etc/koryphaios-remote.env` using a root editor,
then restart the service. For a supported CLI, install and log in under the
service user's home, `/var/lib/koryphaios`. Existing environment files are
preserved on reinstallation.

The join code is stored in the service-user-owned, owner-only state file shown at the end
of deployment:

```bash
ssh root@vps.example.com \
  'sudo cat /var/lib/koryphaios/data/remote-control.json'
```

The file contains a bearer join code. Treat it like a password and rotate it
by restarting the service. The chat and its isolated checkout survive; the
relay session and code are recreated after backend restart. A relay outage
leaves `joinCode: null` rather than advertising a stale code.

## Connect from the desktop app

1. Open **Settings → Team access**.
2. Enter the eight-character `joinCode` from the VPS state file.
3. Join the displayed **Remote Koryphaios** session.
4. Select the joined session in the sidebar and send prompts.

The headless profile uses the existing explicit `yolo` collaboration tier and
auto-admits the join and sets that chat's tool approval preset to YOLO because
there is no VPS desktop operator available to approve each prompt. Kory's
mandatory command-approval floor and workspace confinement still apply. This
mode is opt-in through
`KORYPHAIOS_REMOTE_CONTROL=true`; ordinary desktop and relay hosts are
unchanged.

Useful VPS checks:

```bash
sudo systemctl status koryphaios-remote
sudo journalctl -u koryphaios-remote -f
```

## VPS testing without a public relay domain

Set `KORYPHAIOS_INSTALL_RELAY=true` when deploying to also install a loopback-only
relay on the VPS. Its secrets are generated there and remain in root-owned
environment files. From your desktop, keep this tunnel running:

```bash
ssh -N -L 18080:127.0.0.1:8080 user@vps.example.com
```

Set the **desktop backend's** `RELAY_URL=http://127.0.0.1:18080`, restart it, and
join using the VPS code. Consuming a hosted session requires no local host
secret. The VPS needs a configured model provider before it can answer prompts.
This tunnel uses the relay's loopback testing transport; internet deployment
uses an HTTPS/WSS relay.

This control surface operates one hosted chat, with its tools running in a
durable isolated checkout on the VPS. It does not expose an instance-wide
administration dashboard. Re-running the installer preserves an existing
source checkout and overlays the current runtime; `KORYPHAIOS_REPO_REF` selects
the branch/tag for a fresh installation.

Assistant replies and agent status are forwarded to the joined session.
Interactive questions, mandatory approvals, cancellation, and change-review
actions still require the host's normal control surface; they are not exposed
by the relay guest view in this first version.
