import { readFile, stat } from 'node:fs/promises';

export interface FreebuffBundledModel {
  id: string;
  name: string;
  multimodal: boolean;
  /** Full model window used by this exact installed Freebuff build. */
  contextWindow?: number;
  reasoningLevels?: string[];
}

export interface FreebuffBundledCatalog {
  cliVersion: string;
  models: FreebuffBundledModel[];
  /** Modern pickers are server/account owned, not a list of bundled model IDs. */
  selectionMode?: 'cli-managed';
}

/** A selection policy, NOT an upstream model ID or a claim of account access. */
export const FREEBUFF_CLI_DEFAULT_MODEL_ID = 'freebuff/cli-default';
/** Kory routing ID wrapping the CLI's stable picker key, never its opaque handle. */
export const FREEBUFF_CATALOG_MODEL_PREFIX = 'freebuff/catalog-';
export function freebuffCatalogKeyFromModelId(modelId: string): string | null {
  if (!modelId.startsWith(FREEBUFF_CATALOG_MODEL_PREFIX)) return null;
  const key = modelId.slice(FREEBUFF_CATALOG_MODEL_PREFIX.length);
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(key) ? key : null;
}

// 0.2.12 embeds this public catalog protocol but holds the fetched catalog only
// in memory. Older static picker objects still exist as fallback implementation
// details: they must never be advertised as the modern account's available models.
const DYNAMIC_CATALOG_ANCHORS = [
  '"x-freebuff-catalog-protocol"',
  '"/api/v1/freebuff/models"',
  '"freebuff_catalog_stale"',
  'recommendedKey:',
  'fallbackKey:',
  'freebuffModelKey',
  'freebuffCatalogReasoningEfforts',
];

/** Credential-free inspection inside the execution sandbox. Only public protocol
 * markers/version leave it, not executable contents or any account data. */
export const FREEBUFF_DYNAMIC_CATALOG_PROBE = `
const { readFileSync } = require('node:fs');
const bytes = readFileSync(process.argv[1]);
const anchors = ${JSON.stringify(DYNAMIC_CATALOG_ANCHORS)};
const start = bytes.indexOf('CODEBUFF_CLI_VERSION:"');
const version = start < 0 ? null : bytes.subarray(start, start + 128).toString('latin1')
  .match(/CODEBUFF_CLI_VERSION:"(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)"/)?.[1];
if (!version || !anchors.every(anchor => bytes.includes(Buffer.from(anchor))))
  throw Error('Unrecognized Freebuff execution catalog protocol');
process.stdout.write('CODEBUFF_CLI_VERSION:' + JSON.stringify(version) + ';' + anchors.join(';'));
`;

const VERSION_ANCHOR = 'CODEBUFF_CLI_VERSION:"';
const ACCESS_TIER_ANCHOR = '!=="limited")return ';
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
const MEMBER_PATTERN = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
const CATALOG_WINDOW_BEFORE = 16 * 1024;
const CATALOG_WINDOW_AFTER = 192 * 1024;
const CONTEXT_WINDOW_ANCHOR = 'const contextWindow = {';
const MAX_CONTEXT_SOURCE_BYTES = 16 * 1024;

const cache = new Map<string, Promise<FreebuffBundledCatalog>>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeQuotedString(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error('Freebuff bundled catalog contains an invalid string literal');
  }
}

function readQuoted(text: string, start: number): { literal: string; end: number } | null {
  if (text[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return { literal: text.slice(start, index + 1), end: index + 1 };
  }
  return null;
}

function readDelimited(text: string, start: number, open: string, close: string): string | null {
  if (text[start] !== open) return null;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function assignmentDelimited(
  text: string,
  symbol: string,
  open: '[' | '{',
  close: ']' | '}',
): string | null {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}=\\${open}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].lastIndexOf(open);
    const value = readDelimited(text, start, open, close);
    if (value) return value;
  }
  return null;
}

function booleanAssignment(text: string, symbol: string): boolean | null {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}=(!0|!1|true|false)(?=[,;}])`,
    'g',
  );
  let value: boolean | null = null;
  for (const match of text.matchAll(pattern)) {
    value = match[1] === '!0' || match[1] === 'true';
  }
  return value;
}

function parseModelObject(
  region: string,
  symbol: string,
): { idExpression: string; name: string; multimodal: boolean } | null {
  const object = assignmentDelimited(region, symbol, '{', '}');
  if (!object || !object.includes('displayName:') || !object.includes('multimodal:')) return null;
  const id = object.match(/(?:^|[,\{])id:([^,}]+)/)?.[1]?.trim();
  const name = object.match(/(?:^|[,\{])displayName:("(?:\\.|[^"\\])*")/)?.[1];
  const multimodal = object.match(/(?:^|[,\{])multimodal:(!0|!1|true|false)(?=[,}])/)?.[1];
  if (!id || !name || !multimodal) return null;
  return {
    idExpression: id,
    name: decodeQuotedString(name),
    multimodal: multimodal === '!0' || multimodal === 'true',
  };
}

function readAssignmentFromBuffer(bundle: Buffer, symbol: string): string | null {
  const needle = Buffer.from(`${symbol}=`, 'ascii');
  let offset = 0;
  while ((offset = bundle.indexOf(needle, offset)) >= 0) {
    const previous = offset > 0 ? String.fromCharCode(bundle[offset - 1]!) : '';
    if (!/[A-Za-z0-9_$]/.test(previous)) {
      const preview = bundle
        .subarray(offset + needle.length, offset + needle.length + 256)
        .toString('latin1');
      if (preview.startsWith('"')) {
        const quoted = readQuoted(preview, 0);
        if (quoted) return quoted.literal;
      }
      const expression = preview.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/)?.[1];
      if (expression) return expression;
    }
    offset += needle.length;
  }
  return null;
}

function readMemberStringFromBuffer(bundle: Buffer, property: string): string | null {
  const needles = [`${property}:"`, `"${property}":"`];
  const values = new Set<string>();
  for (const rawNeedle of needles) {
    const needle = Buffer.from(rawNeedle, 'ascii');
    let offset = 0;
    while ((offset = bundle.indexOf(needle, offset)) >= 0) {
      const quoteOffset = offset + rawNeedle.length - 1;
      const preview = bundle.subarray(quoteOffset, quoteOffset + 512).toString('latin1');
      const quoted = readQuoted(preview, 0);
      if (quoted) {
        const value = decodeQuotedString(quoted.literal);
        if (MODEL_ID_PATTERN.test(value)) values.add(value);
      }
      offset += needle.length;
    }
  }
  if (values.size === 1) return [...values][0]!;
  if (values.size > 1) {
    throw new Error(`Freebuff bundled catalog property ${property} resolves ambiguously`);
  }
  return null;
}

function resolveModelId(
  bundle: Buffer,
  expression: string,
  seen: Set<string> = new Set(),
): string | null {
  const trimmed = expression.trim();
  if (trimmed.startsWith('"')) {
    const quoted = readQuoted(trimmed, 0);
    if (!quoted) return null;
    const value = decodeQuotedString(quoted.literal);
    return MODEL_ID_PATTERN.test(value) ? value : null;
  }
  const member = trimmed.match(MEMBER_PATTERN);
  if (member) return readMemberStringFromBuffer(bundle, member[2]!);
  if (!IDENTIFIER_PATTERN.test(trimmed) || seen.has(trimmed)) return null;
  seen.add(trimmed);
  const assigned = readAssignmentFromBuffer(bundle, trimmed);
  return assigned ? resolveModelId(bundle, assigned, seen) : null;
}

function resolveArraySymbol(region: string, symbol: string, seen = new Set<string>()): string {
  if (seen.has(symbol)) throw new Error(`Freebuff bundled catalog array cycle at ${symbol}`);
  seen.add(symbol);
  const direct = assignmentDelimited(region, symbol, '[', ']');
  if (direct) return direct;
  const alias = region.match(
    new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}=([A-Za-z_$][\\w$]*)\\.map\\(`),
  )?.[1];
  if (alias) return resolveArraySymbol(region, alias, seen);
  throw new Error(`Freebuff bundled catalog array ${symbol} was not found`);
}

function modelSymbolsFromArray(
  region: string,
  arrayExpression: string,
  seenArrays = new Set<string>(),
): string[] {
  let expanded = arrayExpression;
  const conditional = /\.\.\.([A-Za-z_$][\w$]*)\?\[([^\[\]]*)\]:\[\]/g;
  expanded = expanded.replace(conditional, (_whole, flag: string, enabledBody: string) => {
    const enabled = booleanAssignment(region, flag);
    if (enabled === null) {
      throw new Error(`Freebuff bundled catalog flag ${flag} was not found`);
    }
    return enabled ? enabledBody : '';
  });

  const result: string[] = [];
  for (const match of expanded.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const symbol = match[0];
    if (parseModelObject(region, symbol)) {
      result.push(symbol);
      continue;
    }
    if (booleanAssignment(region, symbol) !== null) continue;
    if (seenArrays.has(symbol)) continue;
    try {
      seenArrays.add(symbol);
      const nested = resolveArraySymbol(region, symbol);
      result.push(...modelSymbolsFromArray(region, nested, seenArrays));
    } catch {
      throw new Error(`Freebuff bundled catalog menu symbol ${symbol} could not be resolved`);
    }
  }
  return result;
}

function parseVersion(bundle: Buffer): string {
  const offset = bundle.indexOf(Buffer.from(VERSION_ANCHOR, 'ascii'));
  if (offset < 0) throw new Error('Freebuff bundled CLI version was not found');
  const start = offset + VERSION_ANCHOR.length - 1;
  const preview = bundle.subarray(start, start + 128).toString('latin1');
  const quoted = readQuoted(preview, 0);
  const version = quoted ? decodeQuotedString(quoted.literal) : '';
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Freebuff bundled CLI version is invalid');
  }
  return version;
}

function parsePositiveNumberLiteral(value: string): number | null {
  const normalized = value.replace(/_/g, '');
  if (!/^(?:\d+(?:\.\d+)?|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 1_024 ? parsed : null;
}

/**
 * Freebuff serializes its provider-owned context-window table into the bundled
 * base-chat agent's handleSteps function. Read that table rather than copying
 * it into Koryphaios. Models absent from the table deliberately inherit the
 * installed CLI's conservative default from the same expression.
 */
function parseContextWindows(
  bundle: Buffer,
  modelIds: Set<string>,
): { byModel: Map<string, number>; defaultWindow: number } | null {
  const anchor = Buffer.from(CONTEXT_WINDOW_ANCHOR, 'ascii');
  let offset = 0;
  let best:
    { byModel: Map<string, number>; defaultWindow: number; matchingModels: number } | undefined;
  while ((offset = bundle.indexOf(anchor, offset)) >= 0) {
    const source = bundle
      .subarray(offset, Math.min(bundle.length, offset + MAX_CONTEXT_SOURCE_BYTES))
      .toString('latin1');
    const match = source.match(
      /const contextWindow\s*=\s*\{([\s\S]{1,12000}?)\}\[model\s*\?\?\s*""\]\s*\?\?\s*([0-9][0-9_eE.+-]*)/,
    );
    if (match) {
      const defaultWindow = parsePositiveNumberLiteral(match[2]!);
      if (defaultWindow) {
        const byModel = new Map<string, number>();
        for (const entry of match[1]!.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*([0-9][0-9_eE.+-]*)/g)) {
          const id = decodeQuotedString(entry[1]!);
          const contextWindow = parsePositiveNumberLiteral(entry[2]!);
          if (MODEL_ID_PATTERN.test(id) && contextWindow) byModel.set(id, contextWindow);
        }
        const matchingModels = [...modelIds].filter((id) => byModel.has(id)).length;
        if (!best || matchingModels > best.matchingModels) {
          best = { byModel, defaultWindow, matchingModels };
        }
      }
    }
    offset += anchor.length;
  }
  return best ? { byModel: best.byModel, defaultWindow: best.defaultWindow } : null;
}

function findCatalogRegion(bundle: Buffer): {
  region: string;
  fullMenuSymbol: string;
  limitedMenuSymbol: string;
} {
  const anchor = Buffer.from(ACCESS_TIER_ANCHOR, 'ascii');
  let offset = 0;
  while ((offset = bundle.indexOf(anchor, offset)) >= 0) {
    const start = Math.max(0, offset - CATALOG_WINDOW_BEFORE);
    const end = Math.min(bundle.length, offset + CATALOG_WINDOW_AFTER);
    const region = bundle.subarray(start, end).toString('latin1');
    const match = region.match(
      /function\s+[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=(?:!1|false)\)\{if\(\1!=="limited"\)return\s+([A-Za-z_$][\w$]*);if\(!\2\)return\s+([A-Za-z_$][\w$]*);/,
    );
    if (match) {
      return { region, fullMenuSymbol: match[3]!, limitedMenuSymbol: match[4]! };
    }
    offset += anchor.length;
  }
  throw new Error('Freebuff bundled access-tier catalog was not found');
}

/**
 * Extract the exact picker catalog and native image capability flags embedded
 * in the installed Freebuff executable. The parser intentionally recognizes
 * Freebuff's catalog semantics (full/limited access tier function plus model
 * objects) instead of treating every provider/model string in the binary as a
 * selectable model. Modern builds identify the dynamic protocol; account models
 * are discovered separately through the authenticated catalog endpoint.
 */
export function parseFreebuffBundledCatalog(bundle: Uint8Array): FreebuffBundledCatalog {
  const buffer = Buffer.isBuffer(bundle) ? bundle : Buffer.from(bundle);
  const cliVersion = parseVersion(buffer);
  if (DYNAMIC_CATALOG_ANCHORS.every((anchor) => buffer.includes(Buffer.from(anchor, 'ascii')))) {
    return {
      cliVersion,
      selectionMode: 'cli-managed',
      models: [
        {
          id: FREEBUFF_CLI_DEFAULT_MODEL_ID,
          name: 'Freebuff CLI default',
          // The dynamic selection can change after catalog refresh. No capability
          // can honestly be asserted before the CLI has resolved its selection.
          multimodal: false,
        },
      ],
    };
  }
  if (buffer.includes(Buffer.from('"x-freebuff-catalog-protocol"', 'ascii'))) {
    throw new Error(
      'Freebuff dynamic catalog protocol is not recognized; reconnect with a supported CLI',
    );
  }
  const { region, fullMenuSymbol } = findCatalogRegion(buffer);
  const menu = resolveArraySymbol(region, fullMenuSymbol);
  const symbols = modelSymbolsFromArray(region, menu);
  const parsedModels: FreebuffBundledModel[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const object = parseModelObject(region, symbol);
    if (!object) throw new Error(`Freebuff bundled model ${symbol} could not be parsed`);
    const id = resolveModelId(buffer, object.idExpression);
    if (!id) throw new Error(`Freebuff bundled model ${object.name} has no resolvable id`);
    if (seen.has(id)) throw new Error(`Freebuff bundled catalog repeats model ${id}`);
    seen.add(id);
    parsedModels.push({ id, name: object.name, multimodal: object.multimodal });
  }
  if (parsedModels.length === 0) throw new Error('Freebuff bundled picker catalog is empty');
  const context = parseContextWindows(buffer, seen);
  const models = parsedModels.map((model) => ({
    ...model,
    ...(context ? { contextWindow: context.byModel.get(model.id) ?? context.defaultWindow } : {}),
  }));
  return { cliVersion, models };
}

/** Read and cache a catalog by the executable's exact on-disk revision. */
export async function discoverFreebuffBundledCatalog(
  binaryPath: string,
): Promise<FreebuffBundledCatalog> {
  const metadata = await stat(binaryPath);
  const signature = `${binaryPath}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  const existing = cache.get(signature);
  if (existing) return existing;
  const pending = readFile(binaryPath).then((bundle) => parseFreebuffBundledCatalog(bundle));
  for (const key of cache.keys()) {
    if (key.startsWith(`${binaryPath}:`)) cache.delete(key);
  }
  cache.set(signature, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(signature);
    throw error;
  }
}

const MODEL_SETTING_STRINGS = [
  'mode',
  'freebuffModel',
  'freebuffModelKey',
  'freebuffModelDefaultMigration',
  'freebucksIntroSeenAt',
] as const;
const MODEL_SETTING_BOOLEANS = [
  'adsEnabled',
  'alwaysUseALaCarte',
  'fallbackToALaCarte',
  'hasSubmittedFirstPrompt',
] as const;
const MODEL_SETTING_MAPS = ['freebuffReasoningEfforts', 'freebuffCatalogReasoningEfforts'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Preserve CLI-owned selection exactly, including modern stable catalog keys,
 * legacy migration stamps and per-model reasoning/billing preferences. Read only
 * the profile's settings.json; never merge credentials, environment or BYOK
 * connection stores. Callers must write this result to the private turn HOME
 * with mode 0600 and delete it at turn cleanup. No settings values are logged.
 *
 * No model setting is synthesized for CLI default: the CLI owns migration,
 * account availability, recommendation and stale-handle recovery. Modern explicit
 * selections use the CLI's stable key setter and remove the legacy picker value;
 * leaving that old value beside the modern key makes the native TUI silently
 * select the legacy model. The migration stamp remains CLI-owned state.
 * Legacy selections use its old bundled picker setter.
 * The caller must check
 * that selection against its discovered catalog before calling this function.
 */
export function buildFreebuffTurnSettings(
  source: unknown,
  selectedModel: string,
  reasoningLevel?: string,
): Record<string, unknown> {
  if (!isRecord(source)) throw new Error('Freebuff settings must be a JSON object');
  if (source.byokConnection !== undefined && source.byokConnection !== null) {
    throw new Error(
      'Freebuff BYOK selection cannot be transported by this CLI adapter; select a Freebuff-managed model in the CLI first',
    );
  }
  const catalogKey = freebuffCatalogKeyFromModelId(selectedModel);
  if (
    (selectedModel.startsWith(FREEBUFF_CATALOG_MODEL_PREFIX) && !catalogKey) ||
    (selectedModel !== FREEBUFF_CLI_DEFAULT_MODEL_ID && !MODEL_ID_PATTERN.test(selectedModel))
  ) {
    throw new Error('Freebuff model selection is invalid');
  }
  const settings: Record<string, unknown> = {};
  for (const key of MODEL_SETTING_STRINGS) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'string')
      throw new Error(`Freebuff settings field ${key} must be a string`);
    settings[key] = source[key];
  }
  for (const key of MODEL_SETTING_BOOLEANS) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== 'boolean')
      throw new Error(`Freebuff settings field ${key} must be a boolean`);
    settings[key] = source[key];
  }
  for (const key of MODEL_SETTING_MAPS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
      throw new Error(`Freebuff settings field ${key} must be a string map`);
    }
    // Copy without normalizing keys/efforts or sharing mutable profile state.
    settings[key] = Object.fromEntries(Object.entries(value));
  }
  if (catalogKey) {
    // The native TUI gives the legacy picker value precedence when both are
    // present, silently selecting a different model. Keep the explicit modern
    // key authoritative by removing only that legacy picker value; the
    // migration stamp is still needed by the CLI's catalog resolver.
    settings.freebuffModelKey = catalogKey;
    delete settings.freebuffModel;
    if (reasoningLevel !== undefined) {
      settings.freebuffCatalogReasoningEfforts = {
        ...(settings.freebuffCatalogReasoningEfforts as Record<string, string> | undefined),
        [catalogKey]: reasoningLevel,
      };
    }
  } else if (selectedModel !== FREEBUFF_CLI_DEFAULT_MODEL_ID) {
    settings.freebuffModel = selectedModel;
    // This is the CLI's own legacy set-selection behavior. Leaving a modern
    // key here would silently override the explicitly requested legacy model.
    delete settings.freebuffModelKey;
  }
  return settings;
}

/**
 * Actual root-model evidence from the CLI's own SDK logs. Start rows do not
 * identify the agent; End rows do. Never infer the root from row ordering or an
 * agent-template name (nested agents may use the same template/model).
 * Modern values may be opaque CLI model handles: keep them private, do not
 * advertise them as provider IDs or emit them in diagnostics.
 */
export function freebuffSelectedModelFromLogRow(row: Record<string, unknown>): string | null {
  if (typeof row.msg !== 'string' || !row.msg.startsWith('End agent ')) return null;
  const data = row.data;
  if (!isRecord(data) || data.agentId !== 'main-agent') return null;
  if (typeof data.model !== 'string' || !data.model.trim() || /[\x00-\x1f\x7f]/.test(data.model))
    return null;
  return data.model;
}

export function resetFreebuffBundledCatalogCacheForTests(): void {
  cache.clear();
}
