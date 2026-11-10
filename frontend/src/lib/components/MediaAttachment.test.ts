// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaAttachment from './MediaAttachment.svelte';
import GeneratedVideo from './GeneratedVideo.svelte';

vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
import { apiFetch } from '$lib/api.svelte';

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
beforeEach(() => {
  createObjectURL.mockReset().mockReturnValue('blob:media-fixture');
  revokeObjectURL.mockReset();
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
});
afterEach(() => vi.unstubAllGlobals());

describe('chat media playback', () => {
  it.each([
    ['clip.mp4', 'video'],
    ['speech.mp3', 'audio'],
  ])('plays %s and releases its blob URL', async (name, tag) => {
    const view = render(MediaAttachment, { data: 'Y2xpcA==', name });
    await waitFor(() =>
      expect(view.container.querySelector(tag)).toHaveAttribute('src', 'blob:media-fixture'),
    );
    expect(view.container.querySelector(tag)).toHaveAttribute('controls');
    expect(view.container.querySelector(tag)).not.toHaveAttribute('autoplay');
    expect(screen.getByRole('link')).toHaveAttribute('download', name);
    await fireEvent.error(view.container.querySelector(tag)!);
    expect(screen.getByText(/could not play the media format/)).toBeTruthy();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:media-fixture');
  });

  it('loads generated video through the authenticated history API for inline playback', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      Response.json({
        ok: true,
        data: { videoBase64: 'Y2xpcA==', mimeType: 'video/mp4', prompt: 'A cat surfing' },
      }),
    );
    const view = render(GeneratedVideo, { historyId: 'clip/id' });
    await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/video/history/clip%2Fid',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText('A cat surfing')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('base64');
  });

  it('shows an actionable result when the generated clip has expired', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      Response.json({ ok: false, error: 'Video not found in history.' }, { status: 400 }),
    );
    render(GeneratedVideo, { historyId: 'expired' });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Video not found in history.'),
    );
  });
});
