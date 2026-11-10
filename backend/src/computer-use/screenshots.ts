import type { ComputerUseReceipt } from '@koryphaios/shared';

/** Pixels are ephemeral, session-scoped media; only their opaque reference enters the transcript. */
export class ComputerScreenshotStore {
  private entries = new Map<string, { sessionId: string; expiresAt: number; bytes: Uint8Array }>();
  private size = 0;
  constructor(private readonly now = Date.now, private readonly maxBytes = 32 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000) {}

  private prune() {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.remove(id);
    }
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.size -= entry.bytes.byteLength;
    this.entries.delete(id);
  }
  put(sessionId: string, base64: string): NonNullable<ComputerUseReceipt['screenshot']> {
    this.prune();
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.byteLength > this.maxBytes) throw new Error('Screenshot exceeds preview capacity');
    while (this.size + bytes.byteLength > this.maxBytes) this.remove(this.entries.keys().next().value!);
    const id = crypto.randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(id, { sessionId, bytes, expiresAt });
    this.size += bytes.byteLength;
    return { id, expiresAt };
  }
  get(sessionId: string, id: string): Uint8Array | undefined {
    this.prune();
    const entry = this.entries.get(id);
    return entry?.sessionId === sessionId ? entry.bytes : undefined;
  }
}

export const computerScreenshots = new ComputerScreenshotStore();
