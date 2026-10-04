<script lang="ts">
  import {
    COMPUTER_CAPABILITIES,
    COMPUTER_TIERS,
    COMPUTER_ROLES,
    type ComputerUseSettings,
    type ComputerCapability,
    type ComputerPermission,
    type ComputerTier,
    type ComputerRole,
    type ComputerPlatformStatus,
    type ComputerTarget,
  } from '@koryphaios/shared';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import KorySelect from './KorySelect.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import Monitor from 'lucide-svelte/icons/monitor';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';

  interface Props {
    settings: ComputerUseSettings;
    saving?: boolean;
    onchange: (settings: ComputerUseSettings) => Promise<unknown>;
    onstopped?: () => Promise<void>;
  }
  let { settings, saving = false, onchange, onstopped }: Props = $props();
  let expanded = $state(false);
  let tier = $state<ComputerTier>('guarded');
  let role = $state<ComputerRole>('worker');
  let status = $state<ComputerPlatformStatus | null>(null);
  let targets = $state<ComputerTarget[]>([]);
  let discovered = $state(false);
  let checking = $state(false);
  let discovering = $state(false);
  let stopping = $state(false);
  let error = $state('');
  let notice = $state('');

  const names: Record<ComputerCapability, string> = {
    discover: 'Discover apps',
    observe: 'Observe windows',
    interact: 'Click, type, keys & scroll',
    manageWindows: 'Focus windows',
    clipboardRead: 'Read clipboard',
    clipboardWrite: 'Write clipboard',
    transfer: 'Transfer files',
    sensitive: 'Sensitive actions',
  };
  const descriptions: Record<ComputerCapability, string> = {
    discover: 'List running app and window identities; no automatic scanning.',
    observe:
      'Capture an authorized window. Its content may be sent to the selected model provider.',
    interact: 'Send input to an authorized window; this can submit forms or run commands.',
    manageWindows: 'Bring an authorized window to the foreground.',
    clipboardRead: 'Reserved: no clipboard-read tool is implemented.',
    clipboardWrite: 'Reserved: no clipboard-write tool is implemented.',
    transfer: 'Reserved: no file-transfer tool is implemented.',
    sensitive: 'Reserved: no dedicated sensitive-action tool is implemented.',
  };
  const tierNames: Record<ComputerTier, string> = {
    plan: 'Plan',
    ask: 'Ask',
    edits: 'Accept edits',
    guarded: 'Guarded',
    yolo: 'YOLO',
    custom: 'Custom',
  };
  const roleNames: Record<ComputerRole, string> = {
    manager: 'Manager',
    worker: 'Worker',
    critic: 'Critic',
  };
  const permissions = [
    { value: 'allow', label: 'Allow' },
    { value: 'ask', label: 'Ask each action' },
    { value: 'block', label: 'Block' },
  ];
  const reserved = (capability: ComputerCapability) =>
    ['clipboardRead', 'clipboardWrite', 'transfer', 'sensitive'].includes(capability);
  const readOnlyBlocked = (capability: ComputerCapability) =>
    capability !== 'discover' && capability !== 'observe';
  const unavailable = (capability: ComputerCapability) =>
    reserved(capability) || (status !== null && !status.capabilities.includes(capability));
  const discoveredApps = $derived(
    targets.filter(
      (target, index, all) => all.findIndex((item) => item.appId === target.appId) === index,
    ),
  );

  function setTier(capability: ComputerCapability, value: string) {
    return onchange({
      ...settings,
      byTier: {
        ...settings.byTier,
        [tier]: { ...settings.byTier[tier], [capability]: value as ComputerPermission },
      },
    });
  }
  function setRole(capability: ComputerCapability, value: string) {
    return onchange({
      ...settings,
      byRole: {
        ...settings.byRole,
        [role]: { ...settings.byRole[role], [capability]: value as ComputerPermission },
      },
    });
  }
  function setApp(appId: string, capability: ComputerCapability, value: string) {
    return onchange({
      ...settings,
      apps: settings.apps.map((app) =>
        app.appId === appId
          ? {
              ...app,
              capabilities: { ...app.capabilities, [capability]: value as ComputerPermission },
            }
          : app,
      ),
    });
  }
  function addApp(target: ComputerTarget) {
    if (settings.apps.some((app) => app.appId === target.appId)) return;
    // Adding an identity does not grant any capability. The user must explicitly choose each grant.
    return onchange({
      ...settings,
      apps: [...settings.apps, { appId: target.appId, label: target.appId, capabilities: {} }],
    });
  }
  async function request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await apiFetch(apiUrl(`/api/v1/computer-use/${path}`), { method });
    const body = await parseJsonResponse<{ ok: boolean; data?: T; error?: string }>(response);
    if (!response.ok || !body.ok || body.data === undefined)
      throw new Error(body.error || `Computer use request failed (${response.status})`);
    return body.data;
  }
  async function checkStatus() {
    checking = true;
    error = '';
    try {
      const result = await request<ComputerPlatformStatus>('status');
      if (
        !result ||
        typeof result.platform !== 'string' ||
        typeof result.available !== 'boolean' ||
        !Array.isArray(result.capabilities) ||
        !Array.isArray(result.limitations)
      ) {
        throw new Error('Invalid computer use status response');
      }
      status = result;
    } catch (err) {
      status = null;
      error = err instanceof Error ? err.message : 'Could not check computer use status';
    } finally {
      checking = false;
    }
  }
  async function discoverApps() {
    discovering = true;
    error = '';
    targets = [];
    discovered = false;
    try {
      const payload = await request<{ targets: ComputerTarget[] }>('apps');
      const result = payload?.targets;
      if (
        !Array.isArray(result) ||
        result.some((target) => !target || typeof target.appId !== 'string' || !target.appId.trim())
      ) {
        throw new Error('Invalid computer use app discovery response');
      }
      targets = result;
      discovered = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not discover apps';
    } finally {
      discovering = false;
    }
  }
  async function stop() {
    stopping = true;
    error = '';
    notice = '';
    try {
      await request<{ cancelled: number; enabled: false }>('stop', 'POST');
      notice =
        'Stop requested and active desktop grants revoked across this host. Already-delivered input cannot be undone.';
      await onstopped?.();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not stop computer use';
    } finally {
      stopping = false;
    }
  }
</script>

<section class="computer-settings" aria-label="Computer use settings">
  <button
    type="button"
    class="section-heading"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <span class="heading-label"
      ><span class="section-icon"><Monitor size={15} /></span><span
        ><strong>Computer use</strong><small
          >App grants, permission presets & agent roles · {settings.enabled ? 'On' : 'Off'}</small
        ></span
      ></span
    >
    <ChevronRight size={16} class={expanded ? 'rotate-90' : ''} />
  </button>
  {#if expanded}
    <div class="section-content">
      <SettingsSwitch
        checked={settings.enabled}
        disabled={saving}
        label="Enable computer use"
        description="Off by default. Allow agents to request desktop observation and input, subject to every permission gate below."
        onchange={async () => {
          await onchange({ ...settings, enabled: !settings.enabled });
        }}
      />
      <div class="explanation">
        <strong>OS consent is not a Kory grant.</strong>
        <p>
          macOS may require Screen Recording and Accessibility permission; Windows and Linux need
          supported desktop APIs and dependencies. OS permission alone never authorizes an agent.
          Kory also checks the active permission preset, agent role and exact app identity before
          each action. Grants must be re-enabled after a backend restart; a workspace config file
          cannot authorize desktop access by itself.
        </p>
        <p>
          <strong>Block wins over Ask; Ask wins over Allow.</strong> All applicable gates must allow an
          action to skip approval. YOLO skips Kory approval prompts, while explicit blocks remain. Apps not listed
          below, and app capabilities not explicitly granted, are blocked. Discovery is checked by preset
          and role without an app grant.
        </p>
        <p>
          <strong>Plan and Critic use their own configurable role/tier policies.</strong> YOLO skips
          Kory approval prompts, while explicit blocks, missing OS consent, invalid targets, and
          unsupported native actions still fail. These settings do not bypass platform APIs.
        </p>
        <p>
          <strong>Desktop input is not a guaranteed sandbox.</strong> A permitted app can navigate elsewhere,
          access files or the network, or perform destructive actions. Sensitive-action blocking does
          not inspect arbitrary clicks or typed text. Use a dedicated OS account or VM for stronger isolation,
          and avoid granting terminals or sensitive apps.
        </p>
      </div>
      <div class="actions">
        <button type="button" disabled={checking} onclick={checkStatus}
          >{checking ? 'Checking…' : 'Check platform status'}</button
        >
        <button type="button" disabled={discovering} onclick={discoverApps}
          >{discovering ? 'Discovering…' : 'Discover running apps'}</button
        >
        <button type="button" class="stop" disabled={stopping} onclick={stop}
          >{stopping ? 'Stopping…' : 'Stop computer actions'}</button
        >
      </div>
      <p class="muted">
        Status checks do not enumerate windows. Discovery is an explicit user action and reveals
        app/window identities, not screenshots. Stop cancels pending computer actions across this
        host and revokes all active desktop grants. Re-enable and save settings explicitly before
        starting new actions.
      </p>
      {#if error}<p role="alert" class="error">{error}</p>{/if}
      {#if notice}<p role="status">{notice}</p>{/if}
      {#if status}
        <div class="status" role="status">
          <strong
            >{status.platform}: {status.available
              ? 'Adapter available'
              : 'Adapter unavailable'}</strong
          >
          <p>
            Reported capabilities: {status.capabilities
              .map((capability) => names[capability])
              .join(', ') || 'None'}. Availability is not an app grant or a guarantee of OS consent.
          </p>
          {#if status.limitations.length}<ul>
              {#each status.limitations as limitation}<li>{limitation}</li>{/each}
            </ul>{/if}
        </div>
      {:else}<p class="muted">
          Platform support has not been checked. Saved grants do not imply runtime support.
        </p>{/if}

      <div class="policy-grid">
        <div class="policy">
          <h4>Per permission preset</h4>
          <KorySelect
            label="Computer permission preset"
            value={tier}
            options={COMPUTER_TIERS.map((value) => ({ value, label: tierNames[value] }))}
            onchange={(value) => (tier = value as ComputerTier)}
          />
          <p class="muted">Editing this policy does not switch your active chat preset.</p>
          {#each COMPUTER_CAPABILITIES as capability}
            {@const hardBlock = reserved(capability)}
            <KorySelect
              label={`${names[capability]} · ${tierNames[tier]}`}
              description={hardBlock
                ? reserved(capability)
                  ? descriptions[capability]
                  : 'This capability is not implemented as a dedicated tool yet.'
                : unavailable(capability)
                  ? 'Not supported on this platform. Saved policy cannot enable it.'
                  : descriptions[capability]}
              value={hardBlock ? 'block' : settings.byTier[tier][capability]}
              options={permissions}
              disabled={saving || hardBlock}
              onchange={(value) => setTier(capability, value)}
            />
          {/each}
        </div>
        <div class="policy">
          <h4>Per agent role</h4>
          <KorySelect
            label="Computer agent role"
            value={role}
            options={COMPUTER_ROLES.map((value) => ({ value, label: roleNames[value] }))}
            onchange={(value) => (role = value as ComputerRole)}
          />
          <p class="muted">The role policy also applies to delegated agents.</p>
          {#each COMPUTER_CAPABILITIES as capability}
            {@const hardBlock = reserved(capability)}
            <KorySelect
              label={`${names[capability]} · ${roleNames[role]}`}
              description={hardBlock
                ? reserved(capability)
                  ? descriptions[capability]
                  : 'This capability is not implemented as a dedicated tool yet.'
                : unavailable(capability)
                  ? 'Not supported on this platform. Saved policy cannot enable it.'
                  : descriptions[capability]}
              value={hardBlock ? 'block' : settings.byRole[role][capability]}
              options={permissions}
              disabled={saving || hardBlock}
              onchange={(value) => setRole(capability, value)}
            />
          {/each}
        </div>
      </div>

      <div class="app-policy">
        <h4>App allowlist & capability overrides</h4>
        <p class="muted">
          Discover an app, add its OS-resolved identity, then grant individual capabilities. Adding
          an app starts with every capability blocked. A label or window title is not a security
          identity; grants cover that app's windows, not a specific document.
        </p>
        {#if discovered}
          <div class="discovered">
            <h5>Discovered apps</h5>
            {#each discoveredApps as target (target.appId)}
              <div class="app-row">
                <code>{target.appId}</code><button
                  type="button"
                  disabled={saving || settings.apps.some((app) => app.appId === target.appId)}
                  onclick={() => addApp(target)}
                  >{settings.apps.some((app) => app.appId === target.appId)
                    ? 'Added'
                    : 'Add app'}</button
                >
              </div>
            {:else}<p>
                No running apps were returned. Check platform status and OS permissions.
              </p>{/each}
          </div>
        {/if}
        {#each settings.apps as app (app.appId)}
          <div class="app-card">
            <div class="app-row">
              <div>
                <h5>{app.label}</h5>
                <code>{app.appId}</code>
              </div>
              <button
                type="button"
                disabled={saving}
                aria-label={`Remove ${app.label} grant`}
                onclick={() =>
                  onchange({
                    ...settings,
                    apps: settings.apps.filter((item) => item.appId !== app.appId),
                  })}>Remove grant</button
              >
            </div>
            <div class="app-capabilities">
              {#each COMPUTER_CAPABILITIES.filter((capability) => capability !== 'discover') as capability}
                <KorySelect
                  label={`${names[capability]} · ${app.label}`}
                  description={reserved(capability)
                    ? descriptions[capability]
                    : unavailable(capability)
                      ? 'Unsupported on this platform.'
                      : undefined}
                  value={reserved(capability) ? 'block' : (app.capabilities[capability] ?? 'block')}
                  options={permissions}
                  disabled={saving || reserved(capability)}
                  onchange={(value) => setApp(app.appId, capability, value)}
                />
              {/each}
            </div>
          </div>
        {:else}<p class="empty">No app grants. Agents cannot observe or control any app.</p>{/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .computer-settings {
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    background: var(--color-surface-1);
    overflow: hidden;
    color: var(--color-text-primary);
  }
  .section-heading {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    text-align: left;
  }
  .section-heading:hover {
    background: var(--color-surface-2);
  }
  .heading-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .heading-label strong {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .heading-label small {
    display: block;
    margin-top: 0.125rem;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .section-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
  }
  .section-content {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
    border-top: 1px solid var(--color-border);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  .explanation,
  .status,
  .discovered,
  .app-card {
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    background: var(--color-surface-2);
  }
  .explanation p + p,
  .status p,
  .status ul {
    margin-top: 0.5rem;
  }
  .explanation {
    color: var(--color-text-secondary);
  }
  .actions,
  .app-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .app-row {
    justify-content: space-between;
  }
  .actions button,
  .app-row button {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    font-weight: 500;
    background: var(--color-surface-2);
  }
  .actions button:hover,
  .app-row button:hover {
    background: var(--color-surface-3);
  }
  .actions .stop {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .policy-grid,
  .app-capabilities {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .policy,
  .app-policy {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    min-width: 0;
  }
  h4 {
    font-weight: 600;
    font-size: 0.875rem;
  }
  h5 {
    font-weight: 600;
  }
  .muted,
  .empty {
    color: var(--color-text-muted);
  }
  .error {
    color: var(--color-error);
  }
  .status ul {
    padding-left: 1rem;
    list-style: disc;
  }
  code {
    overflow-wrap: anywhere;
    font-size: 11px;
    color: var(--color-text-secondary);
  }
  .app-capabilities {
    margin-top: 1rem;
  }
  .discovered .app-row {
    margin-top: 0.75rem;
  }
  @media (max-width: 640px) {
    .policy-grid,
    .app-capabilities {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
