import { readFileSync } from 'node:fs';

// JSONL transcript format for recorded CLI turns.
//
// Line 1 is a header. Every following line is one frame:
//
//   {"t":0,"stream":"stdout","data":"...raw bytes the CLI wrote..."}
//   {"t":12,"stream":"stderr","data":"..."}
//   {"t":40,"stream":"stdin-expect","match":"substring"}          (string match)
//   {"t":40,"stream":"stdin-expect","match":{"method":"initialize"}} (JSON subset)
//   {"t":900,"stream":"exit","code":0}
//
// `t` is the millisecond offset from the start of the recording. Replay ignores
// it unless asked for real-time pacing. A `stdin-expect` frame makes replay wait
// until the adapter writes a matching stdin line before emitting the frames that
// follow it. This is how bidirectional protocols (ACP JSON-RPC) are replayed.
//
// Inside stdout/stderr data, the token `{{id}}` is replaced with the JSON value of
// the `id` field from the most recently matched stdin line. ACP request ids are
// random per request, so a fixture can answer a request without knowing its id.

export interface TranscriptHeader {
  provider: string;
  cliVersion: string;
  recordedAt: string;
  argv: string[];
  /** True for hand-authored fixtures. A real recording replaces them and sets false. */
  synthetic?: boolean;
}

/** Subset match: every key in `expected` must match `actual`, recursively. Arrays
 *  must have the same length and match element-wise. Primitives compare by value. */
export type JsonSubset =
  string | number | boolean | null | JsonSubset[] | { [key: string]: JsonSubset };

export type TranscriptFrame =
  | { t: number; stream: 'stdout' | 'stderr'; data: string }
  | { t: number; stream: 'stdin-expect'; match: string | JsonSubset }
  | { t: number; stream: 'exit'; code: number };

export interface Transcript {
  header: TranscriptHeader;
  frames: TranscriptFrame[];
}

export class TranscriptFormatError extends Error {
  constructor(source: string, line: number, message: string) {
    super(`${source}:${line}: ${message}`);
    this.name = 'TranscriptFormatError';
  }
}

const STREAMS = new Set(['stdout', 'stderr', 'stdin-expect', 'exit']);

/** True when `actual` contains everything `expected` names (see JsonSubset). */
export function jsonSubsetMatches(expected: JsonSubset, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => jsonSubsetMatches(item, actual[index]));
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    jsonSubsetMatches(value, (actual as Record<string, unknown>)[key]),
  );
}

/** Does one stdin line satisfy a `stdin-expect` frame? String matches are
 *  substrings of the raw line; object matches are JSON subsets of the parsed line. */
export function stdinLineMatches(match: string | JsonSubset, line: string): boolean {
  if (typeof match === 'string') return line.includes(match);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  return jsonSubsetMatches(match, parsed);
}

export function parseTranscript(text: string, source = 'transcript'): Transcript {
  const lines = text.split('\n');
  let header: TranscriptHeader | undefined;
  const frames: TranscriptFrame[] = [];
  let lastT = 0;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new TranscriptFormatError(source, lineNo, 'not valid JSON');
    }
    if (!isObject(value)) throw new TranscriptFormatError(source, lineNo, 'expected a JSON object');
    if (header === undefined) {
      header = parseHeader(value, source, lineNo);
      return;
    }
    const frame = parseFrame(value, source, lineNo);
    if (frame.t < lastT) throw new TranscriptFormatError(source, lineNo, 't must not decrease');
    lastT = frame.t;
    frames.push(frame);
  });
  if (!header) throw new TranscriptFormatError(source, 1, 'missing header line');
  return { header, frames };
}

export function serializeTranscript(transcript: Transcript): string {
  const out = [JSON.stringify(transcript.header)];
  for (const frame of transcript.frames) out.push(JSON.stringify(frame));
  return `${out.join('\n')}\n`;
}

export function loadTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'), path);
}

function parseHeader(
  value: Record<string, unknown>,
  source: string,
  line: number,
): TranscriptHeader {
  if (typeof value.provider !== 'string' || !value.provider)
    throw new TranscriptFormatError(source, line, 'header.provider must be a non-empty string');
  if (typeof value.cliVersion !== 'string')
    throw new TranscriptFormatError(source, line, 'header.cliVersion must be a string');
  if (typeof value.recordedAt !== 'string')
    throw new TranscriptFormatError(source, line, 'header.recordedAt must be a string');
  if (!Array.isArray(value.argv) || !value.argv.every((arg) => typeof arg === 'string'))
    throw new TranscriptFormatError(source, line, 'header.argv must be a string array');
  if (value.synthetic !== undefined && typeof value.synthetic !== 'boolean')
    throw new TranscriptFormatError(source, line, 'header.synthetic must be a boolean');
  return {
    provider: value.provider,
    cliVersion: value.cliVersion,
    recordedAt: value.recordedAt,
    argv: value.argv as string[],
    ...(value.synthetic !== undefined ? { synthetic: value.synthetic } : {}),
  };
}

function parseFrame(value: Record<string, unknown>, source: string, line: number): TranscriptFrame {
  const t = value.t;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0)
    throw new TranscriptFormatError(source, line, 't must be a non-negative number');
  if (typeof value.stream !== 'string' || !STREAMS.has(value.stream))
    throw new TranscriptFormatError(
      source,
      line,
      'stream must be stdout, stderr, stdin-expect or exit',
    );
  switch (value.stream) {
    case 'stdout':
    case 'stderr':
      if (typeof value.data !== 'string')
        throw new TranscriptFormatError(source, line, `${value.stream} frame needs string data`);
      return { t, stream: value.stream, data: value.data };
    case 'stdin-expect': {
      const match = value.match;
      if (typeof match !== 'string' && !isJsonSubset(match))
        throw new TranscriptFormatError(source, line, 'stdin-expect needs a string or JSON match');
      return { t, stream: 'stdin-expect', match: match as string | JsonSubset };
    }
    case 'exit':
      if (!Number.isInteger(value.code))
        throw new TranscriptFormatError(source, line, 'exit frame needs an integer code');
      return { t, stream: 'exit', code: value.code as number };
  }
  throw new TranscriptFormatError(source, line, 'unreachable stream');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonSubset(value: unknown): value is JsonSubset {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonSubset);
  if (isObject(value)) return Object.values(value).every(isJsonSubset);
  return false;
}
