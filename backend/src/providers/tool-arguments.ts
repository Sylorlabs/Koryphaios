/**
 * Tool-call argument normalization for OpenAI-compatible gateways.
 *
 * Gateways that proxy several upstreams do not all stream tool arguments the
 * way the first-party API does. Observed shapes: an empty string for a
 * no-argument tool, arguments truncated when the upstream stops at
 * `finish_reason: "length"`, a stray sentence before the JSON, a fenced code
 * block, or a trailing comma. Handing any of those straight to the turn runtime
 * aborted the entire turn with "Provider tool arguments must be a valid JSON
 * object", which the user experiences as the agent stalling mid-task.
 *
 * Repairing here keeps a bad tool payload a tool-level problem: the call is
 * still delivered, the tool's own schema validation rejects what is wrong, and
 * the model gets a tool error it can react to instead of a dead turn.
 */

export interface NormalizedToolArguments {
  /** Usable argument object. `{}` when nothing parseable could be recovered. */
  input: Record<string, unknown>;
  /** True when the raw bytes needed repair (not already clean JSON). */
  repaired: boolean;
  /** False when the payload was unusable and `input` is an empty fallback. */
  recovered: boolean;
}

const EMPTY: NormalizedToolArguments = { input: {}, repaired: false, recovered: true };

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Drop a leading fence/prose and a trailing fence so the JSON body remains. */
function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf('{');
  return firstBrace > 0 ? text.slice(firstBrace) : text;
}

/** Index just past the last top-level `}` in `text`, or -1. */
function endOfTopLevelObject(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Close whichever braces/brackets the upstream cut off mid-stream. */
function closeOpenContainers(text: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      stack.pop();
      depth += 1;
    }
  }
  if (inString) return text;
  let repaired = text.replace(/,\s*$/, '');
  while (stack.length) repaired += stack.pop();
  return depth >= 0 ? repaired : text;
}

/**
 * Normalize a streamed argument string into a JSON object.
 *
 * Never throws, and never returns a non-object: an array or scalar payload is
 * reported as unrecovered so the caller can skip the call rather than execute a
 * tool with a shape its schema cannot accept.
 */
export function normalizeToolArguments(raw: string | undefined | null): NormalizedToolArguments {
  const text = (raw ?? '').trim();
  if (!text) return EMPTY;

  const direct = tryParse(text);
  if (direct) return { input: direct, repaired: false, recovered: true };

  const candidates = [stripFences(text), closeOpenContainers(stripFences(text))];
  const end = endOfTopLevelObject(text);
  if (end > 0) candidates.push(text.slice(0, end));
  const endStripped = endOfTopLevelObject(stripFences(text));
  if (endStripped > 0) candidates.push(stripFences(text).slice(0, endStripped));

  for (const candidate of candidates) {
    const cleaned = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/^\uFEFF/, '')
      .trim();
    if (!cleaned) continue;
    const parsed = tryParse(cleaned) ?? tryParse(closeOpenContainers(cleaned));
    if (parsed) return { input: parsed, repaired: true, recovered: true };
  }

  return { input: {}, repaired: true, recovered: false };
}
