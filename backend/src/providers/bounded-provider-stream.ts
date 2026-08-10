export const PROVIDER_STREAM_FRAME_MAX_BYTES = 1024 * 1024;

export class ProviderStreamFrameLimitError extends Error {
  constructor() {
    super('Provider stream frame exceeded the structural limit');
    this.name = 'ProviderStreamFrameLimitError';
  }
}

function exceedsFrameLimit(value: string, maxFrameBytes: number): boolean {
  return value.length > maxFrameBytes || Buffer.byteLength(value, 'utf8') > maxFrameBytes;
}

/** Split an untrusted delimited stream without allowing a newline/SSE-free
 * producer to grow a retained buffer without bound. Completed frames are
 * capped too, before JSON parsing or response transformation. */
export function appendBoundedProviderFrames(
  remainder: string,
  chunk: string,
  maxFrameBytes = PROVIDER_STREAM_FRAME_MAX_BYTES,
): { frames: string[]; remainder: string } {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new TypeError('Provider frame limit must be a positive integer');
  }
  const combined = remainder + chunk;
  const parts = combined.split('\n');
  const nextRemainder = parts.pop() ?? '';
  if (
    exceedsFrameLimit(nextRemainder, maxFrameBytes) ||
    parts.some((frame) => exceedsFrameLimit(frame, maxFrameBytes))
  ) {
    throw new ProviderStreamFrameLimitError();
  }
  return { frames: parts, remainder: nextRemainder };
}

export function assertBoundedProviderFrame(
  frame: string,
  maxFrameBytes = PROVIDER_STREAM_FRAME_MAX_BYTES,
): void {
  if (exceedsFrameLimit(frame, maxFrameBytes)) throw new ProviderStreamFrameLimitError();
}
