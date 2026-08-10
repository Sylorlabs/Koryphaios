import { describe, expect, it, vi } from 'vitest';
import { AttachmentObjectUrlRegistry } from './attachment-object-urls';

describe('AttachmentObjectUrlRegistry', () => {
  it('fetches attachments through a credential-free path and revokes URLs on replacement', async () => {
    const requested: string[] = [];
    const fetchAttachment = vi.fn(async (path: string) => {
      requested.push(path);
      return new Response(new Blob(['image']), { status: 200 });
    });
    const createObjectUrl = vi
      .fn<(blob: Blob) => string>()
      .mockReturnValueOnce('blob:kory/first')
      .mockReturnValueOnce('blob:kory/second');
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const registry = new AttachmentObjectUrlRegistry(
      fetchAttachment,
      createObjectUrl,
      revokeObjectUrl,
    );

    expect(await registry.replace([{ id: 'image one' }])).toEqual({
      'image one': 'blob:kory/first',
    });
    expect(requested).toEqual(['/api/notes/attachments/image%20one']);
    expect(requested[0]).not.toContain('?');
    expect(requested[0]).not.toMatch(/auth|token|bearer/i);

    expect(await registry.replace([{ id: 'image-two' }])).toEqual({
      'image-two': 'blob:kory/second',
    });
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:kory/first');

    registry.clear();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:kory/second');
  });

  it('revokes a stale in-flight URL when the note switches', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const registry = new AttachmentObjectUrlRegistry(
      () => pending,
      () => 'blob:kory/stale',
      revokeObjectUrl,
    );

    const replacement = registry.replace([{ id: 'slow' }]);
    registry.clear();
    finish(new Response(new Blob(['late']), { status: 200 }));

    expect(await replacement).toEqual({});
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:kory/stale');
  });

  it('reports individual load failures and clears them after a successful retry', async () => {
    let succeeds = false;
    const registry = new AttachmentObjectUrlRegistry(
      async () =>
        succeeds
          ? new Response(new Blob(['ok']), { status: 200 })
          : new Response('missing', { status: 404 }),
      () => 'blob:kory/recovered',
      () => undefined,
    );

    expect(await registry.replace([{ id: 'recoverable' }])).toEqual({});
    expect(registry.failedIds).toEqual(['recoverable']);
    succeeds = true;
    expect(await registry.replace([{ id: 'recoverable' }])).toEqual({
      recoverable: 'blob:kory/recovered',
    });
    expect(registry.failedIds).toEqual([]);
  });
});
