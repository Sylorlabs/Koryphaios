/**
 * Compaction-output JSON recovery.
 *
 * Compactor models (especially chatty ChatGPT-web-backed ones) often preface
 * the required checkpoint object with prose ("I ...") or append commentary
 * after it. The compaction prompt demands JSON-only, but a single
 * fence-strip is not enough when prose surrounds the object. This extracts
 * the first balanced {...} span so one chatty sentence cannot fail the whole
 * compaction. Unbalanced / brace-free input is returned as-is so JSON.parse
 * still reports it and the original history stays preserved (fail-closed).
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text;
}

/** How many outer JSON-string layers to unwrap (a compactor that
 *  JSON-encodes its answer once is the common case; the loop tolerates
 *  double-wrapping without spinning on hostile input). */
const CHECKPOINT_OUTER_UNWRAP_LIMIT = 3;

function stripCheckpointFences(text: string): string {
  const trimmed = text.trim();
  // Prefer the fenced block when one exists, even with prose before/after it
  // (a compactor that JSON-encodes its answer inside a ```json fence is the
  // exact backslash failure this decoder exists to fix).
  const firstFence = trimmed.indexOf('```');
  const lastFence = trimmed.lastIndexOf('```');
  if (firstFence !== -1 && lastFence > firstFence) {
    const firstLineEnd = trimmed.indexOf('\n', firstFence);
    if (firstLineEnd !== -1 && firstLineEnd < lastFence) {
      const inner = trimmed.slice(firstLineEnd + 1, lastFence).trim();
      if (inner) return inner;
    }
  }
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

/** Tolerant checkpoint decode for compactor output.
 *
 *  Some compactors return the checkpoint JSON-encoded as a *string*
 *  (`"{\"projectBrief\": ... }"`), sometimes wrapped in fences or prose.
 *  Feeding that straight into the brace-scan finds the first `{` *inside*
 *  the string and JSON.parse then dies on the backslash escapes with
 *  `Unrecognized token '\'`. This decodes in order — direct parse, fence
 *  strip, prose brace-scan — unwrapping outer JSON-string layers at every
 *  step, and throws the last JSON error when nothing parses, so the caller
 *  still fails closed with history preserved.
 */
export function parseCheckpointJson(raw: string): Record<string, unknown> {
  let lastError: unknown = null;
  const trimmed = raw.trim();
  const stripped = stripCheckpointFences(raw);
  const scanned = extractJsonObject(stripped);
  const candidates = [trimmed];
  if (stripped !== trimmed) candidates.push(stripped);
  if (scanned !== stripped && scanned !== trimmed) candidates.push(scanned);
  for (const candidate of candidates) {
    // Unwrap outer JSON-string layers: a direct parse can "succeed" into a
    // string, which is still not the checkpoint object.
    let text = candidate;
    for (let layer = 0; layer <= CHECKPOINT_OUTER_UNWRAP_LIMIT; layer++) {
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value === 'string') {
          text = value;
          continue;
        }
        return value as Record<string, unknown>;
      } catch (error) {
        lastError = error;
        break;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Compaction checkpoint is not valid JSON');
}
