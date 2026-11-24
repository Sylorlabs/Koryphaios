/**
 * Host-authored instructions for a continuation turn.
 *
 * A continuation is not something the user typed. The host sends these texts
 * to the provider as the turn's instruction, and the transcript records the
 * continuation as a system marker row, never as a user-role message. The
 * partial output is the interrupted turn's own persisted parts, rendered
 * compactly and bounded so a long turn cannot blow the context window.
 */

import type { TranscriptPart } from '@koryphaios/shared';

/** Upper bound on the partial output carried into a continuation prompt. */
export const CONTINUATION_PARTIAL_OUTPUT_LIMIT = 12_000;

export const RESTART_CONTINUATION_LEAD =
  'The previous run was interrupted by a restart; continue from where you left off.';

export const USAGE_LIMIT_CONTINUATION_LEAD =
  'The previous turn stopped because the provider usage limit was reached. The limit has reset; continue from where you left off.';

const CONTINUATION_RULES =
  'Do not restart the task or repeat completed tool work. Use the partial output below only as a record of what already happened.';

/** The durable system marker a continuation writes into the transcript. */
export function continuationMarkerText(kind: 'restart' | 'usage_limit'): string {
  return kind === 'restart'
    ? '[Koryphaios] Resumed automatically after a backend restart interrupted this turn.'
    : '[Koryphaios] Resumed automatically after the provider usage limit reset.';
}

/** Render a persisted turn's parts as plain, bounded text for the model. */
export function renderPartialOutput(parts: readonly TranscriptPart[] | undefined): string {
  if (!parts || parts.length === 0) {
    return '(No partial output was persisted for the interrupted turn.)';
  }
  const lines: string[] = [];
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text.trim()) lines.push(part.text.trim());
    } else if (part.kind === 'tool') {
      const status =
        part.output === undefined ? 'no result recorded' : part.isError ? 'error' : 'ok';
      const output = part.output ? ` -> ${part.output.slice(0, 400)}` : '';
      lines.push(`[tool ${part.name}: ${status}]${output}`);
    }
  }
  const joined = lines.join('\n\n').trim();
  if (!joined) return '(No partial output was persisted for the interrupted turn.)';
  if (joined.length <= CONTINUATION_PARTIAL_OUTPUT_LIMIT) return joined;
  return `…${joined.slice(joined.length - CONTINUATION_PARTIAL_OUTPUT_LIMIT)}`;
}

export function renderRestartContinuationPrompt(
  parts: readonly TranscriptPart[] | undefined,
): string {
  return [
    RESTART_CONTINUATION_LEAD,
    CONTINUATION_RULES,
    '',
    'Partial output from the interrupted turn:',
    renderPartialOutput(parts),
  ].join('\n');
}

export function renderUsageLimitContinuationPrompt(
  parts: readonly TranscriptPart[] | undefined,
): string {
  return [
    USAGE_LIMIT_CONTINUATION_LEAD,
    CONTINUATION_RULES,
    '',
    'Partial output from the stopped turn:',
    renderPartialOutput(parts),
  ].join('\n');
}
