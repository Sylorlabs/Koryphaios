/**
 * Critic gate utilities — parsing verdict and formatting transcripts.
 * Extracted for testability and single responsibility.
 */

/** Parse critic output: last non-empty line should start with PASS or FAIL; otherwise fallback to includes("PASS"). */
export function parseCriticVerdict(content: string): boolean {
  const lines = content.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  const upper = lastLine.toUpperCase();
  if (upper.startsWith("PASS")) return true;
  if (upper.startsWith("FAIL")) return false;
  return content.toUpperCase().includes("PASS");
}

/** Format message list for critic prompt; truncate to maxLength to avoid token overflow. */
export function formatMessagesForCritic(messages: Array<{ role: string; content: string }>, maxLength: number = 12_000): string {
  const raw = messages
    .map((m) => {
      if (m.role === "user") return `[USER]\n${m.content}`;
      if (m.role === "assistant") return `[ASSISTANT]\n${m.content}`;
      if (m.role === "tool") return `[TOOL RESULT]\n${m.content}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  if (raw.length <= maxLength) return raw;
  return raw.slice(0, maxLength) + "\n\n...[truncated]";
}
