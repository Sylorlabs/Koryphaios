export interface AttachmentObjectUrlSource {
  id: string;
}

type FetchAttachment = (path: string) => Promise<Response>;

/**
 * Owns authenticated attachment blob URLs for one rendered note.
 *
 * The source URL is deliberately path-only: bearer credentials stay in the
 * Authorization header supplied by apiFetch and never enter DOM attributes,
 * history, logs, or copied links.
 */
export class AttachmentObjectUrlRegistry {
  private generation = 0;
  private active = new Map<string, string>();
  private failed = new Set<string>();

  get failedIds(): readonly string[] {
    return [...this.failed];
  }

  constructor(
    private readonly fetchAttachment: FetchAttachment,
    private readonly createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    private readonly revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
  ) {}

  async replace(sources: readonly AttachmentObjectUrlSource[]): Promise<Record<string, string>> {
    const generation = ++this.generation;
    const created = new Map<string, string>();
    const failed = new Set<string>();

    await Promise.all(
      sources.map(async ({ id }) => {
        try {
          const response = await this.fetchAttachment(
            `/api/notes/attachments/${encodeURIComponent(id)}`,
          );
          if (!response.ok) {
            failed.add(id);
            return;
          }
          const objectUrl = this.createObjectUrl(await response.blob());
          created.set(id, objectUrl);
        } catch {
          failed.add(id);
          // A missing attachment should not strand the rest of the editor.
          // The card stays visible with its non-image fallback and can retry
          // when the note is loaded again.
        }
      }),
    );

    if (generation !== this.generation) {
      for (const url of created.values()) this.revokeObjectUrl(url);
      return {};
    }

    for (const url of this.active.values()) this.revokeObjectUrl(url);
    this.active = created;
    this.failed = failed;
    return Object.fromEntries(created);
  }

  clear(): void {
    this.generation++;
    for (const url of this.active.values()) this.revokeObjectUrl(url);
    this.active.clear();
    this.failed.clear();
  }
}
