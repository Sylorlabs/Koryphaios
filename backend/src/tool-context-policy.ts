/**
 * Tool-context policy.
 *
 * A tool result has two audiences: the user (who sees the full output in the
 * transcript) and the agent (whose context window it consumes). This module
 * decides only the second one.
 *
 * Modes:
 *  - `full`    — the bounded output enters the agent's context (the default).
 *  - `summary` — an auxiliary model call compresses the output before it enters
 *                the context. The full text stays in the transcript archive and
 *                is recoverable with fetch_context.
 *  - `hidden`  — the agent sees the tool name, when it ran, how large the
 *                output was, and its archive id. The output itself never enters
 *                the context until the agent asks for it.
 *
 * A per-session override (set by the agent through `manage_context`) wins over
 * the user's project policy, so an agent can make this choice autonomously for
 * the chat it is working in without rewriting the user's configuration.
 */

export type ToolContextMode = 'full' | 'summary' | 'hidden';

export const TOOL_CONTEXT_MODES: readonly ToolContextMode[] = ['full', 'summary', 'hidden'];

/** Outputs shorter than this are never worth a summarizer round-trip. */
export const TOOL_CONTEXT_SUMMARY_MIN_CHARS = 1_200;

/** Hard cap on the summary that enters the agent's context. */
export const TOOL_CONTEXT_SUMMARY_MAX_CHARS = 1_600;

/** How much raw output a summarizer call is allowed to read. */
export const TOOL_CONTEXT_SUMMARY_INPUT_MAX_CHARS = 60_000;

export function normalizeToolContextMode(value: unknown): ToolContextMode | null {
  return value === 'full' || value === 'summary' || value === 'hidden' ? value : null;
}

/** Later layers win: project policy < per-session agent override. */
export function resolveToolContextMode(
  userPolicies: Readonly<Record<string, unknown>> | undefined,
  sessionOverrides: ReadonlyMap<string, ToolContextMode> | undefined,
  toolName: string,
): ToolContextMode {
  const override = sessionOverrides?.get(toolName);
  if (override) return override;
  return normalizeToolContextMode(userPolicies?.[toolName]) ?? 'full';
}

export function isSummaryWorthwhile(outputChars: number): boolean {
  return outputChars > TOOL_CONTEXT_SUMMARY_MIN_CHARS;
}

/** Local wall-clock label used in the agent-visible stub ("when it was used"). */
export function formatToolContextTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSize(chars: number): string {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k`;
  return `${chars}`;
}

/**
 * Cap one tool output for the agent's context without destroying structure.
 *
 * A tool that returns JSON is usually meant to be parsed by the agent, so a
 * plain `slice` at the cap corrupts it (an unterminated string is not a
 * receipt). When the output parses, oversized string leaves are shrunk until
 * the serialized form fits; otherwise the text is sliced as before.
 */
export function capToolOutputForContext(output: string, cap: number, archiveId?: string): string {
  if (output.length <= cap) return output;
  const marker = (omitted: number) =>
    `\n…[truncated ${omitted} chars${archiveId ? ` — durable preview via fetch_context id=${archiveId}` : ''}]`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output.slice(0, cap) + marker(output.length - cap);
  }
  if (typeof parsed === 'string') {
    return JSON.stringify(parsed.slice(0, cap) + marker(parsed.length - cap));
  }

  type Slot = { get: () => string; set: (value: string) => void };
  const slots: Slot[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) {
        if (typeof child === 'string')
          slots.push({
            get: () => String(node[index]),
            set: (value) => void (node[index] = value),
          });
        else collect(child);
      }
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (typeof child === 'string')
          slots.push({
            get: () => String(record[key]),
            set: (value) => void (record[key] = value),
          });
        else collect(child);
      }
    }
  };
  collect(parsed);

  const size = () => JSON.stringify(parsed).length;
  let guard = 0;
  while (size() > cap && slots.length && guard++ < 512) {
    let largest = slots[0]!;
    for (const slot of slots) if (slot.get().length > largest.get().length) largest = slot;
    const current = largest.get();
    if (current.length <= 64) {
      slots.splice(slots.indexOf(largest), 1);
      continue;
    }
    const keep = Math.floor(current.length / 2);
    largest.set(current.slice(0, keep) + marker(current.length - keep));
  }
  // Everything was already a short scalar: the shape cannot absorb the cap.
  if (size() > cap) return output.slice(0, cap) + marker(output.length - cap);
  return JSON.stringify(parsed);
}

/**
 * The `hidden` stub: name, timestamp, size and archive id — never the output.
 * `fetch_context` can still recover the bounded preview.
 */
export function renderHiddenToolOutput(input: {
  toolName: string;
  outputChars: number;
  ts: number;
  archiveId?: string;
}): string {
  return (
    `[withheld from agent context by tool policy] ${input.toolName} ran at ` +
    `${formatToolContextTimestamp(input.ts)} and produced ${formatSize(input.outputChars)} chars. ` +
    (input.archiveId
      ? `Retrieve the bounded preview with fetch_context id=${input.archiveId}.`
      : `No archived preview is available; rerun the tool if you need the output.`)
  );
}

/** The summary header that frames a compressed result in the agent's context. */
export function renderSummaryHeader(input: {
  toolName: string;
  outputChars: number;
  ts: number;
  archiveId?: string;
}): string {
  return (
    `[summarized for agent context] ${input.toolName} ran at ` +
    `${formatToolContextTimestamp(input.ts)} and produced ${formatSize(input.outputChars)} chars.` +
    (input.archiveId ? ` Full output: fetch_context id=${input.archiveId}.` : '')
  );
}

/** Bounded head+tail fallback when the summarizer is unavailable. */
export function fallbackToolOutputPreview(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const head = output.slice(0, Math.floor(maxChars * 0.7));
  const tail = output.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n…[${output.length - head.length - tail.length} chars omitted]…\n${tail}`;
}

export function buildToolSummaryPrompt(input: {
  toolName: string;
  label: string;
  output: string;
}): string {
  const clipped = input.output.slice(0, TOOL_CONTEXT_SUMMARY_INPUT_MAX_CHARS);
  return (
    `Compress this tool result for another agent's context window. Keep the concrete facts it will ` +
    `need to act: file paths, symbols, line numbers, commands, exit status, error messages, ` +
    `counts, and any value it may have to quote. Drop boilerplate, repeated lines, and progress ` +
    `noise. Do not invent anything, do not speculate, and do not add commentary. Use plain text, ` +
    `at most ~${TOOL_CONTEXT_SUMMARY_MAX_CHARS} characters.\n\n` +
    `TOOL: ${input.toolName}\nCALL: ${input.label.slice(0, 240)}\n\nOUTPUT:\n${clipped}`
  );
}

/** Trim provider output down to the summary budget without cutting mid-token. */
export function boundToolSummary(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length <= TOOL_CONTEXT_SUMMARY_MAX_CHARS) return normalized;
  const cut = normalized.slice(0, TOOL_CONTEXT_SUMMARY_MAX_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (lastBreak > TOOL_CONTEXT_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, lastBreak) : cut).trim();
}
