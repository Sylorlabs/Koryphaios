<script lang="ts">
  import { onMount } from 'svelte';
  import Monitor from 'lucide-svelte/icons/monitor';
  import Smartphone from 'lucide-svelte/icons/smartphone';
  import Link from 'lucide-svelte/icons/link';
  import Copy from 'lucide-svelte/icons/copy';
  import Check from 'lucide-svelte/icons/check';
  import Download from 'lucide-svelte/icons/download';
  import QrCode from 'lucide-svelte/icons/qr-code';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import { deviceStore } from '$lib/stores/devices.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import { copyText } from '$lib/utils/clipboard';
  let name = $state('');
  let code = $state('');
  let relayUrl = $state('');
  let mode = $state<'mobile' | 'desktop'>('mobile');
  let invitation = $state<{ code: string; qrUrl: string; expiresAt: number } | null>(null);
  let qr = $state('');
  let showQr = $state(false);
  let copied = $state('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let pairing = $state<{ identity: { name: string; id: string }; check: string } | null>(null);
  let busy = $state(false);
  let error = $state('');
  let now = $state(Date.now());
  const status = $derived(deviceStore.status);
  const remaining = $derived(
    invitation ? Math.max(0, Math.ceil((invitation.expiresAt - now) / 1000)) : 0,
  );
  const mobileAvailable = $derived(!!status?.relayUrl?.startsWith('https://'));
  async function act(task: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await task();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not complete device action';
    } finally {
      busy = false;
    }
  }
  async function invite() {
    await act(async () => {
      invitation = await deviceStore.invite();
      qr = '';
      showQr = false;
    });
  }
  async function copy(value: string, key: string) {
    try {
      await copyText(value);
      copied = key;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = ''), 2000);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not copy';
    }
  }
  async function toggleQr() {
    if (showQr) {
      showQr = false;
      return;
    }
    await act(async () => {
      if (!invitation || invitation.expiresAt <= Date.now()) {
        invitation = await deviceStore.invite();
        now = Date.now();
        qr = '';
      }
      const current = invitation!;
      const QRCode = await import('qrcode');
      const image = await QRCode.toDataURL(current.qrUrl, {
        width: 248,
        margin: 4,
        errorCorrectionLevel: 'H',
      });
      if (invitation === current && current.expiresAt > Date.now()) {
        qr = image;
        showQr = true;
      }
    });
  }
  function saveQr() {
    if (!qr || !invitation || !remaining) return;
    const anchor = document.createElement('a');
    anchor.href = qr;
    anchor.download = 'koryphaios-device-pairing.png';
    anchor.click();
  }
  onMount(() => {
    void deviceStore.load().then(() => {
      name = deviceStore.status?.local?.name ?? '';
      relayUrl = deviceStore.status?.relayUrl ?? '';
    });
    const timer = setInterval(() => {
      now = Date.now();
      void deviceStore.load();
    }, 3000);
    return () => {
      clearInterval(timer);
      clearTimeout(copyTimer);
    };
  });
</script>

<section class="link-device" aria-labelledby="link-device-title">
  <header>
    <span class="eyebrow">YOUR DEVICE NETWORK</span>
    <h2 id="link-device-title">Link device</h2>
    <p>
      Start here to connect your phone or another desktop. Your work stays on the device you choose.
    </p>
  </header>
  <div class="local-device">
    <div class="device-heading">
      <Monitor size={22} />
      <div>
        <strong>{status?.local?.name ?? 'This desktop'}</strong><span
          >{status?.local?.os ?? 'Loading device…'} · This device</span
        >
      </div>
      <span class="badge">You are here</span>
    </div>
    <SettingsSwitch
      compact
      checked={status?.accountWideDeviceAccess !== false}
      label="Access all activated devices"
      description="After a device is paired and approved, you can use it and the other desktops linked through this device. This is local and account-optional; it does not trust unknown devices."
      onchange={() =>
        act(() =>
          deviceStore.configureAccountWideDeviceAccess(
            !(status?.accountWideDeviceAccess !== false),
          ),
        )}
    />
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void act(() => deviceStore.rename(name));
      }}
    >
      <label for="device-name">Desktop name</label>
      <div class="input-row">
        <input
          id="device-name"
          bind:value={name}
          maxlength="80"
          placeholder={status?.osName ?? 'Device name'}
        /><button class="secondary" disabled={busy || !name.trim() || name === status?.local?.name}
          >Save</button
        >
      </div>
      <p class="hint">
        OS name: {status?.osName ?? '…'}. This name appears on your linked devices and new chats.
      </p>
    </form>
  </div>
  <div class="pairing-card">
    <div class="tabs" role="tablist" aria-label="Device to link">
      <button role="tab" aria-selected={mode === 'mobile'} onclick={() => (mode = 'mobile')}
        ><Smartphone size={16} /> Phone or tablet</button
      >
      <button role="tab" aria-selected={mode === 'desktop'} onclick={() => (mode = 'desktop')}
        ><Monitor size={16} /> Another desktop</button
      >
    </div>
    <h3>
      {mode === 'mobile' ? 'Steer your desktops from your phone' : 'Connect desktop to desktop'}
    </h3>
    <p>
      {mode === 'mobile'
        ? 'Scan the QR code with your phone’s camera to open the installed Koryphaios Mobile app.'
        : 'Open Link device on the other desktop and enter this device’s code. No address or port to share.'}
    </p>
    {#if invitation && remaining > 0}
      {#if mode === 'mobile'}
        <div class="qr-option">
          <div>
            <strong>Pair with your camera</strong>
            <p>Opens Koryphaios Mobile with this desktop’s one-time pairing code.</p>
          </div>
          <button
            class="secondary"
            disabled={busy}
            aria-expanded={showQr}
            onclick={() => void toggleQr()}
            ><QrCode size={16} />{showQr
              ? 'Hide QR code'
              : qr
                ? 'Show QR code'
                : 'Generate QR code'}</button
          >
        </div>
        {#if showQr && qr}
          <div class="qr-panel">
            <div class="qr-heading">
              <QrCode size={18} />
              <div>
                <strong>Koryphaios · Link device</strong><span
                  >{status?.local?.name ?? 'This desktop'}</span
                >
              </div>
            </div>
            <img
              class="qr"
              src={qr}
              alt="Scan to link this desktop to your phone or tablet"
              width="248"
              height="248"
            />
            <p>
              Open in Koryphaios Mobile, tap Link desktop, then compare the numbers on both screens.
            </p>
            <div class="actions">
              <button class="secondary" onclick={() => void copy(invitation!.qrUrl, 'phone-link')}
                >{#if copied === 'phone-link'}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy
                  app pairing link{/if}</button
              >
              <button class="secondary" onclick={saveQr}
                ><Download size={14} /> Save QR image</button
              >
            </div>
          </div>
        {/if}
      {/if}
      <div class="invite-layout">
        <div class="code-block">
          <span>One-time device code</span>
          <div class="copy-row">
            <code>{invitation.code}</code><button
              class="icon-button"
              aria-label="Copy pairing code"
              onclick={() => void copy(invitation!.code, 'invite')}
              >{#if copied === 'invite'}<Check size={16} />{:else}<Copy size={16} />{/if}</button
            >
          </div>
          <span
            >Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span
          >
          <div class="actions">
            <button class="secondary" onclick={() => void copy(invitation!.code, 'invite')}
              >{#if copied === 'invite'}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy code{/if}</button
            ><button
              class="text-button"
              onclick={() =>
                void act(async () => {
                  await deviceStore.stopInvite();
                  invitation = null;
                  qr = '';
                  showQr = false;
                })}>Cancel pairing</button
            >
          </div>
        </div>
      </div>
    {:else}
      <div class="actions">
        {#if mode === 'mobile'}<button
            class="primary"
            disabled={busy}
            onclick={() => void toggleQr()}
            >{#if busy}<LoaderCircle size={15} class="animate-spin" />{:else}<QrCode
                size={15}
              />{/if} Generate QR code</button
          >{/if}
        <button class={mode === 'mobile' ? 'secondary' : 'primary'} disabled={busy} onclick={invite}
          >{#if busy}<LoaderCircle size={15} class="animate-spin" />{:else}<Link size={15} />{/if} Create
          pairing code</button
        >
      </div>
      {#if invitation}<p class="hint">That code expired. Create a new one to continue.</p>{/if}
    {/if}
    {#if mode === 'mobile' && !mobileAvailable}<div class="relay-setup">
        <h3>Connect your phone to the relay</h3>
        <p>
          For the mobile app to connect, use an HTTPS relay reachable from your phone’s network. A
          localhost relay only connects on this computer.
        </p>
        <form
          class="input-row"
          onsubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await deviceStore.configureRelay(relayUrl.trim());
              invitation = null;
              qr = '';
              showQr = false;
            });
          }}
        >
          <input
            type="url"
            aria-label="Device relay URL"
            placeholder="https://relay.example.com"
            pattern="https://.*"
            required
            bind:value={relayUrl}
          />
          <button class="secondary" disabled={busy || !relayUrl.trim().startsWith('https://')}
            >Connect relay</button
          >
        </form>
      </div>{/if}
    <div class="manual-link">
      <h3>Have a code from another desktop?</h3>
      <form
        class="input-row"
        onsubmit={(event) => {
          event.preventDefault();
          void act(async () => (pairing = await deviceStore.pair(code)));
        }}
      >
        <input
          aria-label="Device pairing code"
          bind:value={code}
          maxlength="30"
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
        /><button class="secondary" disabled={busy || code.replace(/[\s-]/g, '').length !== 20}
          >Connect</button
        >
      </form>
    </div>
    {#if pairing}<div class="verification">
        <strong>Check both screens</strong>
        <div class="copy-row">
          <code>{pairing.check}</code><button
            class="secondary"
            onclick={() => void copy(pairing!.check, 'check')}
            >{#if copied === 'check'}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy numbers{/if}</button
          >
        </div>
        <p>
          Confirm that {pairing.identity.name} shows these same numbers, then approve the request on that
          desktop.
        </p>
        {#if status?.peers.some((p) => p.id === pairing!.identity.id)}<strong class="success"
            >Device linked</strong
          >{/if}
      </div>{/if}
  </div>
  {#each status?.requests ?? [] as request (request.id)}
    <div class="verification">
      <h3>{request.identity.name} wants to link</h3>
      <span>{request.identity.os} · {request.identity.kind}</span>
      <div class="copy-row">
        <code>{request.check}</code><button
          class="secondary"
          onclick={() => void copy(request.check, request.id)}
          >{#if copied === request.id}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy numbers{/if}</button
        >
      </div>
      <p>
        Approve only when these numbers match on the other device. Linking a mobile controller lets
        it steer this desktop and your linked desktops.
      </p>
      <div class="input-row">
        <button
          class="primary"
          disabled={busy}
          onclick={() => void act(() => deviceStore.decide(request.id, true))}
          >Numbers match · Link</button
        ><button
          class="secondary"
          disabled={busy}
          onclick={() => void act(() => deviceStore.decide(request.id, false))}>Decline</button
        >
      </div>
    </div>
  {/each}
  <section class="linked">
    <h3>Linked devices <span class="count">{status?.peers.length ?? 0}</span></h3>
    {#if !status?.peers.length}<p class="empty">No linked devices yet.</p>{/if}
    {#each status?.peers ?? [] as peer (peer.id)}
      <article class="peer">
        <div class="device-heading">
          {#if peer.kind === 'mobile'}<Smartphone size={20} />{:else}<Monitor size={20} />{/if}
          <div>
            <strong>{peer.name}</strong><span
              >{peer.os} · {peer.online ? 'Connected' : 'Offline'}</span
            >
          </div>
          <button
            class="text-button"
            disabled={busy}
            onclick={() => void act(() => deviceStore.unlink(peer.id))}>Unlink</button
          >
        </div>
        {#if peer.kind === 'desktop'}<SettingsSwitch
            flat
            compact
            checked={peer.agentRouting}
            label={`Let agents on this desktop use ${peer.name}`}
            description="Outbound delegation only. Agents running here may discover workspaces and delegate work to this linked desktop. Off by default."
            onchange={() =>
              act(() => deviceStore.grants(peer.id, peer.allowAgents, !peer.agentRouting))}
          /><SettingsSwitch
            flat
            compact
            checked={peer.allowAgents}
            label={`Accept agents from ${peer.name} on this desktop`}
            description="Inbound delegation only. Agents running on the linked desktop may request work here. Off by default; user control remains available."
            onchange={() =>
              act(() => deviceStore.grants(peer.id, !peer.allowAgents, peer.agentRouting))}
          />{/if}
      </article>
    {/each}
  </section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status?.error && !status.connected}<p class="error" role="status">{status.error}</p>{/if}
</section>

<style>
  .link-device {
    max-width: 760px;
    margin: 0 auto;
    padding: 28px;
    display: grid;
    gap: 24px;
    color: var(--color-text-primary);
  }
  .eyebrow {
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--color-accent);
    font-weight: 700;
  }
  h2 {
    font-size: 25px;
    font-weight: 650;
    margin: 8px 0;
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  p {
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-text-muted);
    margin: 6px 0 16px;
  }
  .local-device,
  .pairing-card,
  .peer {
    padding: 20px;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .pairing-card {
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  }
  .device-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
    min-width: 0;
  }
  .device-heading > div {
    display: grid;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .device-heading strong {
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .device-heading span {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .badge {
    padding: 5px 8px;
    border-radius: 8px;
    background: var(--color-surface-3);
    white-space: nowrap;
  }
  label {
    display: block;
    font-size: 11px;
    color: var(--color-text-secondary);
    margin-bottom: 7px;
  }
  .input-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  input {
    min-width: 0;
    flex: 1;
    width: 100%;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: 9px;
    padding: 10px 12px;
    color: var(--color-text-primary);
    font-size: 13px;
  }
  input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 9px;
    padding: 10px 13px;
    cursor: pointer;
    white-space: nowrap;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 3px;
  }
  .primary {
    background: var(--color-accent);
    color: var(--color-text-on-accent);
    border: 1px solid transparent;
  }
  .secondary {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
  }
  .text-button {
    color: var(--color-text-muted);
    background: transparent;
    padding: 6px;
    border: 0;
  }
  .hint {
    font-size: 11px;
    margin: 8px 0 0;
  }
  .tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 20px;
    padding: 4px;
    background: var(--color-surface-1);
    border-radius: 10px;
  }
  .tabs button {
    flex: 1;
    background: transparent;
    color: var(--color-text-muted);
    border: 0;
  }
  .tabs button[aria-selected='true'] {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .invite-layout {
    display: flex;
    gap: 24px;
    align-items: center;
    margin: 24px 0 0;
  }
  .qr {
    border-radius: 12px;
    flex-shrink: 0;
  }
  .code-block {
    display: grid;
    gap: 12px;
    width: 100%;
    min-width: 0;
  }
  .code-block code {
    font-size: 17px;
    letter-spacing: 0.04em;
    overflow-wrap: anywhere;
  }
  .code-block span {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .manual-link {
    border-top: 1px solid var(--color-border);
    padding-top: 26px;
    margin-top: 30px;
  }
  .relay-setup {
    margin-top: 24px;
    padding: 16px;
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 12%, transparent);
    border-radius: 0;
    background: transparent;
  }
  .manual-link h3 {
    margin-bottom: 14px;
  }
  .copy-row,
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .copy-row {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .actions {
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .icon-button {
    padding: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .qr-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    padding: 16px;
    margin-top: 24px;
    border: 0;
    border-radius: 0;
    background: var(--color-surface-1);
  }
  .qr-option strong {
    font-size: 12px;
  }
  .qr-option p {
    font-size: 11px;
    margin: 6px 0 0;
  }
  .qr-panel {
    display: grid;
    justify-items: center;
    gap: 16px;
    padding: 22px;
    margin-top: 16px;
    background: var(--color-surface-1);
    border: 0;
    border-radius: 12px;
  }
  .qr-panel p {
    margin: 0;
    text-align: center;
    max-width: 320px;
    font-size: 12px;
  }
  .qr {
    max-width: 100%;
    height: auto;
  }
  .qr-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-accent);
  }
  .qr-heading div {
    display: grid;
    gap: 4px;
  }
  .qr-heading strong {
    font-size: 12px;
  }
  .qr-heading span {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .qr-panel .actions {
    justify-content: center;
  }
  .verification code {
    display: block;
    font-size: 28px;
    letter-spacing: 0.15em;
    margin: 14px 0;
  }
  .verification {
    padding: 24px;
    border: 1px solid var(--color-accent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface-2));
  }
  .pairing-card > .verification {
    margin-top: 24px;
  }
  .verification p:last-child {
    margin-bottom: 0;
  }
  .verification > .input-row {
    margin-top: 18px;
  }
  .verification .copy-row {
    margin: 6px 0;
  }
  .verification .copy-row code {
    margin: 12px 0;
  }
  .linked {
    display: grid;
    gap: 12px;
  }
  .count {
    font-size: 11px;
    color: var(--color-text-muted);
    margin-left: 6px;
  }
  .empty {
    padding: 18px;
    margin: 0;
    border: 1px dashed var(--color-border);
    border-radius: 12px;
  }
  .peer .device-heading {
    margin-bottom: 4px;
  }
  .success {
    color: var(--color-success);
  }
  .error {
    color: var(--color-error);
    font-size: 12px;
  }
  @media (max-width: 600px) {
    .link-device {
      padding: 18px;
      gap: 18px;
    }
    .invite-layout {
      flex-direction: column;
      align-items: flex-start;
    }
    .input-row {
      flex-wrap: wrap;
    }
    .input-row input {
      flex-basis: 100%;
    }
    .tabs button {
      padding: 9px 6px;
      font-size: 11px;
    }
    .badge {
      display: none;
    }
  }
</style>
