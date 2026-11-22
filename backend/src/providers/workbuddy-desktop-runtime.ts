// WorkBuddy Desktop runtime — locates the installed WorkBuddy AI desktop app
// and drives its local host-runtime layer.
//
// This is NOT the standalone `codebuddy` CLI on PATH. The WorkBuddy AI desktop
// app (com.workbuddy.workbuddy-ai) is an Electron application that hosts its
// own agent runtime: a sidecar process (sidecar-entry.js) manages PTY
// sessions, and the host runtime is the bundled CodeBuddy CLI started in
// `--serve` mode, which exposes an ACP (Agent Client Protocol) endpoint over
// HTTP SSE at /api/v1/acp. The desktop app spawns that runtime with its own
// env context (ELECTRON_RUN_AS_NODE, the app's Electron binary as the Node
// runtime, CODEBUDDY_FORCE_LITE_WB_BUNDLE, connector tokens, user settings
// sources) — that context is what carries the desktop app's auth and limits,
// which differ from the standalone CLI's.
//
// This module replicates the desktop app's own spawn recipe so a Koryphaios
// turn runs on the desktop runtime, and additionally speaks the sidecar's
// JSON-RPC control protocol when a desktop sidecar is already running (attach
// mode: reuse the desktop's own session manager instead of spawning a second
// runtime).
//
// Layouts (verified against WorkBuddy AI 5.8.4 on macOS arm64):
//   macOS:   <app>/Contents/MacOS/Electron                 (runtime)
//            <app>/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
//            <app>/Contents/Resources/app.asar.unpacked/cli/product.json
//   Windows: <app>/WorkBuddy AI.exe                        (runtime)
//            <app>/resources/app.asar.unpacked/cli/bin/codebuddy
//   Linux:   <app>/workbuddy-ai                            (runtime)
//            <app>/resources/app.asar.unpacked/cli/bin/codebuddy

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket, type Server } from 'node:net';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { hostOS } from '../runtime/platform';
import { providerLog } from '../logger';
import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { productModelCreditLabel, productModelDisplayNames } from './product-model-names';
import {
  supportedProductContextWindows,
  vendorDefaultContextWindow,
} from './product-context-window';

export const WORKBUDDY_DESKTOP_APP_NAME = 'WorkBuddy Desktop';

const RUNTIME_START_TIMEOUT_MS = 60_000;
const RUNTIME_POLL_INTERVAL_MS = 250;
const SIDECAR_CONNECT_TIMEOUT_MS = 5_000;

// ── App discovery ───────────────────────────────────────────────────────────

export interface WorkBuddyDesktopApp {
  /** Absolute path to the .app / install root. */
  appPath: string;
  /** Host OS the layout belongs to. */
  os: 'darwin' | 'linux' | 'win32';
}

/** Narrow NodeJS.Platform to the supported desktop hosts; anything else
 *  (aix, freebsd, …) has no WorkBuddy AI build. */
function supportedHostOS(): 'darwin' | 'linux' | 'win32' | null {
  const os = hostOS();
  return os === 'darwin' || os === 'linux' || os === 'win32' ? os : null;
}

function macAppCandidates(): string[] {
  const roots = ['/Applications', join(homedir(), 'Applications')];
  const names = ['WorkBuddy AI.app', 'WorkBuddy.app'];
  const out: string[] = [];
  for (const root of roots) for (const name of names) out.push(join(root, name));
  return out;
}

function windowsAppCandidates(): string[] {
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const out: string[] = [];
  for (const root of [programFiles, programFilesX86, join(localAppData, 'Programs')]) {
    out.push(join(root, 'WorkBuddy AI'), join(root, 'WorkBuddy'));
  }
  return out;
}

function linuxAppCandidates(): string[] {
  const out: string[] = [];
  for (const root of ['/opt', '/usr/share', '/usr/local/share', join(homedir(), 'Applications')]) {
    out.push(join(root, 'WorkBuddy AI'), join(root, 'workbuddy-ai'), join(root, 'workbuddy'));
  }
  return out;
}

/**
 * Locate the installed WorkBuddy AI desktop app. `WORKBUDDY_DESKTOP_APP_PATH`
 * pins an explicit install root for non-standard installs (or tests). The
 * candidate roots are checked in order and the first one whose expected
 * runtime binary exists wins; a directory that exists without the runtime is
 * skipped so a half-uninstalled app does not shadow a real install.
 */
export function locateWorkBuddyDesktopApp(): WorkBuddyDesktopApp | null {
  const os = supportedHostOS();
  if (!os) return null;
  const override = process.env.WORKBUDDY_DESKTOP_APP_PATH?.trim();
  if (override) {
    const appPath = resolve(override);
    if (looksLikeInstallRoot(appPath, os)) return { appPath, os };
    return null;
  }
  const candidates =
    os === 'darwin'
      ? macAppCandidates()
      : os === 'win32'
        ? windowsAppCandidates()
        : linuxAppCandidates();
  for (const appPath of candidates) {
    if (looksLikeInstallRoot(appPath, os)) return { appPath, os };
  }
  return null;
}

function looksLikeInstallRoot(appPath: string, os: 'darwin' | 'linux' | 'win32'): boolean {
  if (!existsSync(appPath)) return false;
  const runtime = os === 'darwin' ? join(appPath, 'Contents', 'MacOS', 'Electron') : null;
  if (runtime) return existsSync(runtime);
  // Windows / Linux: the executable lives directly in the install root.
  try {
    const entries = readdirSafe(appPath);
    return entries.some((entry) =>
      os === 'win32' ? /^workbuddy.*\.exe$/i.test(entry) : /^workbuddy(?:-ai)?$/i.test(entry),
    );
  } catch {
    return false;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── Runtime resolution ──────────────────────────────────────────────────────

export interface WorkBuddyDesktopRuntimePaths {
  /** The Electron binary used as the Node runtime (ELECTRON_RUN_AS_NODE=1). */
  electronBin: string;
  /** The bundled CLI entry script. */
  cliBin: string;
  /** Directory containing the CLI (its product.json lives here). */
  cliDir: string;
  /** The desktop app's config dir (WORKBUDDY_CONFIG_DIR). */
  configDir: string;
  /** App version, when readable. */
  version: string | null;
}

export function resolveWorkBuddyDesktopRuntime(
  app: WorkBuddyDesktopApp,
): WorkBuddyDesktopRuntimePaths | null {
  let electronBin: string;
  let resourcesDir: string;
  if (app.os === 'darwin') {
    electronBin = join(app.appPath, 'Contents', 'MacOS', 'Electron');
    resourcesDir = join(app.appPath, 'Contents', 'Resources');
  } else {
    // Windows: <root>\WorkBuddy AI.exe ; Linux: <root>/workbuddy-ai
    const exe = readdirSafe(app.appPath).find(
      (entry) => /^workbuddy.*\.exe$/i.test(entry) || /^workbuddy-?ai$/i.test(entry),
    );
    if (!exe) return null;
    electronBin = join(app.appPath, exe);
    resourcesDir = join(app.appPath, 'resources');
  }
  const cliBin = join(resourcesDir, 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
  if (!existsSync(electronBin) || !existsSync(cliBin)) return null;
  const configDir =
    process.env.WORKBUDDY_CONFIG_DIR?.trim() ||
    process.env.CODEBUDDY_CONFIG_DIR?.trim() ||
    join(homedir(), '.workbuddy-ai');
  return {
    electronBin,
    cliBin,
    cliDir: dirname(dirname(cliBin)),
    configDir,
    version: readDesktopVersion(app),
  };
}

function readDesktopVersion(app: WorkBuddyDesktopApp): string | null {
  try {
    if (app.os === 'darwin') {
      const plist = readFileSync(
        join(app.appPath, 'Contents', 'Info.plist'),
        'utf-8',
      );
      const match = plist.match(
        /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
      );
      return match?.[1] ?? null;
    }
    const pkg = join(app.appPath, 'resources', 'app.asar.unpacked', 'cli', 'package.json');
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, 'utf-8')) as {
        publishConfig?: { customPackage?: { version?: string } };
        version?: string;
      };
      return parsed.publishConfig?.customPackage?.version ?? parsed.version ?? null;
    }
  } catch {
    /* version is best-effort */
  }
  return null;
}

// ── Model catalog from the bundled product.json ────────────────────────────

interface ProductModelEntry {
  id?: unknown;
  name?: unknown;
  /** Vendor's own price label (e.g. "x0.00 credits"). */
  credits?: unknown;
  /** Selectable context tiers reported by the app's bundled catalog. */
  contextWindow?: {
    supportedLengths?: unknown;
    defaultLength?: unknown;
  } | null;
  maxInputTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsToolCall?: unknown;
  supportsImages?: unknown;
  supportsReasoning?: unknown;
  onlyReasoning?: unknown;
  isDefault?: unknown;
  reasoning?: {
    effort?: unknown;
    defaultEffort?: unknown;
    supportedEfforts?: unknown;
    canDisableThinking?: unknown;
  };
}

/**
 * Map the runtime's product.json model catalog to ModelDefs. Pure function —
 * the product file path is the caller's business, which keeps this testable
 * without a real app install (mirrors CodeBuddyProvider.modelsFromProductJson).
 *
 * The reasoning ladder comes from the runtime's own per-model data:
 * `reasoning.supportedEfforts` is the effort ladder the runtime reports, and
 * `reasoning.canDisableThinking !== false` adds the off position — the same
 * values the runtime's `thought_level` session config option offers over ACP.
 * Models with a fixed effort and no ladder report none (no picker).
 */
export function modelsFromWorkBuddyProductJson(parsed: unknown): ModelDef[] {
  const models = (parsed as { models?: ProductModelEntry[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  const usable = models
    .map((entry) => ({
      entry,
      id: typeof entry.id === 'string' ? entry.id.trim() : '',
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
    }))
    .filter(({ id, name }) => !!id && !!name);
  // The bundled product.json reuses display names for distinct model ids:
  // WorkBuddy AI 5.9.4 ships two "Deepseek-V4.1-Flash" entries, one free and
  // one at "x0.03 credits". Every other reported field is identical, so the
  // name alone cannot tell a user what they are choosing. Append the app's
  // own distinguishing data instead.
  const displayNames = productModelDisplayNames(
    usable.map(({ id, name, entry }) => ({
      id,
      name,
      credits: typeof entry.credits === 'string' ? entry.credits : undefined,
    })),
  );
  const out: ModelDef[] = [];
  usable.forEach(({ entry, id }, index) => {
    const name = displayNames[index];
    const creditsLabel = productModelCreditLabel(
      typeof entry.credits === 'string' ? entry.credits : undefined,
    );
    const ctx =
      typeof entry.maxInputTokens === 'number' && entry.maxInputTokens > 0
        ? entry.maxInputTokens
        : 0;
    const contextOptions = supportedProductContextWindows(entry);
    const vendorDefault = vendorDefaultContextWindow(entry, contextOptions);
    const canReason = entry.supportsReasoning === true || entry.onlyReasoning === true;
    const reasoning = entry.reasoning;
    let reasoningLevels: string[] | undefined;
    if (canReason && reasoning && typeof reasoning === 'object') {
      const efforts = Array.isArray(reasoning.supportedEfforts)
        ? reasoning.supportedEfforts.filter(
            (level): level is string => typeof level === 'string' && level.length > 0,
          )
        : [];
      if (efforts.length > 0) {
        // The runtime's thought_level option offers an Off position exactly
        // when canDisableThinking is not explicitly false.
        const canDisable = reasoning.canDisableThinking !== false;
        reasoningLevels = canDisable ? ['off', ...efforts] : [...efforts];
      }
    }
    out.push({
      id: `workbuddy-desktop-${id}`,
      name: entry.isDefault === true ? `${name} (default)` : name,
      provider: 'workbuddy-desktop' as ProviderName,
      apiModelId: id,
      contextWindow: ctx,
      contextVerified: ctx > 0,
      ...(contextOptions.length >= 2 ? { contextWindowOptions: contextOptions } : {}),
      ...(contextOptions.length >= 2 && vendorDefault !== undefined
        ? { contextWindowVendorDefault: vendorDefault }
        : {}),
      maxOutputTokens:
        typeof entry.maxOutputTokens === 'number' && entry.maxOutputTokens > 0
          ? entry.maxOutputTokens
          : 0,
      canReason,
      ...(reasoningLevels ? { reasoningLevels } : {}),
      ...(creditsLabel ? { creditsLabel } : {}),
      vision: entry.supportsImages === true,
      functionCall: entry.supportsToolCall === true,
      supportsAttachments: entry.supportsImages === true,
      supportsStreaming: true,
      tier: entry.isDefault === true ? ('flagship' as const) : ('fast' as const),
    });
  });
  return out;
}

/**
 * The desktop runtime's model catalog ships in the bundled CLI's
 * `product.json` — the same file the runtime itself selects models from
 * (productName "WorkBuddy AI", platform "workbuddy-ai"). Reading it live (no
 * hardcoded list) means a desktop app update that changes the catalog is
 * picked up on the next refresh.
 */
export function readWorkBuddyDesktopModels(runtime: WorkBuddyDesktopRuntimePaths): ModelDef[] {
  const productFile = join(runtime.cliDir, 'product.json');
  if (!existsSync(productFile)) return [];
  try {
    return modelsFromWorkBuddyProductJson(JSON.parse(readFileSync(productFile, 'utf-8')));
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err), productFile },
      'workbuddy-desktop: failed to read product model catalog',
    );
    return [];
  }
}

// ── Sidecar control protocol (attach mode) ─────────────────────────────────

/** The sidecar runtime dir matches WorkBuddy's protocol.js layout:
 *  instanceToken = sha1(configDir)[0:12]; dir = tmpdir/wb-<uidHash>/<token>. */
export function sidecarRuntimeDir(configDir: string): string {
  const instanceToken = createHash('sha1').update(configDir).digest('hex').slice(0, 12);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const uidHash =
    uid === undefined
      ? 'wb'
      : `wb-${createHash('sha1').update(String(uid)).digest('hex').slice(0, 6)}`;
  if (hostOS() === 'linux') {
    const xdg = process.env.XDG_RUNTIME_DIR?.trim();
    if (xdg) return join(xdg, 'workbuddy', instanceToken);
    if (uid !== undefined) return join('/run/user', String(uid), 'workbuddy', instanceToken);
  }
  return join(tmpdir(), uidHash, instanceToken);
}

/**
 * Control-socket names the desktop sidecar has used. Older builds write
 * `sidecar-<uuid>.sock`; WorkBuddy AI 5.9.4 writes `s-<hash>.sock`
 * (`pidFilePath()`'s sibling in the app's own sidecar module). Matching only
 * the older name made `findRunningDesktopSidecar` return null on 5.9.4, which
 * silently downgraded every turn to an unauthenticated direct spawn — the
 * runtime then refused with "Authentication required".
 */
export function isSidecarControlSocketName(name: string): boolean {
  return /^sidecar-[0-9a-f-]+\.sock$/i.test(name) || /^s-[0-9a-f]+\.sock$/i.test(name);
}

export interface RunningSidecar {
  pid: number;
  controlSocketPath: string;
  runtimeDir: string;
}

/** Find a running WorkBuddy desktop sidecar via its PID file. The file is the
 *  sidecar's own JSON record (`{pid, token, version, controlPipeUuid, …}`);
 *  older builds may write a bare integer. Returns null when the desktop app is
 *  not running (or its PID file is stale). */
export function findRunningDesktopSidecar(configDir: string): RunningSidecar | null {
  const runtimeDir = sidecarRuntimeDir(configDir);
  const pidFile = join(runtimeDir, 'sidecar.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    let pid = Number.NaN;
    let controlPipeUuid: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; controlPipeUuid?: unknown };
      if (typeof parsed.pid === 'number') pid = parsed.pid;
      if (typeof parsed.controlPipeUuid === 'string') controlPipeUuid = parsed.controlPipeUuid;
    } catch {
      pid = Number.parseInt(raw, 10);
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
    // Liveness: kill(pid, 0) throws ESRCH when gone, EPERM when alive but
    // owned by another user — both non-ESRCH cases count as alive.
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return null;
    }
    // Prefer the exact control socket named by the PID record; fall back to
    // scanning for any live control socket in the runtime dir.
    let controlSocketPath: string | null = null;
    if (controlPipeUuid) {
      const named = join(runtimeDir, `sidecar-${controlPipeUuid}.sock`);
      if (existsSync(named)) controlSocketPath = named;
    }
    if (!controlSocketPath) {
      for (const entry of readdirSafe(runtimeDir)) {
        if (isSidecarControlSocketName(entry)) {
          controlSocketPath = join(runtimeDir, entry);
          break;
        }
      }
    }
    if (!controlSocketPath) return null;
    return { pid, controlSocketPath, runtimeDir };
  } catch {
    return null;
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal newline-delimited JSON-RPC 2.0 client for the sidecar control
 *  socket (one request per connection, matching how the desktop app itself
 *  multiplexes short-lived control connections). */
export class SidecarControlClient {
  private nextId = 1;

  constructor(private readonly socketPath: string) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`;
    return new Promise<T>((resolvePromise, reject) => {
      const socket: Socket = connect(this.socketPath);
      let settled = false;
      let buffer = '';
      const finish = (err: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolvePromise(value as T);
      };
      const timer = setTimeout(
        () => finish(new Error(`Sidecar request ${method} timed out`)),
        SIDECAR_CONNECT_TIMEOUT_MS,
      );
      timer.unref?.();
      socket.once('error', (err) => finish(err));
      socket.on('connect', () => socket.write(payload));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(buffer.slice(0, nl)) as JsonRpcResponse;
        } catch {
          return finish(new Error(`Sidecar returned non-JSON for ${method}`));
        }
        if (parsed.id !== id) return;
        if (parsed.error) return finish(new Error(parsed.error.message));
        finish(null, parsed.result as T);
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('sidecar.ping');
      return true;
    } catch {
      return false;
    }
  }
}

export interface SidecarSessionInfo {
  sessionId: string;
  acpEndpoint: string;
  pid?: number;
  runtimeId?: string;
}

/**
 * Create the desktop host runtime as a sidecar session. This is the only
 * launch path that yields an authenticated runtime: the sidecar injects the
 * desktop app's credential bootstrap (at-rest encryption policy, bootstrap
 * socket, product context) into every child it spawns, so the CLI obtains its
 * credentials from the running desktop app exactly like the app's own
 * runtimes do. A directly spawned runtime lacks that channel and refuses
 * turns with "Authentication required".
 *
 * The command is the desktop's own host-runtime recipe (the app's Electron
 * binary running as Node + the bundled CLI in --serve mode). The caller's env
 * wins over the sidecar's, so only overrides are passed; the gateway auth is
 * pinned to "none" because this runtime serves only Koryphaios on localhost
 * and the desktop's per-instance gateway password is not shareable.
 */
export async function createDesktopRuntimeSession(
  sidecar: RunningSidecar,
  params: {
    runtime: WorkBuddyDesktopRuntimePaths;
    cwd: string;
    /** Extra env merged over the sidecar-provided desktop context. */
    env?: Record<string, string>;
  },
): Promise<SidecarSessionInfo> {
  const { runtime, cwd, env } = params;
  const childEnv: Record<string, string> = {
    PATH: env?.PATH ?? process.env.PATH ?? '/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1',
    DISABLE_AUTOUPDATER: '1',
    CODEBUDDY_CONFIG_DIR: runtime.configDir,
    WORKBUDDY_CONFIG_DIR: runtime.configDir,
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    CODEBUDDY_HOST: 'workbuddy-desktop',
    // The runtime gateway serves localhost only; desktop gateway auth would
    // demand a per-instance password Koryphaios cannot obtain.
    CODEBUDDY_GATEWAY_AUTH: 'none',
    ...(env ?? {}),
  };
  return createSessionOnSidecar(sidecar, {
    command: runtime.electronBin,
    args: [
      runtime.cliBin,
      '--serve',
      '--no-session-persistence',
      '--setting-sources',
      'user',
      '--settings',
      JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }),
    ],
    cwd,
    env: childEnv,
    port: 0,
  });
}

/** Attach to a running desktop sidecar and create a session on it. The
 *  session command is the desktop's own host-runtime recipe (Electron as
 *  Node + the bundled CLI in --serve mode) so the turn inherits the desktop
 *  app's environment; Koryphaios supplies the --mcp-config wiring. */
export async function createSessionOnSidecar(
  sidecar: RunningSidecar,
  params: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    port: number;
    cols?: number;
    rows?: number;
  },
): Promise<SidecarSessionInfo> {
  const client = new SidecarControlClient(sidecar.controlSocketPath);
  const result = (await client.request('session.create', {
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    port: params.port,
    cols: params.cols ?? 120,
    rows: params.rows ?? 40,
  })) as SidecarSessionInfo;
  return result;
}

// ── Runtime spawn (self-managed mode) ──────────────────────────────────────

export interface DesktopRuntimeHandle {
  pid: number | undefined;
  /** ACP base URL, e.g. http://127.0.0.1:54321/api/v1/acp */
  acpEndpoint: string;
  kill(): void;
  readonly exited: Promise<number | null>;
}

export interface SpawnDesktopRuntimeOptions {
  runtime: WorkBuddyDesktopRuntimePaths;
  cwd: string;
  /** Path to the MCP config file passed via --mcp-config (kory bridge). */
  mcpConfigPath?: string;
  /** Extra env merged into the child (desktop context). */
  env?: NodeJS.ProcessEnv;
  /** Pre-wrapped spawn command (OS jail) and argv prefix. */
  command?: string;
  prefixArgs?: string[];
  /** Called with stderr tail on failure. */
  onStderr?: (tail: string) => void;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error('No free port'))));
    });
  });
}

async function waitForPort(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ok = await new Promise<boolean>((res) => {
      const socket = connect({ host: '127.0.0.1', port });
      const done = (value: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        res(value);
      };
      const timer = setTimeout(() => done(false), 1_000);
      timer.unref?.();
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, RUNTIME_POLL_INTERVAL_MS));
  }
}

/**
 * Spawn the desktop host runtime, replicating the desktop app's own recipe:
 * the app's Electron binary runs as Node (ELECTRON_RUN_AS_NODE=1) and starts
 * the bundled CLI in --serve mode with the desktop's bundle selection env
 * (CODEBUDDY_FORCE_LITE_WB_BUNDLE / HEADLESS), user settings sources, the
 * product sandbox policy, and Koryphaios's kory MCP config. The runtime
 * serves ACP over HTTP SSE on 127.0.0.1; the chosen port is discovered by
 * binding a probe port first and polling until the server accepts
 * connections.
 */
export async function spawnDesktopRuntime(
  options: SpawnDesktopRuntimeOptions,
): Promise<DesktopRuntimeHandle> {
  const { runtime, cwd } = options;
  const port = await pickFreePort();

  const settings = JSON.stringify({
    sandbox: { allowUnsandboxedCommands: false },
  });
  const cliArgs = [
    runtime.cliBin,
    '--serve',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--settings',
    settings,
    ...(options.mcpConfigPath ? ['--mcp-config', options.mcpConfigPath] : []),
    '--strict-mcp-config',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    // Loopback-only child owned by Koryphaios: the ACP endpoint executes
    // agent turns, so the port is never exposed beyond 127.0.0.1 and the
    // process dies with the turn that spawned it.
    '--auth',
    'none',
  ];
  const args = [...(options.prefixArgs ?? []), ...cliArgs];

  // The child receives only the provider allowlist (PATH, proxy, HOME, and the
  // WorkBuddy/CodeBuddy credential + config keys — see cli-environment.ts) plus
  // the runtime-control vars below. It must NOT inherit the backend's full
  // process.env: other providers' CODEBUDDY_*/ACC_PRODUCT_CONFIG_* vars would
  // leak into the desktop runtime and can reroute its model requests to the
  // cloud "maas" gateway (which the desktop account cannot use).
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ELECTRON_RUN_AS_NODE: '1',
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    WORKBUDDY_CONFIG_DIR: runtime.configDir,
    CODEBUDDY_CONFIG_DIR: runtime.configDir,
    SERVER__PORT: String(port),
    SERVER__HOST: '127.0.0.1',
  };

  let stderrTail = '';
  const command = options.command ?? runtime.electronBin;
  const child: ChildProcess = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env,
    detached: false,
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4096);
  });

  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });

  const ready = await waitForPort(port, RUNTIME_START_TIMEOUT_MS);
  if (!ready) {
    const exitCode = await Promise.race([
      exited.then((code) => code ?? -1),
      new Promise<number>((r) => setTimeout(() => r(-2), 1_000).unref?.()),
    ]);
    child.kill('SIGTERM');
    options.onStderr?.(stderrTail);
    throw new Error(
      `WorkBuddy Desktop runtime did not start on port ${port} ` +
        `(exit=${exitCode === -2 ? 'timeout' : exitCode}).` +
        (stderrTail ? ` stderr tail: ${stderrTail.slice(-600)}` : ''),
    );
  }

  return {
    pid: child.pid,
    acpEndpoint: `http://127.0.0.1:${port}/api/v1/acp`,
    kill() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
    exited,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Write the kory MCP config file for --mcp-config (mcpServers shape, the
 *  same JSON the desktop app writes for its own host runtime). */
export function writeMcpConfigFile(dir: string, sessionId: string, servers: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.mcp-config.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return path;
}

export function removeMcpConfigFile(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

export function desktopRuntimeTmpDir(): string {
  const dir = join(tmpdir(), `kory-workbuddy-desktop-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* fall through; callers handle write failures */
  }
  return dir;
}

export function randomSessionId(): string {
  return randomUUID();
}

export function randomToken(): string {
  return randomBytes(24).toString('hex');
}

/** Stat guard used by callers before treating a path as the app root. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function safeRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
