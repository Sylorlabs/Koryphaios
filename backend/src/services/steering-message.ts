/**
 * Helpers for host-authored steering messages. Anything copied from the diff,
 * CI logs or reviews is untrusted text, so it is fenced with a delimiter longer
 * than any backtick run it contains and bounded in size.
 */

export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Fenced block whose content cannot close the fence early. */
export function fencedBlock(info: string, content: string): string[] {
  const fence = fenceFor(content);
  return [`${fence}${info}`, ...content.split('\n'), fence];
}

/** Prefix every line so multi-line user or GitHub text stays visually nested. */
export function indentLines(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => `${prefix}${line}`);
}

/** Keep at most `maxLines` lines and `maxChars` characters, marking any cut. */
export function boundLines(
  lines: readonly string[],
  maxLines: number,
  maxChars: number,
): {
  lines: string[];
  truncated: boolean;
} {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= maxLines || chars + line.length > maxChars) {
      return { lines: out, truncated: true };
    }
    out.push(line);
    chars += line.length + 1;
  }
  return { lines: out, truncated: false };
}
