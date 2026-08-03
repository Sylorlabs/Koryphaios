export function markdownToSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?(?:thinking|tool|directive)[^>]*>[\s\S]*?<\/(?:thinking|tool|directive)>/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^#{1,6}\s+(.+)$/gm, '$1. ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[`*_~>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chunkSpeech(text: string, maxChars = 1200): string[] {
  if (maxChars < 1) throw new Error('maxChars must be positive');
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [];
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars).trim());
    } else if (chunks.length && `${chunks.at(-1)} ${sentence}`.length <= maxChars) chunks[chunks.length - 1] += ` ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}
