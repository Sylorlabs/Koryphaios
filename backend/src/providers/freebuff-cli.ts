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

import type { ModelDef, ProviderConfig, SandboxPolicy } from '@koryphaios/shared';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { providerLog } from '../logger';
import { sandboxCapabilities, wrapCommand } from '../collaboration/sandbox-runner';
import { PROJECT_ROOT } from '../runtime/paths';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { buildProviderCliEnv } from './cli-environment';
import { getCliBridge } from './cli-bridges';
import { serializeKoryMcpServers } from './kory-cli-mcp-config';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import { createGenericModel } from './models';
import { discoverFreebuffAccounts, type FreebuffAccount } from './auth-utils';
import {
  discoverFreebuffBundledCatalog,
  type FreebuffBundledCatalog,
} from './freebuff-bundled-catalog';
import type { Provider, ProviderEvent, ProviderMessage, StreamRequest } from './types';

const execFileAsync = promisify(execFile);
const ACCOUNT_PREFIX = 'freebuff-account:';
const MAX_RUNTIME_MS = 9 * 60_000;

export const FREEBUFF_PTY_UNAVAILABLE_ERROR =
  'Freebuff requires its real logged-in CLI plus tmux and bubblewrap on Linux. Run "freebuff login", ensure tmux/bwrap are installed, and reconnect.';

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

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, bin);
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
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
    // Installed Freebuff 0.0.162 clips attachment-card labels more narrowly
    // than its current source. Keep the transport basename deliberately short
    // so readiness can be matched exactly instead of guessing at TUI clipping.
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

function findLogFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'log.jsonl') found.push(path);
    }
  };
  visit(root);
  return found;
}

async function tmux(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync('tmux', args, {
    env,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function waitForPane(
  session: string,
  predicate: (pane: string) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const startedAt = Date.now();
  let lastPane = '';
  let emptyCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastPane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
    } catch {
      await wait(250, signal);
      continue;
    }
    if (!lastPane.trim()) {
      emptyCount += 1;
      if (emptyCount < 4) {
        await wait(500, signal);
        continue;
      }
    } else {
      emptyCount = 0;
    }
    if (predicate(lastPane)) return lastPane;
    await wait(250, signal);
  }
  throw new Error(`Freebuff TUI did not reach the expected state: ${lastPane.slice(-500)}`);
}

async function waitForFreebuffImageReady(
  session: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  let lastPane = '';
  while (Date.now() - startedAt < 30_000) {
    lastPane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
    const filenameIndex = lastPane.indexOf(filename);
    if (filenameIndex >= 0) {
      const attachmentRegion = lastPane.slice(
        Math.max(0, filenameIndex - 500),
        Math.min(lastPane.length, filenameIndex + filename.length + 500),
      );
      if (attachmentRegion.includes('❌')) {
        throw new Error(`Freebuff TUI rejected attached image ${filename}`);
      }
      if (!attachmentRegion.includes('processing…') && !attachmentRegion.includes('processing...'))
        return;
    }
    await wait(250, signal);
  }
  throw new Error(
    `Freebuff TUI did not finish attaching image ${filename}: ${lastPane.slice(-500)}`,
  );
}

function catalogRevision(accounts: FreebuffAccount[]): string | null {
  try {
    return accounts
      .map((account) => {
        const binary = nativeFreebuffBinary(account.profileDir);
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

export class FreebuffProvider implements Provider {
  readonly name = 'freebuff' as const;
  private models: ModelDef[] = [];
  private modelDiscoveryError: string | undefined;
  private refreshInFlight: Promise<ModelDef[]> | null = null;
  private loadedCatalogRevision: string | null = null;

  constructor(readonly config: ProviderConfig) {
    if (this.isAvailable()) void this.refreshModels();
  }

  isAvailable(): boolean {
    if (this.config.disabled || process.platform !== 'linux') return false;
    if (!which('tmux') || !sandboxCapabilities().osIsolation) return false;
    return discoverFreebuffAccounts().some(
      (account) =>
        existsSync(join(account.profileDir, 'credentials.json')) &&
        nativeFreebuffBinary(account.profileDir) !== null,
    );
  }

  listModels(): ModelDef[] {
    const accounts = discoverFreebuffAccounts();
    const revision = catalogRevision(accounts);
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
    const accounts = discoverFreebuffAccounts();
    const revision = catalogRevision(accounts);
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
        const binary = nativeFreebuffBinary(account.profileDir);
        if (!binary) throw new Error(`Freebuff executable is missing for ${account.label}`);
        return {
          account,
          catalog: await discoverFreebuffBundledCatalog(binary),
        };
      }),
    )
      .then((results) => {
        const failures: string[] = [];
        const loaded = results.flatMap((result) => {
          if (result.status === 'rejected') {
            failures.push(
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            );
            return [];
          }
          return accountCatalogModels(
            result.value.account,
            result.value.catalog,
            accounts.length > 1,
          );
        });
        const currentRevision = catalogRevision(accounts);
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

    const availableModels = await this.refreshModels();
    const requestedSelection = parseModelSelection(request.model);
    if (
      !availableModels.some(
        (model) =>
          model.apiModelId === requestedSelection.modelId &&
          (!requestedSelection.profileDir ||
            model.accountId ===
              discoverFreebuffAccounts().find(
                (account) =>
                  resolve(account.profileDir) === resolve(requestedSelection.profileDir!),
              )?.id),
      )
    ) {
      yield {
        type: 'error',
        error:
          this.modelDiscoveryError ??
          `Freebuff model ${requestedSelection.modelId} is not in the installed CLI picker catalog. Refresh models or choose another model.`,
      };
      return;
    }

    let turn: FreebuffPtyTurn;
    try {
      turn = buildFreebuffPtyTurn(request.systemPrompt, request.messages);
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: `Freebuff PTY failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      return;
    }
    if (!turn.prompt.trim()) {
      yield { type: 'error', error: 'Freebuff: empty prompt' };
      return;
    }

    const selection = parseModelSelection(request.model);
    const account = selection.profileDir
      ? discoverFreebuffAccounts().find(
          (item) => resolve(item.profileDir) === resolve(selection.profileDir!),
        )
      : discoverFreebuffAccounts()[0];
    if (!account) {
      yield {
        type: 'error',
        error: 'Freebuff CLI account no longer exists. Run "freebuff login" and reconnect.',
      };
      return;
    }
    const sourceBinary = nativeFreebuffBinary(account.profileDir);
    if (!sourceBinary) {
      yield {
        type: 'error',
        error:
          'Freebuff native launcher is missing. Run the freebuff installer once, then reconnect.',
      };
      return;
    }

    const runId = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const runRoot = join(homedir(), '.koryphaios', 'freebuff-runs', runId);
    const runHome = join(runRoot, 'home');
    const workspace = join(runRoot, 'workspace');
    const runBin = join(runRoot, 'bin');
    const privateTmp = join(runRoot, 'tmp');
    for (const dir of [
      runRoot,
      runHome,
      workspace,
      runBin,
      privateTmp,
      join(workspace, '.agents'),
    ]) {
      ensureManagedCliDirectory(dir);
    }

    const copiedBinary = join(runBin, 'freebuff');
    const credentialsTarget = join(runHome, '.config', 'manicode', 'credentials.json');
    const settingsTarget = join(runHome, '.config', 'manicode', 'settings.json');
    ensureManagedCliDirectory(dirname(credentialsTarget));
    copyFileSync(sourceBinary, copiedBinary);
    chmodSync(copiedBinary, 0o700);
    writeManagedCliFile(
      credentialsTarget,
      readFileSync(join(account.profileDir, 'credentials.json')),
    );
    writeManagedCliFile(
      settingsTarget,
      JSON.stringify({ freebuffModel: selection.modelId }, null, 2),
    );

    const role = request.harnessRole ?? 'manager';
    const lease = createKoryBridgeGrantLease(request.sessionId, role);
    const bridge = getCliBridge('freebuff');
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

    let session = '';
    let buffer = '';
    try {
      const servers = bridge?.buildMcpConfig(bridgeContext);
      if (!servers?.length) throw new Error('Kory MCP bridge configuration is unavailable');

      // Keep the grant inside the one mounted private root. The backend validates
      // the grant's secret/id against its in-memory lease, not its original path.
      for (const server of servers) {
        const grantSource = server.env?.KORY_BRIDGE_AUTH_FILE;
        if (!grantSource) throw new Error('Kory MCP bridge grant is missing');
        const grantTarget = join(runRoot, `bridge-${server.name}.json`);
        writeManagedCliFile(grantTarget, readFileSync(grantSource));
        server.env = { ...server.env, KORY_BRIDGE_AUTH_FILE: grantTarget };
      }
      writeManagedCliFile(
        join(workspace, '.agents', 'mcp.json'),
        JSON.stringify(serializeKoryMcpServers(servers), null, 2),
      );
      const rules = bridge?.buildRules(bridgeContext) ?? [];
      for (const rule of rules) {
        const target = join(workspace, basename(rule.path));
        writeManagedCliFile(target, rule.content);
      }
      const agentConfig = bridge?.buildAgentConfig(bridgeContext);
      const authoritativeTools = agentConfig?.allowedTools?.join(', ') ?? '';
      const transportPrompt = [
        ...(agentConfig?.systemInstructions ?? []),
        authoritativeTools
          ? `Authoritative Kory MCP catalog for this role: ${authoritativeTools}`
          : '',
        turn.prompt,
      ]
        .filter(Boolean)
        .join('\n\n');
      const promptPath = join(runRoot, 'prompt.txt');
      writeManagedCliFile(promptPath, transportPrompt);
      const imagePaths = materializeFreebuffImages(turn.images, workspace);

      const runtimePolicy: SandboxPolicy = {
        preset: 'custom',
        filesystemIsolation: true,
        allowNetwork: request.sandbox?.allowNetwork !== false,
        allowShell: true,
        allowEdits: true,
        allowWebSearch: request.sandbox?.allowWebSearch !== false,
        commandBlocklist: request.sandbox?.commandBlocklist ?? [],
        maxRuntimeSeconds: Math.min(
          MAX_RUNTIME_MS / 1000,
          request.sandbox?.maxRuntimeSeconds || MAX_RUNTIME_MS / 1000,
        ),
      };
      const readonlyRuntimeDirs = [...new Set([PROJECT_ROOT, dirname(process.execPath)])];
      const wrapped = wrapCommand(copiedBinary, ['--cwd', workspace], {
        cwd: workspace,
        homeDir: runHome,
        configDirs: [runRoot],
        readonlyConfigDirs: readonlyRuntimeDirs,
        policy: runtimePolicy,
      });
      if (!wrapped.isolated) throw new Error('Freebuff refused to run without OS isolation');

      session = `kory-freebuff-${process.pid}-${randomBytes(6).toString('hex')}`;
      buffer = `${session}-prompt`;
      const childEnv = buildProviderCliEnv('freebuff', {
        HOME: runHome,
        USERPROFILE: runHome,
        XDG_CONFIG_HOME: join(runHome, '.config'),
        XDG_CACHE_HOME: join(runHome, '.cache'),
        XDG_DATA_HOME: join(runHome, '.local', 'share'),
        XDG_STATE_HOME: join(runHome, '.local', 'state'),
        TMPDIR: privateTmp,
        TERM: 'xterm-256color',
      });
      await tmux(
        [
          'new-session',
          '-d',
          '-s',
          session,
          '-x',
          '180',
          '-y',
          '50',
          '--',
          wrapped.command,
          ...wrapped.args,
        ],
        childEnv,
      );
      let pane = await waitForPane(
        session,
        (screen) =>
          /start coding for free|freebuff is already running|continue|freebuff|buffy|what would you like/i.test(
            screen,
          ) || screen.trim().length > 100,
        45_000,
        request.signal,
      );
      if (/freebuff is already running/i.test(pane)) {
        await tmux(['send-keys', '-t', session, 'Enter']);
        pane = await waitForPane(
          session,
          (screen) => !/freebuff is already running/i.test(screen),
          30_000,
          request.signal,
        );
      }
      if (/start coding for free|continue/i.test(pane)) {
        await tmux(['send-keys', '-t', session, 'Enter']);
        await waitForPane(
          session,
          (screen) => !/start coding for free/i.test(screen),
          30_000,
          request.signal,
        );
      }
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
        await waitForFreebuffImageReady(session, filename, request.signal);
      }
      await tmux(['load-buffer', '-b', buffer, promptPath]);
      await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', session]);
      await tmux(['send-keys', '-t', session, 'Enter']);

      const logsRoot = join(runHome, '.config', 'manicode', 'projects');
      const offsets = new Map<string, number>();
      const emittedTools = new Set<string>();
      const startedAt = Date.now();
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
        if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (Date.now() - startedAt > runtimePolicy.maxRuntimeSeconds * 1000) {
          throw new Error('Freebuff PTY turn exceeded its runtime limit');
        }
        if (Date.now() - lastSessionCheck > 1_000) {
          lastSessionCheck = Date.now();
          try {
            await tmux(['has-session', '-t', session]);
          } catch {
            throw new Error('Freebuff TUI exited before producing a completion event');
          }
        }
        for (const logPath of findLogFiles(logsRoot)) {
          const text = readFileSync(logPath, 'utf8');
          const previous = offsets.get(logPath) ?? 0;
          if (text.length <= previous) continue;
          const chunk = text.slice(previous);
          const lastNewline = chunk.lastIndexOf('\n');
          if (lastNewline < 0) continue;
          offsets.set(logPath, previous + lastNewline + 1);
          for (const line of chunk.slice(0, lastNewline).split('\n')) {
            let row: Record<string, unknown>;
            try {
              row = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            const msg = typeof row.msg === 'string' ? row.msg : '';
            const data =
              row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
            const requestContextTokens = freebuffUsageFromLogRow(row, selection.modelId);
            if (requestContextTokens !== null) {
              usage.finalContextTokens = requestContextTokens;
              usage.inputTokensProcessed += requestContextTokens;
              usage.requestCount += 1;
              usage.requestInputTokens.push(requestContextTokens);
            }
            if (msg === '[send-message] Sending message with sdk run config') {
              const runConfig =
                data.runConfig && typeof data.runConfig === 'object'
                  ? (data.runConfig as Record<string, unknown>)
                  : {};
              const contentBlockCount = Number(runConfig.contentBlockCount);
              if (imagePaths.length > 0 && contentBlockCount !== imagePaths.length) {
                throw new Error(
                  `Freebuff TUI reported ${contentBlockCount || 0} image content blocks; expected ${imagePaths.length}`,
                );
              }
              if (contentBlockCount === imagePaths.length) verifiedImageCount = true;
            }
            const response = typeof data.fullResponse === 'string' ? data.fullResponse : '';
            if (response) {
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
            if (data.shouldEndTurn === true || msg === 'Main prompt finished') complete = true;
          }
        }
        if (!complete) await wait(250, request.signal);
      }
      if (!verifiedImageCount) {
        throw new Error('Freebuff TUI did not report native image content for this turn');
      }
      if (!emittedContent) {
        const statePath = findLogFiles(logsRoot)[0]?.replace(/log\.jsonl$/, 'run-state.json');
        if (statePath && existsSync(statePath)) {
          const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
          const last = typeof state.lastMessage === 'string' ? state.lastMessage : '';
          if (last) yield { type: 'content_delta', content: last };
        }
      }
      if (usage.finalContextTokens > 0) {
        yield {
          type: 'usage_update',
          // This is the real final context occupancy reported in Freebuff's
          // own request log, so Kory's context meter can use it directly.
          tokensIn: usage.finalContextTokens,
          tokensOut: 0,
          // Billing needs all selected-model requests made during the agentic
          // turn, not only the final context. Output usage is not present in
          // Freebuff 0.0.162's log and therefore remains explicitly unknown.
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
      const aborted =
        request.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
      yield {
        type: 'error',
        error: aborted
          ? 'Freebuff PTY turn cancelled.'
          : `Freebuff PTY failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (session) {
        try {
          await tmux(['send-keys', '-t', session, 'Escape']);
          await tmux(['kill-session', '-t', session]);
        } catch {
          providerLog.debug({ provider: 'freebuff' }, 'Freebuff tmux session already exited');
        }
      }
      if (buffer) {
        try {
          await tmux(['delete-buffer', '-b', buffer]);
        } catch {
          // paste-buffer -d usually removed it already.
        }
      }
      lease.cleanup();
      try {
        rmSync(runRoot, { recursive: true, force: true });
      } catch (err: unknown) {
        providerLog.warn({ err }, 'Freebuff private run cleanup failed');
      }
    }
  }
}
