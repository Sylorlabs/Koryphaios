// Stitching helpers for incremental (streaming) dictation.
//
// The live transcriber works on a sliding window rather than the whole capture,
// so consecutive passes overlap and re-hear the words in that overlap. These
// helpers keep the joined transcript from repeating those words, and cut the
// window out of the captured blocks.

/** Split text into words, ignoring whitespace-only fragments. */
export function transcriptWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function comparable(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Append the newest piece of transcript to the text already committed.
 *
 * The longest run of words the two share at the seam is counted once, so the
 * overlap a sliding window re-transcribes does not duplicate words. Matching
 * ignores case and punctuation, because two passes rarely punctuate a seam the
 * same way.
 */
export function mergeTranscript(committed: string, piece: string): string {
  const left = transcriptWords(committed);
  const right = transcriptWords(piece);
  if (!left.length) return right.join(' ');
  if (!right.length) return left.join(' ');
  const largest = Math.min(left.length, right.length);
  for (let size = largest; size > 0; size -= 1) {
    let shared = true;
    for (let index = 0; index < size; index += 1) {
      if (comparable(left[left.length - size + index]) !== comparable(right[index])) {
        shared = false;
        break;
      }
    }
    if (shared) return [...left, ...right.slice(size)].join(' ');
  }
  return [...left, ...right].join(' ');
}

/** Drop the first `fromFrame` samples and keep the rest as one contiguous block. */
export function sliceAudioChunks(chunks: Float32Array[], fromFrame: number): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const start = Math.max(0, Math.min(Math.round(fromFrame), total));
  const output = new Float32Array(total - start);
  let offset = 0;
  let written = 0;
  for (const chunk of chunks) {
    const chunkStart = offset;
    offset += chunk.length;
    if (offset <= start) continue;
    const skip = Math.max(0, start - chunkStart);
    output.set(chunk.subarray(skip), written);
    written += chunk.length - skip;
  }
  return output;
}
