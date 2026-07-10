/**
 * Remote provider host — the HOST side of "share my models".
 *
 * When hosting, Koryphaios can advertise a catalog of its providers over the
 * relay and answer `inference-request` RPCs by running the model locally and
 * streaming the ProviderEvents back to the requesting client. The client runs
 * its OWN agent loop and filesystem; only the inference happens here.
 *
 * This is deliberately separate from the shared-session collaboration path
 * (`guest-prompt` → `processTask`): here the client keeps its own workspace.
 */

import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { dirname, join, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { serverLog } from '../logger';
import { getContext } from '../context';
import { classifyProviderShare, DEFAULT_SANDBOX_POLICY, tightenSandbox } from '@koryphaios/shared';
import type {
  SharedProviderCatalog,
  SharedProviderEntry,
  RemoteInferenceRequestPayload,
  ProjectSync,
  SandboxPolicy,
} from '@koryphaios/shared';
import type { RelayClient } from './relay-client';
import type {
  StreamRequest,
  ProviderMessage,
  ProviderToolDef,
  ProviderEvent,
} from '../providers/types';

const log = serverLog.child({ module: 'remote-provider-host' });

// CLI-harness providers run their tools on the machine the CLI lives on, so
// they cannot be served as pure inference to a remote client's filesystem.
// They are advertised as `agentic: true` (offered in host-side "remote agentic"
// mode) so the UI can present them honestly.
const AGENTIC_PROVIDERS = new Set(['claude', 'grok', 'antigravity', 'cursor', 'devin', 'cline']);

export function isAgenticProvider(name: string): boolean {
  return AGENTIC_PROVIDERS.has(name);
}

// ─── Shared-provider selection (which providers the host offers) ──────────────

let sharedProviderNames = new Set<string>();

export function setSharedProviders(names: string[]): void {
  sharedProviderNames = new Set(names);
  // Re-advertise whenever the selection changes and we're hosting.
  broadcastCatalog();
}

export function getSharedProviders(): string[] {
  return [...sharedProviderNames];
}

// The host's base sandbox policy for remote CLI turns (a joining guest's tier
// can only tighten it). Defaults to "Balanced".
let hostSandboxPolicy: SandboxPolicy = DEFAULT_SANDBOX_POLICY;

export function setSandboxPolicy(policy: SandboxPolicy): void {
  hostSandboxPolicy = policy;
}

export function getSandboxPolicy(): SandboxPolicy {
  return hostSandboxPolicy;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

function buildCatalog(hostName: string): SharedProviderCatalog {
  const status = getContext().providers.getStatus();
  const providers: SharedProviderEntry[] = [];

  for (const p of status) {
    if (!sharedProviderNames.has(p.name)) continue;
    if (!p.authenticated || !p.enabled) continue;
    const enabledIds = new Set(p.models);
    const models = p.allAvailableModels
      .filter((m) => enabledIds.size === 0 || enabledIds.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        canReason: m.canReason,
        reasoningLevels: m.reasoningLevels,
      }));
    if (models.length === 0) continue;
    providers.push({
      provider: p.name,
      label: p.label ?? p.name,
      models,
      agentic: AGENTIC_PROVIDERS.has(p.name),
      risk: classifyProviderShare(p.name).risk,
    });
  }

  return { hostName, providers };
}

let activeRelay: RelayClient | null = null;
let activeHostName = 'Host';

function broadcastCatalog(): void {
  if (!activeRelay?.isConnected) return;
  activeRelay.broadcast({ type: 'provider-catalog', catalog: buildCatalog(activeHostName) });
}

// ─── Inference request handling ──────────────────────────────────────────────

const activeRequests = new Map<string, AbortController>();

// One temp sandbox per (guest, provider) so a guest's project persists across
// turns (deltas apply on top). Cleared on session end / disconnect.
const sandboxes = new Map<string, string>();

function sandboxKey(guestId: string, provider: string): string {
  return `${guestId}:${provider}`;
}

/** Materialize / update a guest's project in a host temp sandbox. Returns the
 *  sandbox root. Applies a full snapshot or a delta (+ deletions). */
async function applyProjectSync(
  guestId: string,
  provider: string,
  sync: ProjectSync,
): Promise<string> {
  const key = sandboxKey(guestId, provider);
  let root = sandboxes.get(key);
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'koryphaios-remote-'));
    sandboxes.set(key, root);
    log.info({ guestId, provider, root }, 'Created remote CLI sandbox');
  }
  for (const del of sync.deletes) {
    if (isAbsolute(del) || del.includes('..')) continue;
    await rm(join(root, del), { force: true }).catch(() => {});
  }
  for (const file of sync.files) {
    if (isAbsolute(file.path) || file.path.includes('..')) continue;
    const dest = join(root, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, 'utf-8');
  }
  return root;
}

/** Rewrite an agentic file_edit event's path to be relative to the sandbox
 *  root, so the client can re-apply it against its own project. Drops edits
 *  that land outside the sandbox. */
function rebaseFileEdit(event: ProviderEvent, sandboxRoot: string): ProviderEvent | null {
  if (event.type !== 'file_edit' || !event.filePath) return event;
  let rel = event.filePath;
  if (isAbsolute(rel)) {
    const r = relative(sandboxRoot, rel);
    if (r.startsWith('..')) return null; // escaped the sandbox — never send
    rel = r;
  }
  return { ...event, filePath: rel.split(sep).join('/') };
}

async function cleanupSandbox(guestId: string, provider: string): Promise<void> {
  const key = sandboxKey(guestId, provider);
  const root = sandboxes.get(key);
  if (root) {
    sandboxes.delete(key);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function toStreamRequest(
  payload: RemoteInferenceRequestPayload,
  signal: AbortSignal,
  sandboxRoot?: string,
): StreamRequest {
  return {
    model: payload.model,
    messages: (payload.messages ?? []) as ProviderMessage[],
    systemPrompt: payload.systemPrompt ?? '',
    tools: payload.tools as ProviderToolDef[] | undefined,
    maxTokens: payload.maxTokens,
    temperature: payload.temperature,
    reasoningLevel: payload.reasoningLevel,
    signal,
    // Agentic turns run the CLI in the host sandbox; pure inference ignores it.
    workingDirectory: sandboxRoot,
  };
}

async function handleInferenceRequest(
  relay: RelayClient,
  guestId: string,
  tierId: string,
  requestId: string,
  payload: RemoteInferenceRequestPayload,
): Promise<void> {
  const fail = (error: string) =>
    relay.sendToGuest(guestId, { type: 'inference-error', requestId, error });

  // Only serve providers the host actually chose to share.
  if (!sharedProviderNames.has(payload.provider)) {
    fail(`Provider "${payload.provider}" is not shared by this host.`);
    return;
  }

  // The joining guest's tier — the HOST decides what they can do. The sandbox
  // is just a folder; these permissions are the actual control surface.
  const tier = relay.policy?.accessTiers.find((t) => t.id === tierId);
  if (!tier?.permissions.useRemoteProviders) {
    fail('Your access tier does not permit using shared models.');
    return;
  }
  // Host's model allowlist for this tier.
  if (!tier.allowedModels.includes('*') && !tier.allowedModels.includes(payload.model)) {
    fail(`The host has not allowed the model "${payload.model}" for your access level.`);
    return;
  }

  // The sandbox for this turn = the host's base policy, tightened by the guest's
  // tier (a tier can only remove capabilities, never add them). File edits go
  // back to the guest (their risk); shell/network run in the host jail.
  const sandbox = tightenSandbox(hostSandboxPolicy, {
    allowShell: tier.permissions.fullSystemAccess === true,
    allowEdits: tier.permissions.useTools !== false,
  });

  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  try {
    // Agentic turn: land the guest's project in a host sandbox first.
    let sandboxRoot: string | undefined;
    if (payload.agentic && payload.projectSync) {
      sandboxRoot = await applyProjectSync(guestId, payload.provider, payload.projectSync);
    }
    const request = toStreamRequest(payload, controller.signal, sandboxRoot);
    if (payload.agentic) request.sandbox = sandbox;
    const stream = getContext().providers.executeWithRetry(request, payload.provider as never);
    for await (const event of stream) {
      if (controller.signal.aborted) break;
      // Rewrite host-sandbox file paths → sandbox-relative for the client.
      const outEvent = sandboxRoot ? rebaseFileEdit(event, sandboxRoot) : event;
      if (!outEvent) continue;
      relay.sendToGuest(guestId, { type: 'inference-event', requestId, event: outEvent });
    }
    relay.sendToGuest(guestId, { type: 'inference-done', requestId });
  } catch (err) {
    relay.sendToGuest(guestId, {
      type: 'inference-error',
      requestId,
      error: err instanceof Error ? err.message : 'Remote inference failed',
    });
  } finally {
    activeRequests.delete(requestId);
  }
}

/** Register the remote-inference handlers on a hosting relay connection.
 *  Returns an unregister function. Call this from hostSession. */
export function startProviderHost(relay: RelayClient, hostName: string): () => void {
  activeRelay = relay;
  activeHostName = hostName;

  const unregister = relay.onMessage((msg) => {
    if (msg.type === 'inference-request') {
      const guestId = String(msg.guestId ?? '');
      const requestId = String(msg.requestId ?? '');
      const tierId = String(msg.tierId ?? '');
      if (!guestId || !requestId || !msg.payload) return;
      void handleInferenceRequest(
        relay,
        guestId,
        tierId,
        requestId,
        msg.payload as RemoteInferenceRequestPayload,
      ).catch((err) => log.warn({ err }, 'inference-request handler failed'));
      return;
    }
    if (msg.type === 'inference-cancel') {
      const requestId = String(msg.requestId ?? '');
      activeRequests.get(requestId)?.abort();
    }
  });

  // Advertise immediately so already-connected clients learn the catalog.
  broadcastCatalog();

  return () => {
    unregister();
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
    // Remove every guest's project sandbox from disk.
    for (const [key, root] of sandboxes) {
      void rm(root, { recursive: true, force: true }).catch(() => {});
      sandboxes.delete(key);
    }
    if (activeRelay === relay) activeRelay = null;
  };
}
