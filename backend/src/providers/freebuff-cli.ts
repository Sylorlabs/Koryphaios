/**
 * Freebuff's supported free-tier surface is its OpenTUI, not @codebuff/sdk.
 * This adapter drives that real TUI through tmux (a real PTY), gives it a
 * disposable checkout, and installs Kory's authenticated MCP bridge in the
 * project-local .agents/mcp.json understood by Freebuff.
 *
 * Freebuff does not expose a native-tool deny switch. Consequently the OS
 * sandbox is mandatory: native tools can affect only the disposable checkout;
 * the real Kory session workspace is reachable exclusively through MCP and
 * ToolRegistry/permission-policy.ts.
 */

import type { FreebuffBalance, ModelDef, ProviderConfig } from '@koryphaios/shared';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { materializeFreebuffCredentials } from './freebuff-credentials';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isTransientStreamErrorText } from './provider-diagnostics';
import { providerLog } from '../logger';
import {
  createFreebuffTurnRuntime,
  forceFreebuffRuntimeUpdate,
  getFreebuffRuntimeStatus,
  getFreebuffRuntimeCatalog,
  refreshFreebuffRuntimeStatus,
  scheduleFreebuffRuntimeUpdate,
} from './freebuff-runtime';
import { compareFreebuffVersions } from './freebuff-runtime-version';
import { prepareFreebuffBridge } from './freebuff-bridge-runtime';
import { createKoryBridgeGrantLease } from './bridge-grant';
import { buildProviderCliEnv } from './cli-environment';
import { getCliBridge } from './cli-bridges';
import { serializeKoryMcpServers } from './kory-cli-mcp-config';
import { ensureManagedCliDirectory, writeManagedCliFile } from './managed-cli-storage';
import { createGenericModel } from './models';
import { discoverFreebuffAccounts, freebuffConfigDir, type FreebuffAccount } from './auth-utils';
import {
  discoverFreebuffBundledCatalog,
  buildFreebuffTurnSettings,
  freebuffSelectedModelFromLogRow,
  FREEBUFF_CLI_DEFAULT_MODEL_ID,
  type FreebuffBundledCatalog,
} from './freebuff-bundled-catalog';
import { getFreebuffModelCatalog } from './freebuff-model-catalog';
import { getFreebuffAccountSnapshot } from './freebuff-account';
import type { Provider, ProviderEvent, ProviderMessage, StreamRequest } from './types';
import { userConfirmedImageInput } from './attachment-admission';
import { recordedToolIdentity, recordedToolInput, recordedToolName } from './recorded-tool';
import { executableSuffixes, findOnPath } from '../runtime/platform';

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
  const profileCandidates = [profileDir, freebuffConfigDir()]
    .filter((value): value is string => !!value)
    .flatMap((directory) =>
      executableSuffixes().map((suffix) => join(directory, `freebuff${suffix}`)),
    );
  const candidates = [...profileCandidates, findOnPath('freebuff') ?? ''].filter(Boolean);
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

/** tmux -p is conditional on the pane's bracketed-paste flag. OpenTUI's
 * negotiated terminal state is not always visible to a detached tmux server.
 * Send one explicit paste frame so multiline input cannot become keystrokes.
 */
export async function pasteFreebuffBuffer(
  tmux: FreebuffTmux,
  session: string,
  buffer: string,
): Promise<void> {
  await tmux(['send-keys', '-l', '-t', session, '\x1b[200~']);
  await tmux(['paste-buffer', '-d', '-b', buffer, '-t', session]);
  await tmux(['send-keys', '-l', '-t', session, '\x1b[201~']);
}

/** Only adapter-owned messages may reach diagnostics; panes and child errors can contain secrets. */
class FreebuffPtyError extends Error {}

/** Codebuff retired the runtime this turn launched with (HTTP 410). Never
 * yielded to the caller directly; the stream wrapper self-heals once. */
class FreebuffUpdateRequiredError extends FreebuffPtyError {
  constructor(
    message: string,
    readonly version?: string,
  ) {
    super(message);
  }
}

/** The 0.2.36 TUI shows a native out-of-date screen instead of a composer. */
export function freebuffUpdateRequiredPane(pane: string): boolean {
  const screen = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return /This version of Freebuff is out of date/i.test(screen);
}

interface FreebuffUpstreamError {
  statusCode?: number;
  code?: string;
  message?: string;
  isRetryable?: boolean;
}

/** Extract only the bounded upstream-error fields from a log row's data.error.
 * requestBodyValues, url, stack and headers are never read into diagnostics. */
function freebuffUpstreamError(data: Record<string, unknown>): FreebuffUpstreamError | null {
  const error = data.error;
  if (!freebuffRecord(error)) return null;
  const upstream: FreebuffUpstreamError = {};
  if (typeof error.statusCode === 'number' && Number.isFinite(error.statusCode))
    upstream.statusCode = error.statusCode;
  if (error.isRetryable === true) upstream.isRetryable = true;
  if (typeof error.responseBody === 'string' && error.responseBody.length <= 64 * 1024) {
    try {
      const parsed: unknown = JSON.parse(error.responseBody);
      if (freebuffRecord(parsed)) {
        const inner = freebuffRecord(parsed.error) ? parsed.error : parsed;
        if (typeof inner.code === 'string') upstream.code = inner.code;
        else if (typeof inner.error === 'string') upstream.code = inner.error;
        if (typeof inner.message === 'string') upstream.message = inner.message;
      }
    } catch {
      /* An unparseable body contributes nothing; it is never surfaced raw. */
    }
  }
  if (upstream.message === undefined && typeof error.message === 'string')
    upstream.message = error.message;
  return upstream;
}

function freebuffUpdateRequiredFromRow(
  data: Record<string, unknown>,
  msg = '',
): boolean {
  const error = data.error;
  if (!freebuffRecord(error)) return false;
  if (
    typeof error.responseBody === 'string' &&
    error.responseBody.includes('freebuff_update_required')
  )
    return true;
  // A bare 410 on an unrelated row must never trigger a runtime rebuild; only
  // the model-stream rows carry the retirement verdict.
  return (
    error.statusCode === 410 &&
    (msg === 'Error in AI SDK stream' || msg === 'Agent execution failed')
  );
}

/** Render the real upstream failure without prompt, request, url or token material. */
function freebuffUpstreamErrorMessage(upstream: FreebuffUpstreamError): string {
  const sanitized = (upstream.message ?? 'unknown upstream error')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/(eyJ|sk-|cb-)[A-Za-z0-9._-]{10,}/g, '[redacted]')
    .slice(0, 300)
    .trim();
  const detail = upstream.statusCode
    ? `HTTP ${upstream.statusCode}${upstream.code ? `, ${upstream.code}` : ''}`
    : (upstream.code ?? 'request failed');
  return `Freebuff model request failed (${detail}): ${sanitized || 'no upstream detail'}`;
}

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
  // A banner or a long pane is NOT input readiness. This is 0.2.16's actual composer placeholder.
  if (/enter a coding task or \/ for commands/i.test(screen)) return 'ready';
  if (/start coding for free|press enter to continue/i.test(screen)) return 'welcome';
  return 'waiting';
}

/** Turn a native account-limit screen into an actionable provider error instead
 * of waiting for the MCP readiness deadline and reporting a misleading bridge
 * failure. The 0.2.36 concurrent-session gate offers "Enter: take over", which
 * would kill the account's other live session; never auto-confirm it. */
export function freebuffAccountLimitError(pane: string): string | null {
  const screen = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/concurrent-session limit/i.test(screen)) {
    return 'Freebuff reports that the account concurrent-session limit across CLI and Desktop is reached. Close another Freebuff session or take it over in the Freebuff TUI, then retry.';
  }
  return /(?:not enough|insufficient|no) freebucks?/i.test(screen)
    ? 'Freebuff has no Freebucks available for this request. Add Freebucks or choose a currently free model, then retry.'
    : null;
}

/** Some paid/account models show a native confirmation after the prompt has
 * been accepted. It is a TUI action, not an MCP approval, so the PTY driver
 * must acknowledge this exact prompt before waiting for the bridge process. */
export function freebuffNeedsSessionConfirmation(pane: string): boolean {
  const screen = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return /enter\s*:\s*confirm\s+and\s+send/i.test(screen);
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

/** OpenTUI processes bracketed paste asynchronously. Enter sent immediately
 * after tmux paste-buffer can submit the old empty composer and lose the turn.
 * Long pastes become native text attachments; short ones populate the composer.
 * Wait for the CLI's own receipt evidence before sending the submission key.
 */
export function freebuffPromptReady(pane: string, prompt: string): boolean {
  const screen = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (prompt.length > 2_000) {
    // The toast can expire or sit above a clipped footer. The persistent
    // native text card also renders the exact count followed by "chars".
    return new RegExp(`(?:^|\\D)${prompt.length}chars(?:$|\\D)`).test(screen.replace(/[,\s]/g, ''));
  }
  // OpenTUI wraps inside a bordered composer rather than terminal autowrap,
  // so capture-pane -J retains the border between pieces of the same word.
  const compact = (value: string) => value.replace(/[\s\u2500-\u257f]/g, '');
  const suffix = compact(prompt.trim().slice(-32));
  return suffix.length > 0 && compact(screen).includes(suffix);
}

export async function waitForFreebuffPromptReady(
  tmux: FreebuffTmux,
  session: string,
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    checkAbort(signal);
    const pane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
    if (freebuffPromptReady(pane, prompt)) return;
    if (['login', 'trust'].includes(freebuffStartupState(pane))) {
      throw new FreebuffPtyError('Freebuff could not accept the prompt in its logged-in composer');
    }
    await waitForFreebuffPoll(100, signal);
  }
  throw new FreebuffPtyError('Freebuff TUI did not acknowledge the pasted prompt');
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

function freebuffRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function freebuffText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => freebuffText(item))
      .filter((item): item is string => item !== null)
      .join('');
    return text.trim() ? text : null;
  }
  if (!freebuffRecord(value)) return null;
  for (const key of ['text', 'content', 'message', 'fullResponse']) {
    const text = freebuffText(value[key]);
    if (text) return text;
  }
  return null;
}

/** Extract the text-bearing shapes emitted by the native CLI log. */
export function freebuffResponseFromLogRow(row: Record<string, unknown>): string | null {
  const data = freebuffRecord(row.data) ? row.data : row;
  for (const key of ['fullResponse', 'lastMessage']) {
    const text = freebuffText(data[key]);
    if (text) return text;
  }
  const allMessages = data.allMessages;
  if (Array.isArray(allMessages)) {
    for (const message of [...allMessages].reverse()) {
      if (!freebuffRecord(message)) continue;
      const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
      if (role && !['assistant', 'model', 'agent'].includes(role)) continue;
      const text = freebuffText(message);
      if (text) return text;
    }
  }
  const structured = freebuffText(data.structuredOutput);
  return structured;
}

/** Nested agents commonly set shouldEndTurn. Only the main prompt owns turn completion. */
export function freebuffCompletionFromLogRow(
  row: Record<string, unknown>,
  hasResponseEvidence = false,
): 'pending' | 'success' | 'error' {
  if (row.msg !== 'Main prompt finished') return 'pending';
  const data =
    row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
  const hasOutputType = typeof data.outputType === 'string' && data.outputType.trim().length > 0;
  const outputType = String(data.outputType ?? '')
    .replace(/[_-]/g, '')
    .toLowerCase();
  if (['lastmessage', 'allmessages', 'structuredoutput'].includes(outputType)) return 'success';
  if (hasOutputType) return 'error';
  // Some native builds omit outputType on a successful completion. Existing
  // main-agent response evidence is sufficient to distinguish that case from
  // a genuinely empty or failed turn without accepting an empty completion.
  return hasResponseEvidence ? 'success' : 'error';
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
        const credentials = statSync(join(account.profileDir, 'credentials.json'));
        return `${account.id}:${binary}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${credentials.ino}:${credentials.size}:${credentials.mtimeMs}`;
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
  prices?: Record<string, number>,
): ModelDef[] {
  const encodedProfile = Buffer.from(account.profileDir).toString('base64url');
  return catalog.models.map(({ id, name, multimodal, contextWindow, reasoningLevels }) => {
    const model = createGenericModel(
      multipleAccounts ? `${ACCOUNT_PREFIX}${encodedProfile}:${id}` : id,
      'freebuff',
    );
    model.name = multipleAccounts ? `${name} (${account.label})` : name;
    model.apiModelId = id;
    let freebuckCost = prices?.[id] ?? prices?.[id.replace(/^freebuff\/catalog-/, '')];
    if (typeof freebuckCost !== 'number' && prices && typeof name === 'string' && name.length > 0) {
      freebuckCost = matchPriceByName(name, prices);
    }
    if (typeof freebuckCost === 'number') model.freebuckCost = freebuckCost;
    model.accountId = account.id;
    model.supportsAttachments = multimodal;
    model.vision = multimodal;
    if (reasoningLevels?.length) {
      model.canReason = true;
      model.reasoningLevels = [...reasoningLevels];
    }
    if (contextWindow && contextWindow >= 1_024) {
      model.contextWindow = contextWindow;
      model.contextVerified = true;
    }
    return model;
  });
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function matchPriceByName(displayName: string, prices: Record<string, number>): number | undefined {
  const normalized = normalizeKey(displayName);
  let match: number | undefined;
  let matches = 0;
  for (const [key, price] of Object.entries(prices)) {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey.includes(normalized) || normalized.includes(normalizedKey)) {
      matches++;
      match = price;
    }
  }
  return matches === 1 ? match : undefined;
}

/** Per-turn channel for an attempt to report a Codebuff runtime retirement to
 * the stream wrapper without yielding a caller-visible error. */
interface FreebuffAttemptState {
  updateRequired?: { version?: string };
}

/**
 * Best-effort graceful TUI exit before the forced teardown. Ctrl-C is the
 * TUI's stop/quit key; sending it twice (stop, then quit) gives Freebuff's
 * clean-exit path a chance to release its server-side session lease. This is
 * DEFENSIVE: a stale crashed-session lease was observed once to produce the
 * concurrent-session gate, but our own teardown leaving such a lease was
 * never reproduced on back-to-back turns. Kept because it is bounded and
 * cannot delay forced cleanup past the timeout; it never throws.
 */
async function gracefulFreebuffTuiExit(
  runtime: FreebuffTurnRuntime | undefined,
  timeoutMs = 5_000,
): Promise<void> {
  if (!runtime) return;
  try {
    await runtime.tmux(['send-keys', '-t', runtime.session, 'C-c']);
    await Bun.sleep(400);
    await runtime.tmux(['send-keys', '-t', runtime.session, 'C-c']);
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await runtime.tmux(['has-session', '-t', runtime.session]);
    } catch {
      return;
    }
    await Bun.sleep(250);
  }
}

const freebuffDependencies = {
  discoverAccounts: discoverFreebuffAccounts,
  findBinary: nativeFreebuffBinary,
  discoverCatalog: async (binary: string): Promise<FreebuffBundledCatalog> => {
    if (getFreebuffRuntimeStatus().kind === 'docker') {
      const catalog = getFreebuffRuntimeCatalog();
      if (!catalog) throw new Error('Freebuff execution catalog is not qualified');
      return catalog;
    }
    return discoverFreebuffBundledCatalog(binary);
  },
  discoverAccountCatalog: getFreebuffModelCatalog,
  runtimeStatus: getFreebuffRuntimeStatus,
  refreshRuntimeStatus: refreshFreebuffRuntimeStatus,
  scheduleRuntimeUpdate: scheduleFreebuffRuntimeUpdate,
  forceRuntimeUpdate: forceFreebuffRuntimeUpdate,
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

/** Call and result evidence can arrive in separate log rows or polls. */
export function freebuffToolEvents(
  data: Record<string, unknown>,
  calls: Map<string, Record<string, unknown>>,
  results: Map<string, Record<string, unknown>>,
  emitted: Set<string>,
): ProviderEvent[] {
  for (const [key, destination] of [
    ['toolCalls', calls],
    ['toolResults', results],
  ] as const) {
    for (const value of Array.isArray(data[key]) ? data[key] : []) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const id = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      if (id && !emitted.has(id)) destination.set(id, record);
    }
  }
  const events: ProviderEvent[] = [];
  for (const [id, call] of calls) {
    const result = results.get(id);
    if (!result) continue;
    const tool = recordedToolIdentity(
      recordedToolName(call) ?? recordedToolName(result),
      recordedToolInput(call.input),
    );
    events.push({
      type: 'tool_executed',
      toolCallId: id,
      // Keep native sandbox provenance in the internal namespace. The UI
      // strips only this prefix when displaying the actual tool identifier.
      toolName: tool.name
        ? tool.name.startsWith('kory__')
          ? tool.name
          : `freebuff_sandbox__${tool.name}`
        : undefined,
      toolInput: JSON.stringify(tool.input),
      toolOutput: stringifyToolResult(result.content ?? ''),
      isError: result.isError === true,
    });
    emitted.add(id);
    calls.delete(id);
    results.delete(id);
  }
  return events;
}

export class FreebuffProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  readonly name = 'freebuff' as const;
  private models: ModelDef[] = [];
  private modelDiscoveryError: string | undefined;
  private refreshInFlight: Promise<ModelDef[]> | null = null;
  private loadedCatalogRevision: string | null = null;
  private lastCatalogAttempt = 0;
  private modelHandles = new Map<string, Map<string, string>>();

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
      this.modelHandles.clear();
      void this.refreshModels(true);
    }
    return this.models;
  }

  getModelDiscoveryError(): string | undefined {
    return this.modelDiscoveryError;
  }

  refreshModels(forceRefresh = false): Promise<ModelDef[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.deps.scheduleRuntimeUpdate();
    const accounts = this.deps.discoverAccounts();
    const revision = catalogRevision(accounts, this.deps.findBinary);
    if (
      !forceRefresh &&
      revision &&
      revision === this.loadedCatalogRevision &&
      Date.now() - this.lastCatalogAttempt < 5 * 60_000
    ) {
      return Promise.resolve(this.models);
    }
    if (accounts.length === 0) {
      this.models = [];
      this.modelHandles.clear();
      this.loadedCatalogRevision = null;
      this.modelDiscoveryError =
        'Freebuff CLI is not signed in. Run "freebuff login" and reconnect.';
      return Promise.resolve([]);
    }
    if (!revision) {
      this.models = [];
      this.modelHandles.clear();
      this.loadedCatalogRevision = null;
      this.modelDiscoveryError =
        'Freebuff executable was not found for the signed-in CLI account. Reinstall Freebuff and reconnect.';
      return Promise.resolve([]);
    }

    this.refreshInFlight = Promise.allSettled(
      accounts.map(async (account) => {
        const binary = this.deps.findBinary(account.profileDir);
        if (!binary) throw new Error('Freebuff executable is missing for an account');
        const catalog = await this.deps.discoverCatalog(binary);
        let qualifiedRuntime = this.deps.runtimeStatus();
        if (
          qualifiedRuntime.available &&
          qualifiedRuntime.version &&
          catalog.cliVersion !== qualifiedRuntime.version
        ) {
          // A host CLI self-update can race the cached probe: force one
          // re-probe of the real runtime before refusing the account.
          qualifiedRuntime = await this.deps.refreshRuntimeStatus(true);
        }
        if (
          qualifiedRuntime.available &&
          qualifiedRuntime.version &&
          catalog.cliVersion !== qualifiedRuntime.version
        )
          return { account, catalog };
        if (catalog.selectionMode !== 'cli-managed') return { account, catalog };
        try {
          const live = await this.deps.discoverAccountCatalog(account.profileDir, forceRefresh);
          const accountSnapshot = await getFreebuffAccountSnapshot(
            account.profileDir,
            forceRefresh,
          );
          return {
            account,
            catalog: { ...catalog, models: [...catalog.models, ...live.models] },
            handles: new Map(live.models.map((model) => [model.id, model.handle])),
            prices: accountSnapshot.hours?.prices,
          };
        } catch {
          return { account, catalog, accountCatalogFailed: true };
        }
      }),
    )
      .then((results) => {
        const failures: string[] = [];
        const handles = new Map<string, Map<string, string>>();
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
          if (result.value.accountCatalogFailed)
            failures.push(
              'Account models could not be refreshed; check the CLI login and refresh models',
            );
          if (result.value.handles) handles.set(result.value.account.id, result.value.handles);
          return accountCatalogModels(
            result.value.account,
            result.value.catalog,
            accounts.length > 1,
            result.value.prices,
          );
        });
        const currentRevision = catalogRevision(accounts, this.deps.findBinary);
        if (currentRevision !== revision) {
          this.models = [];
          this.loadedCatalogRevision = null;
          this.modelHandles.clear();
          this.modelDiscoveryError =
            'Freebuff changed while its model catalog was being read. Refresh model discovery.';
          return [];
        }
        this.models = loaded;
        this.modelHandles = handles;
        this.lastCatalogAttempt = Date.now(); // Negative-cache discovery failures too.
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
          'Loaded Freebuff CLI and account model capabilities',
        );
        return loaded;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  /**
   * Outer turn wrapper: runs one PTY attempt, and on a Codebuff 410 retirement
   * performs a forced runtime update outside the attempt timer, then reruns the
   * attempt exactly once. Never loops, and never retries after content or tool
   * evidence was already emitted.
   */
  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let emittedPayload = false;
    let retried = false;
    for (;;) {
      const state: FreebuffAttemptState = {};
      for await (const event of this.streamFreebuffAttempt(request, state)) {
        if (event.type === 'content_delta' || event.type === 'tool_executed')
          emittedPayload = true;
        yield event;
      }
      const required = state.updateRequired;
      if (!required) return;
      const failed = required.version;
      const retired = `Codebuff has retired Freebuff ${failed ?? 'runtime'}.`;
      if (retried || emittedPayload) {
        yield {
          type: 'error',
          error: `${retired} Koryphaios could not install a newer runtime: ${
            emittedPayload
              ? 'the turn had already produced output before the rejection'
              : 'the updated runtime was still rejected'
          }`,
        };
        return;
      }
      retried = true;
      // The update may take minutes; give the UI a live state instead of a hang.
      yield {
        type: 'waiting',
        waitingReason: 'Updating the Freebuff runtime to the latest release…',
      };
      // The build is coalesced and useful to the next turn: on cancellation we
      // return promptly but let it finish in the background.
      const update = this.deps.forceRuntimeUpdate(failed).then(
        (status) => ({ status }),
        (error: unknown) => ({ error }),
      );
      const abortWait = request.signal
        ? new Promise<'aborted'>((resolve) => {
            if (request.signal!.aborted) resolve('aborted');
            else
              request.signal!.addEventListener('abort', () => resolve('aborted'), {
                once: true,
              });
          })
        : undefined;
      const outcome = await Promise.race(
        abortWait ? [update, abortWait] : [update],
      );
      if (outcome === 'aborted') {
        yield { type: 'error', error: 'Freebuff PTY turn cancelled.' };
        return;
      }
      if ('error' in outcome) {
        const reason =
          outcome.error instanceof Error
            ? outcome.error.message.split('\n')[0]!
            : 'update failed';
        yield {
          type: 'error',
          error: `${retired} Koryphaios could not install a newer runtime: ${reason.slice(0, 240)}`,
        };
        return;
      }
      const updated = outcome.status;
      if (
        !failed ||
        (updated.version && compareFreebuffVersions(updated.version, failed) > 0)
      )
        continue;
      yield {
        type: 'error',
        error: `${retired} Koryphaios could not install a newer runtime: the update did not advance past v${failed}`,
      };
      return;
    }
  }

  private async *streamFreebuffAttempt(
    request: StreamRequest,
    state: FreebuffAttemptState,
  ): AsyncGenerator<ProviderEvent> {
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
    // Shared with the finally path: the graceful exit runs at most once.
    let gracefulExit: Promise<void> | undefined;
    const releaseSession = (timeoutMs = 3_000) =>
      (gracefulExit ??= gracefulFreebuffTuiExit(runtime, timeoutMs));
    const onAbort = () => {
      // Give the TUI's clean-exit path a bounded chance before the forced
      // teardown; cancellation itself stays prompt.
      void (async () => {
        await releaseSession().catch(() => {});
        await stopRuntime()?.catch(() => {});
      })();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let attemptVersion: string | undefined;
    try {
      checkAbort(signal);
      if (!this.config.disabled) await this.deps.refreshRuntimeStatus();
      this.deps.scheduleRuntimeUpdate();
      attemptVersion = this.deps.runtimeStatus().version;
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
      const accounts = this.deps.discoverAccounts();
      const selectedAccount = requestedSelection.profileDir
        ? accounts.find(
            (account) => resolve(account.profileDir) === resolve(requestedSelection.profileDir!),
          )
        : accounts[0];
      if (
        !availableModels.some(
          (model) =>
            model.apiModelId === requestedSelection.modelId &&
            model.accountId === selectedAccount?.id,
        )
      ) {
        yield {
          type: 'error',
          error:
            this.modelDiscoveryError ??
            'The selected model is not available in this Freebuff account catalog. Refresh models or choose another model.',
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

      const selection = requestedSelection;
      const account = selectedAccount;
      if (!account) {
        yield {
          type: 'error',
          error: 'Freebuff CLI account no longer exists. Run "freebuff login" and reconnect.',
        };
        return;
      }
      // Capture private evidence for this turn before another refresh can replace
      // the account map. Never send opaque handles to the CLI settings or UI.
      const expectedModel =
        this.modelHandles.get(account.id)?.get(selection.modelId) ?? selection.modelId;
      const selectedModelDef = availableModels.find(
        (model) => model.apiModelId === selection.modelId && model.accountId === account.id,
      );
      if (
        request.reasoningLevel &&
        selectedModelDef?.reasoningLevels?.length &&
        !selectedModelDef.reasoningLevels.includes(request.reasoningLevel)
      ) {
        yield {
          type: 'error',
          error: 'The selected Freebuff model does not support this reasoning level.',
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
        JSON.stringify(
          buildFreebuffTurnSettings(
            settings,
            selection.modelId,
            selectedModelDef?.reasoningLevels?.includes(request.reasoningLevel ?? '')
              ? request.reasoningLevel
              : undefined,
          ),
        ),
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
        await pasteFreebuffBuffer(tmux, session, buffer);
        const filename = basename(imagePath);
        await waitForFreebuffImageReady(tmux, session, filename, signal);
      }
      await tmux(['load-buffer', '-b', buffer, promptPath]);
      await pasteFreebuffBuffer(tmux, session, buffer);
      await waitForFreebuffPromptReady(tmux, session, transportPrompt, signal);
      await tmux(['send-keys', '-t', session, 'Enter']);

      // The modern CLI can lazily discover MCP tools while constructing the
      // first agent request. Preflight the signed catalog before submission,
      // but wait for actual CLI bridge startup afterward to avoid a deadlock.
      // No completion/content is published until this additional proof exists.
      phase = 'CLI MCP startup';
      const bridgeStartedAt = Date.now();
      let sessionConfirmationSent = false;
      while (!existsSync(prepared.readyPath)) {
        checkAbort(signal);
        if (Date.now() - bridgeStartedAt > 90_000) {
          throw new FreebuffPtyError('Freebuff TUI did not load the Kory MCP bridge');
        }
        await tmux(['has-session', '-t', session]);
        const pane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
        if (freebuffUpdateRequiredPane(pane))
          throw new FreebuffUpdateRequiredError(
            'Freebuff reported its runtime as retired',
            attemptVersion,
          );
        const accountLimit = freebuffAccountLimitError(pane);
        if (accountLimit) throw new FreebuffPtyError(accountLimit);
        if (!sessionConfirmationSent && freebuffNeedsSessionConfirmation(pane)) {
          await tmux(['send-keys', '-t', session, 'Enter']);
          sessionConfirmationSent = true;
        }
        await waitForFreebuffPoll(250, signal);
      }

      const logsRoot = join(runHome, '.config', 'manicode', 'projects');
      const offsets = new Map<string, number>();
      const emittedTools = new Set<string>();
      const pendingToolCalls = new Map<string, Record<string, unknown>>();
      const pendingToolResults = new Map<string, Record<string, unknown>>();
      phase = 'turn completion';
      let selectedModel: string | null = null;
      let lastUpstreamError: FreebuffUpstreamError | null = null;
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

      // The runtime can die between the liveness check and the row drain (the
      // TUI exits inside the container); both paths funnel here. A retired
      // runtime exits its own TUI on the 410 answer, so drain the remaining
      // log rows first — the self-heal must still see the retirement.
      const throwRuntimeDead = async (): Promise<never> => {
        checkAbort(signal);
        const drained = await this.deps
          .readLogRows(runtime!, logsRoot, offsets)
          .catch(() => [] as { data?: unknown; msg?: unknown }[]);
        if (
          drained.some((row) =>
            freebuffUpdateRequiredFromRow(
              row.data && typeof row.data === 'object'
                ? (row.data as Record<string, unknown>)
                : {},
              typeof row.msg === 'string' ? row.msg : '',
            ),
          )
        )
          throw new FreebuffUpdateRequiredError(
            'Codebuff requires a newer Freebuff runtime',
            attemptVersion,
          );
        throw new FreebuffPtyError('Freebuff TUI exited before producing a completion event');
      };

      while (!complete) {
        checkAbort(signal);
        if (Date.now() - lastSessionCheck > 1_000) {
          lastSessionCheck = Date.now();
          try {
            await tmux(['has-session', '-t', session]);
          } catch {
            await throwRuntimeDead();
          }
          const pane = await tmux(['capture-pane', '-p', '-J', '-t', session]);
          if (freebuffUpdateRequiredPane(pane))
            throw new FreebuffUpdateRequiredError(
              'Freebuff reported its runtime as retired',
              attemptVersion,
            );
          const accountLimit = freebuffAccountLimitError(pane);
          if (accountLimit) throw new FreebuffPtyError(accountLimit);
        }
        const rows = await this.deps
          .readLogRows(runtime, logsRoot, offsets)
          .catch(() => throwRuntimeDead());
        checkAbort(signal);
        for (const row of rows) {
          const msg = typeof row.msg === 'string' ? row.msg : '';
          const data =
            row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : {};
          if (freebuffUpdateRequiredFromRow(data, msg))
            throw new FreebuffUpdateRequiredError(
              'Codebuff requires a newer Freebuff runtime',
              attemptVersion,
            );
          if (
            ['Error in AI SDK stream', 'Agent execution failed'].includes(msg) &&
            (data.agentId === undefined || data.agentId === 'main-agent')
          )
            lastUpstreamError = freebuffUpstreamError(data) ?? lastUpstreamError;
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
              rootModel !== expectedModel
            ) {
              const observedModel = [...(this.modelHandles.get(account.id)?.entries() ?? [])].find(
                ([, handle]) => handle === rootModel,
              )?.[0];
              throw new FreebuffPtyError(
                observedModel
                  ? `Freebuff CLI used ${observedModel} instead of the requested model. The CLI may have applied an account fallback; refresh models and reconnect.`
                  : 'Freebuff CLI did not use the requested model; refresh models and reconnect',
              );
            }
            selectedModel = rootModel;
          }
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
          const isRootResponse = rootModel !== null || data.agentId === 'main-agent';
          const response = isRootResponse ? freebuffResponseFromLogRow(row) : null;
          if (response?.trim()) {
            emittedContent = true;
            yield { type: 'content_delta', content: response };
          }
          const completion = freebuffCompletionFromLogRow(
            row,
            emittedContent && selectedModel !== null,
          );
          if (completion === 'error') {
            if (lastUpstreamError) {
              throw Object.assign(
                new FreebuffPtyError(freebuffUpstreamErrorMessage(lastUpstreamError)),
                {
                  transient:
                    lastUpstreamError.isRetryable === true ||
                    lastUpstreamError.statusCode === 429 ||
                    (lastUpstreamError.statusCode !== undefined &&
                      lastUpstreamError.statusCode >= 500),
                },
              );
            }
            throw new FreebuffPtyError('Freebuff main prompt returned an error or no output');
          }
          yield* freebuffToolEvents(data, pendingToolCalls, pendingToolResults, emittedTools);
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
      if (err instanceof FreebuffUpdateRequiredError) {
        // Report retirement to the wrapper; the per-attempt cleanup below
        // still runs before any retry launches.
        state.updateRequired = { version: err.version ?? attemptVersion };
        return;
      }
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
        errorTransient:
          !aborted &&
          ((err as { transient?: boolean }).transient === true ||
            isTransientStreamErrorText(err)),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Give the TUI a moment to run its clean-exit path (defensive lease
      // release; shared with the abort path so it runs at most once) — then
      // the forced cleanup still runs unconditionally.
      await releaseSession(5_000);
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
