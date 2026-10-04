/**
 * Freebuff's supported free-tier surface is its Ink TUI, not @codebuff/sdk.
 * This adapter drives that real TUI through tmux (a real PTY), gives it a
 * disposable checkout, and installs Kory's authenticated MCP bridge in the
 * project-local .agents/mcp.json understood by Freebuff.
 *
 * Freebuff does not expose a native-tool deny switch. Consequently the OS
 * sandbox is mandatory: native tools can affect only the disposable checkout;
 * the real Kory session workspace is reachable exclusively through MCP and
 * ToolRegistry/permission-policy.ts.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { materializeFreebuffCredentials } from './freebuff-credentials';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isTransientStreamErrorText } from './provider-diagnostics';
import { providerLog } from '../logger';
import {
  createFreebuffTurnRuntime,
  getFreebuffRuntimeStatus,
  refreshFreebuffRuntimeStatus,
} from './freebuff-runtime';
import { prepareFreebuffBridge } from './freebuff-bridge-runtime';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { buildProviderCliEnv } from './cli-environment';
import { getCliBridge } from './cli-bridges';
import { serializeKoryMcpServers } from './kory-cli-mcp-config';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import { createGenericModel } from './models';
import { discoverFreebuffAccounts, type FreebuffAccount } from './auth-utils';
import {
  discoverFreebuffBundledCatalog,
  buildFreebuffTurnSettings,
  freebuffSelectedModelFromLogRow,
  FREEBUFF_CLI_DEFAULT_MODEL_ID,
  type FreebuffBundledCatalog,
} from './freebuff-bundled-catalog';
import type { Provider, ProviderEvent, ProviderMessage, StreamRequest } from './types';
import { userConfirmedImageInput } from './attachment-admission';

const ACCOUNT_PREFIX = 'freebuff-account:';
const MAX_RUNTIME_MS = 9 * 60_000;

export const FREEBUFF_PTY_UNAVAILABLE_ERROR =
  'Freebuff requires its logged-in CLI and a verified Linux bubblewrap runtime (native Linux or the pinned Docker runtime). Run "freebuff login", configure the runtime, and reconnect.';

const FREEBUFF_IMAGE_MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
]);
const FREEBUFF_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FREEBUFF_MAX_TOTAL_IMAGE_BYTES = 5 * 1024 * 1024;

export interface FreebuffPtyImage {
  data: string;
  mimeType: string;
  extension: string;
}

export interface FreebuffPtyTurn {
  prompt: string;
  images: FreebuffPtyImage[];
}

export interface FreebuffLogUsage {
  /** Context occupying the selected model's final request in this turn. */
  finalContextTokens: number;
  /** Sum of input context processed across selected-model requests in this turn. */
  inputTokensProcessed: number;
  requestCount: number;
  /** Individual request contexts, needed for size-tiered public pricing. */
  requestInputTokens: number[];
}

/**
 * Read the token evidence Freebuff itself writes before each agent request.
 * Its current log does not expose upstream output-token usage, so callers must
 * keep that side explicitly unknown instead of estimating it from text length.
 */
export function freebuffUsageFromLogRow(
  row: Record<string, unknown>,
  selectedModel: string,
): number | null {
  if (typeof row.msg !== 'string' || !row.msg.startsWith('Start agent ')) return null;
  const data =
    row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
  if (data.model !== selectedModel) return null;
  const contextTokenCount = Number(data.contextTokenCount);
  if (!Number.isSafeInteger(contextTokenCount) || contextTokenCount < 1) return null;
  return contextTokenCount;
}

function nativeFreebuffBinary(profileDir?: string): string | null {
  const candidates = [
    profileDir ? join(profileDir, 'freebuff') : '',
    join(homedir(), '.config', 'manicode', 'freebuff'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function parseModelSelection(model: string): { profileDir?: string; modelId: string } {
  if (!model.startsWith(ACCOUNT_PREFIX)) return { modelId: model };
  const rest = model.slice(ACCOUNT_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator < 1) return { modelId: model };
  try {
    return {
      profileDir: Buffer.from(rest.slice(0, separator), 'base64url').toString('utf8'),
      modelId: rest.slice(separator + 1),
    };
  } catch {
    return { modelId: model };
  }
}

/**
 * Keep text and image extraction in one pass so a future refactor cannot
 * advertise image support while silently flattening image blocks again.
 */
export function buildFreebuffPtyTurn(
  systemPrompt: string,
  messages: ProviderMessage[],
): FreebuffPtyTurn {
  const images: FreebuffPtyImage[] = [];
  const history = messages
    .map((message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                if (block.type !== 'image') return block.text ?? block.toolOutput ?? '';
                const mimeType = block.imageMimeType?.toLowerCase() ?? '';
                const extension = FREEBUFF_IMAGE_MIME_EXTENSIONS.get(mimeType);
                if (!extension) {
                  throw new Error(
                    `Freebuff PTY does not support image type ${block.imageMimeType ?? '(missing)'}`,
                  );
                }
                if (!block.imageData?.trim()) {
                  throw new Error('Freebuff PTY received an image block without image data');
                }
                images.push({ data: block.imageData, mimeType, extension });
                return `[Attached image ${images.length}]`;
              })
              .filter(Boolean)
              .join('\n');
      return content.trim() ? `${message.role.toUpperCase()}: ${content.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return {
    prompt: [systemPrompt.trim(), history].filter(Boolean).join('\n\n'),
    images,
  };
}

function decodeFreebuffImage(image: FreebuffPtyImage, index: number): Buffer {
  const encoded = image.data.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`Freebuff PTY image ${index + 1} is not valid base64`);
  }
  const decoded = Buffer.from(encoded, 'base64');
  const canonicalInput = encoded.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  if (canonicalDecoded !== canonicalInput) {
    throw new Error(`Freebuff PTY image ${index + 1} is not valid base64`);
  }
  if (decoded.byteLength > FREEBUFF_MAX_IMAGE_BYTES) {
    throw new Error(`Freebuff PTY image ${index + 1} exceeds the 10 MB image limit`);
  }
  return decoded;
}

function materializeFreebuffImages(images: FreebuffPtyImage[], workspace: string): string[] {
  let totalBytes = 0;
  return images.map((image, index) => {
    const decoded = decodeFreebuffImage(image, index);
    totalBytes += decoded.byteLength;
    if (totalBytes > FREEBUFF_MAX_TOTAL_IMAGE_BYTES) {
      throw new Error('Freebuff PTY images exceed the 5 MB combined image limit');
    }
    // Keep transport basenames short enough to match native attachment cards
    // without guessing at terminal clipping.
    const path = join(workspace, freebuffImageBasename(index, image.extension));
    writeManagedCliFile(path, decoded);
    return path;
  });
}

export function freebuffImageBasename(index: number, extension: string): string {
  return `ki${index + 1}.${extension}`;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Read CLI-controlled paths INSIDE bwrap. Reading them on the host would let a
// native sandbox tool point a symlink at a host log/credential file. Output is
// bounded and offsets are bytes, not JS UTF-16 character positions.
export const FREEBUFF_LOG_READER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [root, rawOffsets] = process.argv.slice(1);
const offsets = new Map(JSON.parse(rawOffsets));
const chunks = [];
let budget = 512 * 1024;
let visited = 0;
function visit(dir, depth = 0) {
  if (depth > 12 || ++visited > 256) throw Error('log tree limit');
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file, depth + 1);
    else if (entry.isFile() && entry.name === 'log.jsonl' && budget > 0) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const size = fs.fstatSync(fd).size;
        let offset = offsets.get(file) || 0;
        if (size < offset) offset = 0;
        const bytes = Buffer.alloc(Math.min(Math.max(0, size - offset), budget));
        const count = fs.readSync(fd, bytes, 0, bytes.length, offset);
        const newline = bytes.subarray(0, count).lastIndexOf(10);
        if (newline < 0) {
          if (count === budget) throw Error('log row limit');
          continue;
        }
        const length = newline + 1;
        budget -= length;
        chunks.push({file, offset: offset + length, text: bytes.subarray(0, length).toString('utf8')});
      } finally { fs.closeSync(fd); }
    }
  }
}
visit(root);
process.stdout.write(JSON.stringify(chunks));
`;

export async function readFreebuffLogRows(
  runtime: Pick<FreebuffTurnRuntime, 'exec' | 'bunBinary'>,
  root: string,
  offsets: Map<string, number>,
): Promise<Record<string, unknown>[]> {
  const raw = await runtime.exec(
    runtime.bunBinary,
    ['-e', FREEBUFF_LOG_READER, root, JSON.stringify([...offsets])],
    { timeout: 10_000 },
  );
  const chunks: unknown = JSON.parse(raw);
  if (!Array.isArray(chunks))
    throw new FreebuffPtyError('Freebuff produced invalid log transport data');
  const rows: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    if (
      !chunk ||
      typeof chunk.file !== 'string' ||
      typeof chunk.text !== 'string' ||
      !Number.isSafeInteger(chunk.offset) ||
      chunk.offset < 0
    ) {
      throw new FreebuffPtyError('Freebuff produced invalid log transport data');
    }
    offsets.set(chunk.file, chunk.offset);
    for (const line of chunk.text.split('\n')) {
      try {
        const row: unknown = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row))
          rows.push(row as Record<string, unknown>);
      } catch {
        /* Ignore incomplete/unstructured diagnostic lines, never echo them. */
      }
    }
  }
  return rows;
}

type FreebuffTurnRuntime = Awaited<ReturnType<typeof createFreebuffTurnRuntime>>;
type FreebuffTmux = (args: string[]) => Promise<string>;

/** Only adapter-owned messages may reach diagnostics; panes and child errors can contain secrets. */
class FreebuffPtyError extends Error {}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function waitForFreebuffPoll(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolveWait, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type FreebuffStartupState = 'ready' | 'welcome' | 'trust' | 'login' | 'waiting';
export function freebuffStartupState(pane: string): FreebuffStartupState {
  const screen = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/Load and run these\?\s*\[y\/N\]/i.test(screen)) return 'trust';
  if (
    /sign in to continue|log in to continue|please (?:log|sign) in|https?:\/\/\S+\/(?:login|auth)\b/i.test(
      screen,
    )
  )
    return 'login';
  // A banner or a long pane is NOT input readiness. This is 0.2.12's actual composer placeholder.
  if (/enter a coding task or \/ for commands/i.test(screen)) return 'ready';
  if (/start coding for free|press enter to continue/i.test(screen)) return 'welcome';
  return 'waiting';
}

/** Trust is limited to the generated .agents directory, never a user checkout. */
export function freebuffPrivateCliArgs(runRoot: string, workspace: string): string[] {
  if (resolve(workspace) !== join(resolve(runRoot), 'workspace')) {
    throw new FreebuffPtyError('Freebuff refused to trust a non-private workspace');
  }
  return ['--cwd', workspace, '--trust-agents'];
}

export async function waitForFreebuffStartup(
  tmux: FreebuffTmux,
  session: string,
  signal?: AbortSignal,
  timeoutMs = 45_000,
): Promise<void> {
  const startedAt = Date.now();
  let dismissedWelcome = false;
  while (Date.now() - startedAt < timeoutMs) {
    checkAbort(signal);
    const pane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
    checkAbort(signal);
    switch (freebuffStartupState(pane)) {
      case 'ready':
        return;
      // --trust-agents must have bypassed this for only our generated workspace.
      // Never blindly send Enter/y to arbitrary prompts (including tool approvals).
      case 'trust':
        throw new FreebuffPtyError('Freebuff did not accept the private workspace trust flag');
      case 'login':
        throw new FreebuffPtyError(
          'Freebuff CLI login is required; run "freebuff login" and reconnect',
        );
      case 'welcome':
        if (!dismissedWelcome) {
          await tmux(['send-keys', '-t', session, 'Enter']);
          dismissedWelcome = true;
        }
        break;
    }
    await waitForFreebuffPoll(250, signal);
  }
  throw new FreebuffPtyError('Freebuff TUI did not reach its input-ready state');
}

async function waitForFreebuffImageReady(
  tmux: FreebuffTmux,
  session: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    checkAbort(signal);
    const pane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
    const filenameIndex = pane.indexOf(filename);
    if (filenameIndex >= 0) {
      const region = pane.slice(
        Math.max(0, filenameIndex - 500),
        filenameIndex + filename.length + 500,
      );
      if (region.includes('❌'))
        throw new FreebuffPtyError('Freebuff TUI rejected an attached image');
      if (!region.includes('processing…') && !region.includes('processing...')) return;
    }
    await waitForFreebuffPoll(250, signal);
  }
  throw new FreebuffPtyError('Freebuff TUI did not finish attaching an image');
}

/** Nested agents commonly set shouldEndTurn. Only the main prompt owns turn completion. */
export function freebuffCompletionFromLogRow(
  row: Record<string, unknown>,
): 'pending' | 'success' | 'error' {
  if (row.msg !== 'Main prompt finished') return 'pending';
  const data =
    row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
  return ['lastMessage', 'allMessages', 'structuredOutput'].includes(String(data.outputType))
    ? 'success'
    : 'error';
}

function catalogRevision(
  accounts: FreebuffAccount[],
  findBinary = nativeFreebuffBinary,
): string | null {
  try {
    return accounts
      .map((account) => {
        const binary = findBinary(account.profileDir);
        if (!binary) throw new Error('missing binary');
        const metadata = statSync(binary);
        return `${account.id}:${binary}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
      })
      .join('|');
  } catch {
    return null;
  }
}

function accountCatalogModels(
  account: FreebuffAccount,
  catalog: FreebuffBundledCatalog,
  multipleAccounts: boolean,
): ModelDef[] {
  const encodedProfile = Buffer.from(account.profileDir).toString('base64url');
  return catalog.models.map(({ id, name, multimodal, contextWindow }) => {
    const model = createGenericModel(
      multipleAccounts ? `${ACCOUNT_PREFIX}${encodedProfile}:${id}` : id,
      'freebuff',
    );
    model.name = multipleAccounts ? `${name} (${account.label})` : name;
    model.apiModelId = id;
    model.accountId = account.id;
    model.supportsAttachments = multimodal;
    model.vision = multimodal;
    if (contextWindow && contextWindow >= 1_024) {
      model.contextWindow = contextWindow;
      model.contextVerified = true;
    }
    return model;
  });
}

const freebuffDependencies = {
  discoverAccounts: discoverFreebuffAccounts,
  findBinary: nativeFreebuffBinary,
  discoverCatalog: discoverFreebuffBundledCatalog,
  runtimeStatus: getFreebuffRuntimeStatus,
  refreshRuntimeStatus: refreshFreebuffRuntimeStatus,
  createRuntime: createFreebuffTurnRuntime,
  prepareBridge: prepareFreebuffBridge,
  createLease: createKoryBridgeGrantLease,
  materializeCredentials: materializeFreebuffCredentials,
  getBridge: getCliBridge,
  createRunRoot: () =>
    join(
      homedir(),
      '.koryphaios',
      'freebuff-runs',
      `${Date.now()}-${randomBytes(8).toString('hex')}`,
    ),
  readLogRows: readFreebuffLogRows,
};

/** Injectable boundary for credential-free lifecycle tests; production uses only these safe defaults. */
export type FreebuffProviderDependencies = typeof freebuffDependencies;

export class FreebuffProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  readonly name = 'freebuff' as const;
  private models: ModelDef[] = [];
  private modelDiscoveryError: string | undefined;
  private refreshInFlight: Promise<ModelDef[]> | null = null;
  private loadedCatalogRevision: string | null = null;

  private readonly deps: FreebuffProviderDependencies;

  constructor(
    readonly config: ProviderConfig,
    dependencies: Partial<FreebuffProviderDependencies> = {},
  ) {
    this.deps = { ...freebuffDependencies, ...dependencies };
    if (!config.disabled) {
      void this.deps
        .refreshRuntimeStatus()
        .then(() => {
          if (this.isAvailable()) void this.refreshModels();
        })
        .catch(() => {
          /* Unavailable until a successful runtime probe. */
        });
    }
  }

  isAvailable(): boolean {
    if (this.config.disabled || !this.deps.runtimeStatus().available) return false;
    return this.deps
      .discoverAccounts()
      .some(
        (account) =>
          existsSync(join(account.profileDir, 'credentials.json')) &&
          this.deps.findBinary(account.profileDir) !== null,
      );
  }

  listModels(): ModelDef[] {
    const accounts = this.deps.discoverAccounts();
    const revision = catalogRevision(accounts, this.deps.findBinary);
    if (this.isAvailable() && revision !== this.loadedCatalogRevision) {
      // A replaced CLI executable invalidates its old model capabilities
      // immediately. Do not display a stale menu while the new binary is read.
      this.models = [];
      void this.refreshModels(true);
    }
    return this.models;
  }

  getModelDiscoveryError(): string | undefined {
    return this.modelDiscoveryError;
  }

  refreshModels(forceRefresh = false): Promise<ModelDef[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const accounts = this.deps.discoverAccounts();
    const revision = catalogRevision(accounts, this.deps.findBinary);
    if (!forceRefresh && revision && revision === this.loadedCatalogRevision) {
      return Promise.resolve(this.models);
    }
    if (accounts.length === 0) {
      this.models = [];
      this.loadedCatalogRevision = null;
      this.modelDiscoveryError =
        'Freebuff CLI is not signed in. Run "freebuff login" and reconnect.';
      return Promise.resolve([]);
    }
    if (!revision) {
      this.models = [];
      this.loadedCatalogRevision = null;
      this.modelDiscoveryError =
        'Freebuff executable was not found for the signed-in CLI account. Reinstall Freebuff and reconnect.';
      return Promise.resolve([]);
    }

    this.refreshInFlight = Promise.allSettled(
      accounts.map(async (account) => {
        const binary = this.deps.findBinary(account.profileDir);
        if (!binary) throw new Error('Freebuff executable is missing for an account');
        return {
          account,
          catalog: await this.deps.discoverCatalog(binary),
        };
      }),
    )
      .then((results) => {
        const failures: string[] = [];
        const loaded = results.flatMap((result) => {
          if (result.status === 'rejected') {
            failures.push('An installed CLI catalog could not be read');
            return [];
          }
          const qualifiedRuntime = this.deps.runtimeStatus();
          if (
            qualifiedRuntime.available &&
            qualifiedRuntime.version &&
            result.value.catalog.cliVersion !== qualifiedRuntime.version
          ) {
            failures.push(
              'The installed CLI version differs from the qualified execution runtime; update and requalify the runtime before using this account',
            );
            return [];
          }
          return accountCatalogModels(
            result.value.account,
            result.value.catalog,
            accounts.length > 1,
          );
        });
        const currentRevision = catalogRevision(accounts, this.deps.findBinary);
        if (currentRevision !== revision) {
          this.models = [];
          this.loadedCatalogRevision = null;
          this.modelDiscoveryError =
            'Freebuff changed while its model catalog was being read. Refresh model discovery.';
          return [];
        }
        this.models = loaded;
        this.loadedCatalogRevision = revision;
        this.modelDiscoveryError =
          loaded.length === 0
            ? `Freebuff model discovery failed: ${failures.join('; ').slice(0, 500) || 'the installed binary reported no picker models'}`
            : failures.length > 0
              ? `Some Freebuff accounts could not be discovered: ${failures.join('; ').slice(0, 500)}`
              : undefined;
        providerLog.info(
          {
            provider: 'freebuff',
            models: loaded.map((model) => ({
              model: model.apiModelId,
              account: model.accountId,
              vision: model.supportsAttachments === true,
            })),
          },
          'Loaded model and vision capabilities from installed Freebuff catalog',
        );
        return loaded;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let runRoot = '';
    let runtime: FreebuffTurnRuntime | undefined;
    let prepared: Awaited<ReturnType<typeof prepareFreebuffBridge>> | undefined;
    let lease: ReturnType<typeof createKoryBridgeGrantLease> | undefined;
    let runtimeCleanup: Promise<void> | undefined;
    const stopRuntime = () => (runtimeCleanup ??= runtime?.cleanup());
    let phase = 'runtime readiness';
    const timeout = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    const requestedLimit = Number(request.sandbox?.maxRuntimeSeconds);
    const runtimeMs =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_RUNTIME_MS, requestedLimit * 1000)
        : MAX_RUNTIME_MS;
    const timer = setTimeout(() => timeout.abort(), runtimeMs);
    const onAbort = () => {
      void stopRuntime()?.catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      checkAbort(signal);
      if (!this.config.disabled) await this.deps.refreshRuntimeStatus();
      checkAbort(signal);
      if (!this.isAvailable()) {
        yield { type: 'error', error: FREEBUFF_PTY_UNAVAILABLE_ERROR };
        return;
      }
      if (!request.sessionId?.trim()) {
        yield {
          type: 'error',
          error:
            'Freebuff PTY turns require a Koryphaios session so MCP tools can be scoped and authenticated.',
        };
        return;
      }

      // Recheck host-CLI/runtime version agreement after readiness, including
      // accounts whose catalogs were discovered before the async probe finished.
      const availableModels = await this.refreshModels(true);
      const requestedSelection = parseModelSelection(request.model);
      if (
        !availableModels.some(
          (model) =>
            model.apiModelId === requestedSelection.modelId &&
            (!requestedSelection.profileDir ||
              model.accountId ===
                this.deps
                  .discoverAccounts()
                  .find(
                    (account) =>
                      resolve(account.profileDir) === resolve(requestedSelection.profileDir!),
                  )?.id),
        )
      ) {
        yield {
          type: 'error',
          error:
            this.modelDiscoveryError ??
            'The selected model is not in the installed CLI catalog. Refresh models or choose another model.',
        };
        return;
      }

      let turn: FreebuffPtyTurn;
      try {
        turn = buildFreebuffPtyTurn(request.systemPrompt, request.messages);
      } catch {
        yield {
          type: 'error',
          error: 'Freebuff PTY received unsupported or invalid message content.',
        };
        return;
      }
      if (!turn.prompt.trim()) {
        yield { type: 'error', error: 'Freebuff: empty prompt' };
        return;
      }
      if (
        turn.images.length &&
        !userConfirmedImageInput(this, request) &&
        !availableModels.some(
          (model) => model.id === request.model && model.supportsAttachments === true,
        )
      ) {
        yield {
          type: 'error',
          error: 'Freebuff cannot verify image support for this CLI model selection.',
        };
        return;
      }

      const selection = parseModelSelection(request.model);
      const account = selection.profileDir
        ? this.deps
            .discoverAccounts()
            .find((item) => resolve(item.profileDir) === resolve(selection.profileDir!))
        : this.deps.discoverAccounts()[0];
      if (!account) {
        yield {
          type: 'error',
          error: 'Freebuff CLI account no longer exists. Run "freebuff login" and reconnect.',
        };
        return;
      }
      const sourceBinary = this.deps.findBinary(account.profileDir);
      if (!sourceBinary) {
        yield {
          type: 'error',
          error:
            'Freebuff native launcher is missing. Run the freebuff installer once, then reconnect.',
        };
        return;
      }

      phase = 'private workspace setup';
      checkAbort(signal);
      runRoot = this.deps.createRunRoot();
      const runHome = join(runRoot, 'home');
      const workspace = join(runRoot, 'workspace');
      const privateTmp = join(runRoot, 'tmp');
      for (const dir of [runRoot, runHome, workspace, privateTmp, join(workspace, '.agents')]) {
        ensureManagedCliDirectory(dir);
      }

      const settingsTarget = join(runHome, '.config', 'manicode', 'settings.json');
      phase = 'CLI login access';
      try {
        // Modern CLI profiles reference Freebuff's own Keychain entry. Resolve
        // only that entry into this fresh 0600 per-turn copy, never into an SDK key.
        await this.deps.materializeCredentials({ profileDir: account.profileDir, runHome, signal });
      } catch {
        checkAbort(signal);
        throw new FreebuffPtyError(
          'Freebuff CLI login could not be prepared. Unlock the macOS login keychain and allow access to the Freebuff CLI item if prompted, or run "freebuff login" in the selected profile and retry.',
        );
      }
      phase = 'CLI model settings';
      const sourceSettings = join(account.profileDir, 'settings.json');
      const settings = existsSync(sourceSettings)
        ? JSON.parse(readFileSync(sourceSettings, 'utf8'))
        : {};
      writeManagedCliFile(
        settingsTarget,
        JSON.stringify(buildFreebuffTurnSettings(settings, selection.modelId)),
      );

      const role = request.harnessRole ?? 'manager';
      phase = 'bridge grant setup';
      lease = this.deps.createLease(request.sessionId, role);
      const bridge = this.deps.getBridge('freebuff');
      const bridgeContext = {
        provider: 'freebuff' as const,
        role,
        sandbox: request.sandbox,
        workingDirectory: request.workingDirectory?.trim() || process.cwd(),
        sessionId: request.sessionId,
        systemPrompt: request.systemPrompt,
        tools: request.tools ?? [],
        promptManifestHash: request.promptManifestHash,
        taskContractHash: request.taskContractHash,
        bridgeGrantLease: lease,
      };

      checkAbort(signal);
      phase = 'isolated runtime setup';
      runtime = await this.deps.createRuntime({
        runRoot,
        runHome,
        workspace,
        privateTmp,
        sourceBinary,
        // Inference always needs outbound network; native filesystem access remains confined.
        allowNetwork: true,
        env: buildProviderCliEnv(
          'freebuff',
          {
            HOME: runHome,
            USERPROFILE: runHome,
            XDG_CONFIG_HOME: join(runHome, '.config'),
            XDG_CACHE_HOME: join(runHome, '.cache'),
            XDG_DATA_HOME: join(runHome, '.local', 'share'),
            XDG_STATE_HOME: join(runHome, '.local', 'state'),
            TMPDIR: privateTmp,
            TERM: 'xterm-256color',
          },
          {},
        ),
      });
      checkAbort(signal);
      const tmux: FreebuffTmux = async (args) => {
        checkAbort(signal);
        const result = await runtime!.tmux(args);
        checkAbort(signal);
        return result;
      };
      const session = runtime.session;
      const buffer = `${session}-prompt`;
      phase = 'bridge staging';
      const servers = bridge?.buildMcpConfig(bridgeContext);
      if (!servers?.length)
        throw new FreebuffPtyError('Kory MCP bridge configuration is unavailable');
      prepared = await this.deps.prepareBridge({
        runRoot,
        servers,
        bunBinary: runtime.bunBinary,
        runtimeKind: runtime.kind,
        hostGateway: runtime.hostGateway,
        signal,
      });
      checkAbort(signal);
      writeManagedCliFile(
        join(workspace, '.agents', 'mcp.json'),
        JSON.stringify(serializeKoryMcpServers(prepared.servers), null, 2),
      );
      const rules = bridge?.buildRules(bridgeContext) ?? [];
      for (const rule of rules) {
        const target = join(workspace, basename(rule.path));
        writeManagedCliFile(target, rule.content);
      }
      const agentConfig = bridge?.buildAgentConfig(bridgeContext);
      const transportPrompt = [
        ...(agentConfig?.systemInstructions ?? []),
        'The connected Kory MCP server tools/list catalog defines available tools. Native Freebuff tools affect only this disposable transport workspace; use Kory MCP tools for the actual session workspace.',
        turn.prompt,
      ]
        .filter(Boolean)
        .join('\n\n');
      const promptPath = join(runRoot, 'prompt.txt');
      writeManagedCliFile(promptPath, transportPrompt);
      const imagePaths = materializeFreebuffImages(turn.images, workspace);

      phase = 'bridge catalog readiness';
      await runtime.exec(runtime.bunBinary, prepared.probeArgs, { timeout: 35_000 });
      checkAbort(signal);
      phase = 'TUI startup';
      await runtime.start(freebuffPrivateCliArgs(runRoot, workspace));
      await waitForFreebuffStartup(tmux, session, signal);
      phase = 'prompt submission';
      // Freebuff removes its old /image slash command from the free surface,
      // but its real OpenTUI paste handler accepts a single existing image
      // path, processes it, and adds a native pending image. Drive that path
      // through tmux, then wait until its own `processing…` state clears before
      // submitting the text prompt.
      for (let index = 0; index < imagePaths.length; index += 1) {
        const imagePath = imagePaths[index]!;
        const pathInput = join(runRoot, `image-path-${index + 1}.txt`);
        // The TUI resolves pasted paths against --cwd. A basename avoids any
        // mismatch between host and bubblewrap mount prefixes.
        writeManagedCliFile(pathInput, basename(imagePath));
        await tmux(['load-buffer', '-b', buffer, pathInput]);
        await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', session]);
        const filename = basename(imagePath);
        await waitForFreebuffImageReady(tmux, session, filename, signal);
      }
      await tmux(['load-buffer', '-b', buffer, promptPath]);
      await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', session]);
      await tmux(['send-keys', '-t', session, 'Enter']);

      // The modern CLI can lazily discover MCP tools while constructing the
      // first agent request. Preflight the signed catalog before submission,
      // but wait for actual CLI bridge startup afterward to avoid a deadlock.
      // No completion/content is published until this additional proof exists.
      phase = 'CLI MCP startup';
      const bridgeStartedAt = Date.now();
      while (!existsSync(prepared.readyPath)) {
        checkAbort(signal);
        if (Date.now() - bridgeStartedAt > 30_000) {
          throw new FreebuffPtyError('Freebuff TUI did not load the Kory MCP bridge');
        }
        await tmux(['has-session', '-t', session]);
        await waitForFreebuffPoll(250, signal);
      }

      const logsRoot = join(runHome, '.config', 'manicode', 'projects');
      const offsets = new Map<string, number>();
      const emittedTools = new Set<string>();
      phase = 'turn completion';
      let selectedModel: string | null = null;
      const usageByModel = new Map<string, number[]>();
      let emittedContent = false;
      let complete = false;
      let lastSessionCheck = 0;
      let verifiedImageCount = imagePaths.length === 0;
      const usage: FreebuffLogUsage = {
        finalContextTokens: 0,
        inputTokensProcessed: 0,
        requestCount: 0,
        requestInputTokens: [],
      };

      while (!complete) {
        checkAbort(signal);
        if (Date.now() - lastSessionCheck > 1_000) {
          lastSessionCheck = Date.now();
          try {
            await tmux(['has-session', '-t', session]);
          } catch {
            checkAbort(signal);
            throw new FreebuffPtyError('Freebuff TUI exited before producing a completion event');
          }
        }
        const rows = await this.deps.readLogRows(runtime, logsRoot, offsets);
        checkAbort(signal);
        for (const row of rows) {
          const msg = typeof row.msg === 'string' ? row.msg : '';
          const data =
            row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
          const loggedModel = typeof data.model === 'string' ? data.model : '';
          const requestContextTokens = freebuffUsageFromLogRow(row, loggedModel);
          if (loggedModel && requestContextTokens !== null) {
            const samples = usageByModel.get(loggedModel) ?? [];
            samples.push(requestContextTokens);
            usageByModel.set(loggedModel, samples);
          }
          const rootModel = freebuffSelectedModelFromLogRow(row);
          if (rootModel) {
            if (
              selection.modelId !== FREEBUFF_CLI_DEFAULT_MODEL_ID &&
              rootModel !== selection.modelId
            ) {
              throw new FreebuffPtyError(
                'Freebuff CLI did not use the requested model; refresh models and reconnect',
              );
            }
            selectedModel = rootModel;
          }
          const completion = freebuffCompletionFromLogRow(row);
          if (completion === 'error')
            throw new FreebuffPtyError('Freebuff main prompt returned an error or no output');
          if (msg === '[send-message] Sending message with sdk run config') {
            const runConfig =
              data.runConfig && typeof data.runConfig === 'object'
                ? (data.runConfig as Record<string, unknown>)
                : {};
            const contentBlockCount = Number(runConfig.contentBlockCount);
            if (imagePaths.length > 0 && contentBlockCount !== imagePaths.length) {
              throw new FreebuffPtyError(
                'Freebuff TUI did not submit the expected image content blocks',
              );
            }
            if (contentBlockCount === imagePaths.length) verifiedImageCount = true;
          }
          const response =
            rootModel && typeof data.fullResponse === 'string' ? data.fullResponse : '';
          if (response.trim()) {
            emittedContent = true;
            yield { type: 'content_delta', content: response };
          }
          const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
          const results = Array.isArray(data.toolResults) ? data.toolResults : [];
          for (const rawCall of calls) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as Record<string, unknown>;
            const callId = String(call.toolCallId ?? '');
            if (!callId || emittedTools.has(callId)) continue;
            emittedTools.add(callId);
            const result = results.find(
              (item) =>
                item &&
                typeof item === 'object' &&
                String((item as Record<string, unknown>).toolCallId ?? '') === callId,
            ) as Record<string, unknown> | undefined;
            const rawToolName = String(call.toolName ?? 'freebuff_tool');
            yield {
              type: 'tool_executed',
              toolCallId: callId,
              toolName: rawToolName.startsWith('kory__')
                ? rawToolName
                : `freebuff_sandbox__${rawToolName}`,
              toolInput: stringifyToolResult(call.input ?? {}),
              toolOutput: stringifyToolResult(result?.content ?? ''),
              isError: Boolean(result?.isError),
            };
          }
          if (completion === 'success') complete = true;
        }
        if (!complete) await waitForFreebuffPoll(250, signal);
      }
      checkAbort(signal);
      if (!selectedModel)
        throw new FreebuffPtyError(
          'Freebuff did not verify the main agent model in its completion log',
        );
      if (!verifiedImageCount)
        throw new FreebuffPtyError(
          'Freebuff TUI did not report native image content for this turn',
        );
      // Never treat a stale run-state or a nested agent response as a successful empty root turn.
      if (!emittedContent)
        throw new FreebuffPtyError('Freebuff main prompt completed without a text response');
      usage.requestInputTokens = usageByModel.get(selectedModel) ?? [];
      usage.requestCount = usage.requestInputTokens.length;
      usage.finalContextTokens = usage.requestInputTokens.at(-1) ?? 0;
      usage.inputTokensProcessed = usage.requestInputTokens.reduce((sum, value) => sum + value, 0);
      if (usage.finalContextTokens > 0) {
        yield {
          type: 'usage_update',
          // This is the real final context occupancy reported in Freebuff's
          // own request log, so Kory's context meter can use it directly.
          tokensIn: usage.finalContextTokens,
          tokensOut: 0,
          // Billing needs all selected-model requests made during the agentic
          // turn, not only the final context. Output usage is not present in
          // Freebuff's log and therefore remains explicitly unknown.
          billingTokensIn: usage.inputTokensProcessed,
          billingTokensOut: 0,
          billingUsageSamples: usage.requestInputTokens.map((tokensIn) => ({
            tokensIn,
            tokensOut: 0,
          })),
          usagePrecision: 'input-context-only',
          accountId: account.id,
        };
      }
      yield { type: 'complete', finishReason: 'end_turn' };
    } catch (err: unknown) {
      const aborted = signal.aborted || (err instanceof Error && err.name === 'AbortError');
      yield {
        type: 'error',
        error:
          timeout.signal.aborted && !request.signal?.aborted
            ? 'Freebuff PTY turn exceeded its runtime limit.'
            : aborted
              ? 'Freebuff PTY turn cancelled.'
              : err instanceof FreebuffPtyError
                ? err.message
                : `Freebuff PTY failed during ${phase}. No private diagnostic output was retained.`,
        errorTransient: !aborted && isTransientStreamErrorText(err),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Each cleanup is independent: one failure must not retain copied credentials or live grants.
      try {
        await stopRuntime();
      } catch {
        providerLog.warn({ provider: 'freebuff' }, 'Freebuff private runtime cleanup failed');
      }
      try {
        await prepared?.cleanup();
      } catch {
        providerLog.warn({ provider: 'freebuff' }, 'Freebuff staged bridge cleanup failed');
      }
      try {
        lease?.cleanup();
      } catch {
        providerLog.warn({ provider: 'freebuff' }, 'Freebuff bridge grant cleanup failed');
      }
      if (runRoot) {
        try {
          rmSync(runRoot, { recursive: true, force: true });
        } catch {
          providerLog.warn({ provider: 'freebuff' }, 'Freebuff private run cleanup failed');
        }
      }
    }
  }
}
