# Linked devices

Open **Settings → Link device**, or use the final onboarding step. A desktop starts with
its OS hostname; edit **Desktop name** to give it a recognizable name.

## Pair a desktop or phone

Both desktops use the same HTTPS `RELAY_URL`. The relay is deployment
configuration; pairing users enter only a code, never a desktop address or port.

1. On the hosting desktop, create a pairing code in **Link device**, or choose
   **Phone or tablet → Generate QR code** to create both the code and QR at once.
2. On another desktop, enter that code in **Link device**. On a phone, install
   **Koryphaios Mobile**, scan the QR with your camera, then tap **Link desktop**
   inside the app. You can also paste **Copy app pairing link** into the app's
   **Machines → Link desktop with QR code** screen.
3. Compare the six-digit check on both screens and approve on the host.

Codes expire after ten minutes and are retired when approved or cancelled.
Pairing is separate from the legacy eight-character Team access session codes.
A linked phone can control its paired desktops and desktops linked to them.
The mobile app retains its device identity and desktop links in SecureStore.
**Unlink** removes the local authorization immediately, including
when the other device is offline.

**Access all activated devices** is enabled by default on each desktop. It is
an account-optional local device-network preference: once a device has been
paired and host-approved, the user can reach the other approved desktops
linked through that device. It does not auto-pair unknown machines, require a
hosted Koryphaios account, or replace the verification check. Turning it off
blocks user RPC access from that desktop across its linked-device network;
pairing records and agent grants remain separate.

## Start and control chats

Installed desktops use a [background login service](desktop-background-service.md)
so agents remain available with the window closed. Choose **Run in background**
when closing; **Quit anyway** stops them for this session. Open the updated
installation once to register it; keep the computer on, awake, signed in, and
network-connected.

The sidebar's big **+** opens the desktop/workspace chooser. Select a desktop,
then one of the workspaces or project folders returned by that desktop. The
chat stays on that device. Recent remote chats appear under **Micah’s agents**,
with a computer icon and the selected desktop and workspace shown in the chat.
Every new chat requires a folder. **Choose a local folder** browses the selected
desktop's filesystem, including linked desktops, without opening a picker on
the wrong computer. Navigate into a project folder and choose **New chat in…**.

Linked desktop chats use the normal feed, composer, model picker, agent rail,
chat Git controls, and target-owned background shells. Prompts, streaming
replies, stop, interactive answers, and keep/reject reviews travel to the target.
Each target retains its permissions and filesystem. Paths are display-only: operations use opaque
workspace IDs resolved by the target's own OS. Workspace lists include its open
workspace/project, explicitly configured `KORYPHAIOS_REMOTE_WORKSPACE`, and
folders explicitly chosen for chats. User-only folder browsing uses temporary,
peer-bound handles; browsing alone does not add folders to the shared list.

## Desktop providers running on the target

An authenticated desktop send can stage its **Antigravity** login and enabled
**custom API providers** through the encrypted device connection. Provider
adapters and native CLI processes run on the receiving computer, against that
chat's target-owned checkout; tool calls pass through its normal Kory permission
policy. Other native CLI login formats are not yet supported by this staging path.

API keys and custom headers remain in the target's per-session execution scope;
they are not saved as permanent target provider settings. Antigravity uses a
private temporary home and owner-only OAuth token file, removed when its bounded
run lease ends, is stopped, or its link is revoked. A short post-turn lease also
covers automatically scheduled compaction. Waiting for a human answer retains
the same scope, subject to the 30-minute run limit.

Install the qualified Linux Antigravity CLI on the target before using it:

```bash
bun scripts/install-antigravity-runtime.ts
```

The installer verifies the pinned official `agy` 1.2.17 archive before installing
it. Linked attachments preserve the normal image-input and plan/act controls;
their combined encoded data must fit within 600 KB per message.

Instance administration, device linking, credentials, and global provider
settings stay on the controlling desktop. The target workbench exposes scoped
chat, agent, Git, project, and process routes; Notes, Goals, and checklists do not
yet have a linked-desktop workbench contract.

## Agent delegation

Both per-peer switches start off:

- **Let agents on this desktop use _that_ desktop** enables outbound routing on
  the source. This controls what agents running here may do elsewhere.
- **Accept agents from _that_ desktop on this desktop** enables incoming agent
  requests on the target. This controls what agents running elsewhere may do
  here.

They are intentionally separate permissions. Enabling one does not enable the
other, and ordinary user control does not require either switch.

Session managers use `list_linked_devices` and `control_linked_device` (native
CLI bridge aliases: `kory__list_linked_devices`, `kory__control_linked_device`).
Workers cannot use these tools. Plan interaction mode cannot create chats, submit tasks, or
cancel work. Agents cannot pair devices, change grants, forward through a
mobile gateway, answer permission questions, or approve change reviews.

## Headless VPS pairing

Use the built-in [Koryphaios admin CLI](cli.md) to pair, approve, rename, and
configure instances entirely through commands. The VPS installer provides
`koryphaios` on PATH. The original helper below remains compatible.

The loopback backend has a local operator CLI. Run from the installation:

```bash
KORYPHAIOS_PORT=3001 bun scripts/link-device.ts invite
KORYPHAIOS_PORT=3001 bun scripts/link-device.ts status
KORYPHAIOS_PORT=3001 bun scripts/link-device.ts approve <pending-device-id> "123 456"
```

Enter the generated code on the desktop, read the pending check with `status`,
compare it with that desktop's check, then approve. Use `cancel` to retire the
invite or `decline <pending-device-id>` to refuse a request. The CLI creates a
short-lived local API session and revokes it after use; it does not print local
API tokens or device private keys.

## Transport and storage

Desktops make outbound WSS connections; no inbound desktop ports are needed.
P-256 identities sign messages; ECDH/HKDF derives AES-GCM encryption keys. The
relay routes ciphertext and holds public identities, online connections, and
hashed invitation lookups. Pairing binds both identities with a nonce
commit/reveal exchange and a human-compared check. Message signatures,
timestamps, an in-process replay cache, and persisted mutating-command claims
protect delivery. Relay request/frame/byte limits bound resource use.

The QR payload is an app-only deep link:

```text
koryphaios://link-device?v=1&relay=<encoded-relay-url>&code=<one-time-code>&host=<desktop-key-id>
```

`shared/src/device-pairing-link.ts` owns link creation and validation. The mobile
app in `../koryphaios-mobile` uses the same shared device client with native
P-256/SHA-256/HKDF/AES-GCM primitives and pins the desktop identity from the QR.
It does not open a browser or request an HTTP API session to pair. Its scheme is
registered in `app.json`, and `src/app/link-device.tsx` handles cold and warm
app launches through Expo Router. The installed native build is required.

Desktop identities and grants live in
`<KORYPHAIOS_DATA_DIR>/.koryphaios/linked-devices.json` (owner-only directory and
file on POSIX). Protect this state as credentials. Long-term key encryption
does not provide forward secrecy: compromise of a device's private key can
expose recorded traffic involving that identity. Mobile app private keys are
stored using the phone's Keychain/Keystore through Expo SecureStore.

Loopback HTTP is supported for SSH-tunnel testing. A real phone requires an
HTTPS relay URL reachable from its network. The relay deployment includes
`relay/devices.ts`, `relay/mobile.ts`, `relay/mobile-client.ts`, and the shared
device modules; copying only `relay/server.ts` is insufficient.
The mobile pairing panel lets you configure that HTTPS relay when the current
relay is missing or loopback-only. A QR generated for a loopback relay opens the
app, but cannot connect to that relay from a separate phone.

## Verified scope

Automated coverage exercises cryptographic tampering and expiry, explicit
pairing consent and invite cancellation, replay and restart deduplication,
revocation, directional agent grants, worker/plan restrictions, mobile gateway
response delivery, target-owned workspace IDs, and cross-device chooser races.
A live macOS-to-Linux VPS check also exercised the installed backend's pairing,
workspace discovery, chat creation, prompt submission, status/error delivery,
and default-denied agent access. A live macOS-to-Linux check ran both Antigravity
and a selected custom API provider, used the target terminal to return `Linux`
and its target checkout path, and reached the canonical `done` phase.
`scripts/verify-linked-workbench.ts <provider>` repeats this bounded read-only
check using an existing desktop link. Browser coverage verifies the shared feed,
composer, and target-routed send/stop controls with deterministic transport fixtures.
Native-mobile cryptography and the full QR → relay → six-digit check → desktop
approval → encrypted RPC flow have automated cross-client coverage in
`../koryphaios-mobile/tests/native-device-pairing.test.js`. Physical phone camera
launch and real Windows filesystem behavior require testing on those devices.
