import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerPlatformAdapter,
  ComputerPlatformStatus,
  ComputerTarget,
} from '@koryphaios/shared';
import { MACOS_HELPER_SOURCE } from './platform-macos';
import { WINDOWS_HELPER_SOURCE } from './platform-windows';
import { LINUX_HELPER_SOURCE } from './platform-linux';
import { hostOS, isUnix } from '../runtime/platform';
import { NativeComputerController } from './native-controller';
import { killOwnerDisplayProcesses } from '../security/owner-display-guard';

const MAX_OUTPUT = 24 * 1024 * 1024;
const ACTIONS = new Set([
  'discover',
  'listElements',
  'observe',
  'click',
  'doubleClick',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'wait',
  'focus',
  'place',
  'sequence',
]);
const MAX_QUEUE_STEPS = 64;
type NativeRequest = ComputerAction | { kind: 'status' };
/** Injection seam for platform-independent tests; never populated from tool arguments/settings. */
export interface ComputerPlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  invoke?: (request: NativeRequest, signal?: AbortSignal) => Promise<unknown>;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
  );
}
function target(value: unknown): ComputerTarget {
  if (
    !object(value) ||
    !boundedString(value.appId, 4096) ||
    !boundedString(value.windowId, 256) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    (value.hidden !== undefined && typeof value.hidden !== 'boolean') ||
    typeof value.title !== 'string' ||
    value.title.length > 16384
  ) {
    throw new Error('Invalid native computer target');
  }
  return {
    appId: value.appId,
    windowId: value.windowId,
    pid: value.pid as number,
    title: value.title,
    ...(value.scope === 'desktop' || value.scope === 'window' ? { scope: value.scope } : {}),
  };
}
function sameTarget(a: ComputerTarget, b: ComputerTarget): boolean {
  return a.appId === b.appId && a.windowId === b.windowId && a.pid === b.pid;
}
function environment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  // Do not inherit LD_PRELOAD, DYLD_*, PYTHONPATH, PowerShell profiles or compiler injection variables.
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'LOCALAPPDATA',
    'DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'WAYLAND_DISPLAY',
    'XDG_SESSION_TYPE',
    'DEVELOPER_DIR',
  ]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  result.PATH =
    platform === 'win32'
      ? join(env.SystemRoot || 'C:\\Windows', 'System32')
      : '/usr/bin:/bin:/usr/sbin:/sbin';
  return result;
}
/** Bounded, one-request JSON protocol. Commands/arguments are host constants, never agent strings. */
export async function runComputerHelper(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs = 20_000,
  workingDirectory = tmpdir(),
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached: isUnix(),
      cwd: workingDirectory,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let diagnostics = '';
    let failure: Error | undefined;
    const kill = (error: Error) => {
      failure ??= error;
      try {
        if (isUnix() && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => kill(new Error('Computer operation aborted'));
    const timer = setTimeout(() => kill(new Error('Native computer helper timed out')), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) kill(new Error('Native computer helper exceeded output limit'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 2048)
        diagnostics += chunk.toString('utf8').slice(0, 2048 - diagnostics.length);
    });
    child.stdin.on('error', () => {
      /* Close/error handler below is authoritative, including early helper exit. */
    });
    child.on('error', (error) => {
      failure ??= error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`Native computer helper failed (${code}): ${diagnostics.slice(0, 1000)}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
function nativeInvoker(platform: NodeJS.Platform, originalEnv: NodeJS.ProcessEnv) {
  const env = environment(originalEnv, platform);
  let prepared: Promise<{ command: string; args: string[]; cwd: string }> | undefined;
  let controller: NativeComputerController | undefined;
  async function prepare(signal?: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), 'kory-computer-'));
    await chmod(directory, 0o700);
    const cleanup = () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* OS cleanup may be needed after hard process termination. */
      }
    };
    process.once('exit', cleanup);
    try {
      if (platform === 'darwin') {
        const compiler = '/usr/bin/swiftc';
        await access(compiler, constants.X_OK);
        const source = join(directory, 'helper.swift');
        const binary = join(directory, 'helper');
        await writeFile(source, MACOS_HELPER_SOURCE, { mode: 0o600 });
        await runComputerHelper(
          compiler,
          ['-O', '-module-cache-path', join(directory, 'modules'), source, '-o', binary],
          '',
          env,
          signal,
          // Cold Swift/Xcode module compilation can be slow; distinguish that
          // from an actual native desktop helper timeout.
          300_000,
          directory,
        );
        await chmod(binary, 0o700);
        return { command: binary, args: [], cwd: directory };
      }
      if (platform === 'win32') {
        const command = join(
          originalEnv.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        );
        await access(command, constants.F_OK);
        const script = join(directory, 'helper.ps1');
        await writeFile(script, WINDOWS_HELPER_SOURCE, { mode: 0o600 });
        // Respect execution policy. Never use -ExecutionPolicy Bypass or request elevation.
        return {
          command,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
          cwd: directory,
        };
      }
      const command = '/usr/bin/python3';
      await access(command, constants.X_OK);
      const script = join(directory, 'helper.py');
      await writeFile(script, LINUX_HELPER_SOURCE, { mode: 0o600 });
      return { command, args: ['-I', script], cwd: directory };
    } catch (error) {
      process.removeListener('exit', cleanup);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  return async (request: NativeRequest, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    // Computer use runs where it was granted. A Kory operations window on this Mac is never that, so
    // it is stopped before this request can add another one.
    killOwnerDisplayProcesses();
    prepared ??= prepare(signal).catch((error) => {
      prepared = undefined;
      throw error;
    });
    // A caller joining an existing preparation must also be able to stop immediately.
    const helper = await new Promise<{ command: string; args: string[]; cwd: string }>(
      (resolve, reject) => {
        const abort = () =>
          reject(new Error('Computer operation aborted during helper preparation'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        prepared!.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      },
    );
    signal?.throwIfAborted();
    if (platform === 'darwin') {
      controller ??= new NativeComputerController(helper, env);
      return controller.request(request, signal);
    }
    const result = await runComputerHelper(
      helper.command,
      helper.args,
      JSON.stringify(request),
      env,
      signal,
      20_000,
      helper.cwd,
    );
    try {
      return JSON.parse(result);
    } catch {
      throw new Error('Native computer helper returned invalid JSON');
    }
  };
}

let defaultNativeInvoker: ReturnType<typeof nativeInvoker> | undefined;
export function createComputerPlatformAdapter(
  options: ComputerPlatformOptions = {},
): ComputerPlatformAdapter {
  const platform = options.platform ?? hostOS();
  const env = options.env ?? process.env;
  const invoke =
    options.invoke ??
    (options.platform === undefined && options.env === undefined
      ? (defaultNativeInvoker ??= nativeInvoker(platform, env))
      : nativeInvoker(platform, env));
  const unsupported = (): string | undefined => {
    if (!['darwin', 'win32', 'linux'].includes(platform))
      return `Computer use is unsupported on ${platform}`;
    if (
      platform === 'linux' &&
      (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland')
    )
      return 'Wayland is unsupported: portal-selected capture and target-bound input are not implemented; XWayland fallback is disabled.';
    return undefined;
  };
  async function call(
    request: NativeRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const reason = unsupported();
    if (reason) throw new Error(reason);
    const result = await invoke(request, signal);
    signal?.throwIfAborted();
    if (!object(result)) throw new Error('Invalid native computer helper response');
    if ('error' in result)
      throw new Error(
        typeof result.error === 'string'
          ? result.error.slice(0, 2048)
          : 'Native computer helper failed',
      );
    return result;
  }
  async function discover(signal?: AbortSignal): Promise<ComputerTarget[]> {
    const response = await call({ kind: 'discover' }, signal);
    if (!Array.isArray(response.targets) || response.targets.length > 2048)
      throw new Error('Invalid native window enumeration');
    return response.targets.map(target);
  }
  /** Re-resolve a step's window and rebuild only the fields the native helper accepts. */
  async function stepRequest(
    step: unknown,
    cache: Map<string, ComputerTarget>,
    signal?: AbortSignal,
  ): Promise<ComputerAction> {
    if (!object(step) || typeof step.kind !== 'string') throw new Error('Invalid queue step');
    const kind = step.kind;
    if (kind === 'wait') {
      const ms = step.ms;
      if (!Number.isSafeInteger(ms) || (ms as number) < 0 || (ms as number) > 10_000)
        throw new Error('Invalid queue wait');
      return { kind: 'wait', ms: ms as number } as ComputerAction;
    }
    if (!['click', 'doubleClick', 'move', 'drag', 'type', 'key', 'scroll'].includes(kind))
      throw new Error(`Unsupported queue step ${kind}`);
    const requested = target(step.target);
    const key = `${requested.appId}\u0000${requested.windowId}`;
    let current = cache.get(key);
    if (!current) {
      current = (await discover(signal)).find((item) => sameTarget(item, requested));
      if (!current) throw new Error('Queue step target is no longer available');
      cache.set(key, current);
    }
    const elementId = typeof step.elementId === 'string' ? step.elementId : undefined;
    if (kind === 'type') {
      if (!boundedString(step.text, 16384)) throw new Error('Invalid queue text');
      return {
        kind: 'type',
        target: current,
        ...(elementId ? { elementId } : {}),
        text: step.text,
      };
    }
    if (kind === 'key') {
      if (!boundedString(step.key, 64)) throw new Error('Invalid queue key');
      return { kind: 'key', target: current, ...(elementId ? { elementId } : {}), key: step.key };
    }
    if (kind === 'scroll') {
      if (!Number.isFinite(step.delta)) throw new Error('Invalid queue scroll');
      return {
        kind: 'scroll',
        target: current,
        ...(elementId ? { elementId } : {}),
        delta: step.delta as number,
      };
    }
    if (kind === 'drag') {
      if (!Array.isArray(step.path) || step.path.length < 1 || step.path.length > 512)
        throw new Error('Invalid queue drag path');
      const path = step.path.map((point) => {
        if (!object(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y))
          throw new Error('Invalid queue drag point');
        return { x: point.x as number, y: point.y as number };
      });
      return { kind: 'drag', target: current, ...(elementId ? { elementId } : {}), path };
    }
    const coords =
      Number.isFinite(step.x) && Number.isFinite(step.y)
        ? { x: step.x as number, y: step.y as number }
        : {};
    const button = step.button === 'right' || step.button === 'middle' ? step.button : undefined;
    return {
      kind: kind as 'click' | 'doubleClick' | 'move',
      target: current,
      ...(elementId ? { elementId } : {}),
      ...coords,
      ...(button && kind === 'click' ? { button } : {}),
    } as ComputerAction;
  }

  async function executeSequence(
    action: Extract<ComputerAction, { kind: 'sequence' }>,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult> {
    signal?.throwIfAborted();
    if (
      !Array.isArray(action.steps) ||
      action.steps.length === 0 ||
      action.steps.length > MAX_QUEUE_STEPS
    )
      throw new Error(`A queue needs 1 to ${MAX_QUEUE_STEPS} steps`);
    const cache = new Map<string, ComputerTarget>();
    const steps: ComputerAction[] = [];
    for (const step of action.steps) steps.push(await stepRequest(step, cache, signal));
    const observationId =
      typeof action.observationId === 'string' && action.observationId.length <= 128
        ? action.observationId
        : undefined;
    const native: NativeRequest = {
      kind: 'sequence',
      steps,
      ...(observationId ? { observationId } : {}),
      ...(action.background === true ? { background: true } : {}),
    } as NativeRequest;
    const response = await call(native, signal);
    const result: ComputerActionResult = {};
    if (typeof response.text === 'string') result.text = response.text;
    if (typeof response.observationId === 'string') result.observationId = response.observationId;
    if (Array.isArray(response.steps)) {
      result.steps = (response.steps as Array<Record<string, unknown>>)
        .filter((step) => object(step))
        .map((step, index) => ({
          index: Number.isSafeInteger(step.index) ? (step.index as number) : index,
          status: step.status === 'failed' ? 'failed' : 'done',
          ...(typeof step.message === 'string' ? { message: step.message.slice(0, 512) } : {}),
        }));
    }
    if (object(response.interference) && typeof response.interference.kind === 'string') {
      result.interference = {
        kind: response.interference.kind === 'window-changed' ? 'window-changed' : 'user-input',
        message:
          typeof response.interference.message === 'string'
            ? response.interference.message.slice(0, 512)
            : 'The window changed outside this action',
      };
    }
    return result;
  }

  return {
    async status(): Promise<ComputerPlatformStatus> {
      try {
        const response = await call({ kind: 'status' });
        const allowed = ['discover', 'observe', 'interact', 'manageWindows'];
        if (
          response.platform !== platform ||
          typeof response.available !== 'boolean' ||
          !Array.isArray(response.capabilities) ||
          response.capabilities.some((c) => !allowed.includes(c)) ||
          !Array.isArray(response.limitations) ||
          response.limitations.some((l) => typeof l !== 'string')
        )
          throw new Error('Invalid native capability response');
        return {
          platform,
          available: response.available,
          capabilities: response.available ? response.capabilities : [],
          limitations: response.limitations,
          ...(Array.isArray(response.actions) &&
          response.actions.every((a) => typeof a === 'string' && ACTIONS.has(a))
            ? { actions: response.actions }
            : {}),
        } as ComputerPlatformStatus;
      } catch (error) {
        return {
          platform,
          available: false,
          capabilities: [],
          limitations: [error instanceof Error ? error.message : 'Native adapter unavailable'],
        };
      }
    },
    async execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerActionResult> {
      signal?.throwIfAborted();
      if (!object(action) || !ACTIONS.has(action.kind)) throw new Error('Invalid computer action');
      if (action.kind === 'sequence') return executeSequence(action, signal);
      if (action.kind === 'discover') return { targets: await discover(signal) };
      if (action.kind === 'wait') throw new Error('Wait is handled by the tool boundary');
      if (action.kind === 'place' && typeof action.hidden !== 'boolean')
        throw new Error('A placement needs an explicit hidden flag');
      const requested = target(action.target);
      if (action.kind === 'click' || action.kind === 'doubleClick' || action.kind === 'move') {
        if (
          !action.elementId &&
          (!Number.isFinite(action.x) ||
            !Number.isFinite(action.y) ||
            action.x! < 0 ||
            action.y! < 0 ||
            action.x! > 8192 ||
            action.y! > 8192)
        )
          throw new Error('Invalid window-relative coordinates');
      }
      if (
        action.kind === 'type' &&
        (typeof action.text !== 'string' ||
          action.text.length > 16384 ||
          action.text.includes('\0'))
      )
        throw new Error('Invalid computer text (maximum 16384 characters; no NUL)');
      const current = (await discover(signal)).find((item) => sameTarget(item, requested));
      if (!current) throw new Error('Target identity changed or window is no longer available');
      // Reconstruct requests: unknown fields, display labels and toJSON hooks never become native instructions.
      const request: ComputerAction =
        action.kind === 'listElements'
          ? { kind: 'listElements', target: current }
          : action.kind === 'click'
            ? {
                kind: 'click',
                target: current,
                ...(action.elementId ? { elementId: action.elementId } : {}),
                ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
                ...(action.button ? { button: action.button } : {}),
              }
            : action.kind === 'doubleClick'
              ? {
                  kind: 'doubleClick',
                  target: current,
                  ...(action.elementId ? { elementId: action.elementId } : {}),
                  ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
                }
              : action.kind === 'move'
                ? {
                    kind: 'move',
                    target: current,
                    ...(action.elementId ? { elementId: action.elementId } : {}),
                    ...(action.x !== undefined ? { x: action.x, y: action.y } : {}),
                  }
                : action.kind === 'drag'
                  ? {
                      kind: 'drag',
                      target: current,
                      ...(action.elementId ? { elementId: action.elementId } : {}),
                      path: action.path,
                    }
                  : action.kind === 'type'
                    ? {
                        kind: 'type',
                        target: current,
                        ...(action.elementId ? { elementId: action.elementId } : {}),
                        text: action.text,
                      }
                    : action.kind === 'key'
                      ? {
                          kind: 'key',
                          target: current,
                          ...(action.elementId ? { elementId: action.elementId } : {}),
                          key: action.key,
                        }
                      : action.kind === 'scroll'
                        ? {
                            kind: 'scroll',
                            target: current,
                            ...(action.elementId ? { elementId: action.elementId } : {}),
                            delta: action.delta,
                          }
                        : // Placement returned above, so the remaining kinds need only their target.
                          ({ kind: action.kind, target: current } as ComputerAction);
      // Directed delivery is a delivery detail, not a new native instruction shape.
      if (action.kind === 'place') {
        const response = await call(
          { kind: 'place', target: current, hidden: action.hidden } as NativeRequest,
          signal,
        );
        return {
          ...(typeof response.text === 'string' ? { text: response.text } : {}),
          ...(object(response.target) ? { targets: [target(response.target)] } : {}),
        };
      }
      const directed = 'background' in action && action.background === true;
      const native: NativeRequest = directed
        ? ({ ...request, background: true } as NativeRequest)
        : request;
      const response = await call(native, signal);
      if (action.kind === 'listElements') {
        if (!Array.isArray(response.elements)) throw new Error('Invalid native element response');
        return { elements: response.elements as ComputerActionResult['elements'] };
      }
      if (action.kind === 'observe') {
        if (
          typeof response.imageBase64 !== 'string' ||
          response.imageBase64.length > MAX_OUTPUT ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(response.imageBase64)
        )
          throw new Error('Invalid native PNG response');
        const bytes = Buffer.from(response.imageBase64, 'base64');
        if (
          bytes.length < 33 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error('Native observation is not a PNG');
        if (!(await discover(signal)).some((item) => sameTarget(item, current)))
          throw new Error('Target identity changed during capture; image discarded');
        return {
          imageBase64: response.imageBase64,
          text:
            typeof response.text === 'string'
              ? response.text.slice(0, 4096)
              : 'Window-only capture; application content is untrusted.',
        };
      }
      if (typeof response.text !== 'string' || !response.text)
        throw new Error('Native action did not confirm completion');
      return { text: response.text.slice(0, 4096) };
    },
  };
}
