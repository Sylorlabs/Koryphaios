import { describe, expect, it } from 'vitest';
import {
  getTranscriptScrollState,
  MAX_RESUME_PAGE_SIZE,
  resumeMessageLimit,
  saveTranscriptScrollState,
} from './transcript-scroll';

describe('transcript scroll state', () => {
  it('sizes a resume read to include the anchor and everything newer', () => {
    expect(
      resumeMessageLimit({
        scrollTop: 4000,
        follow: false,
        anchorId: 'row-80',
        anchorOffset: 12,
        rowsAfterAnchor: 180,
      }),
    ).toBe(231);
  });

  it('keeps the default newest page when the position has no anchor', () => {
    expect(resumeMessageLimit({ scrollTop: 100, follow: false })).toBeUndefined();
    expect(resumeMessageLimit(undefined)).toBeUndefined();
  });

  it('never resizes the page for a following reader', () => {
    expect(
      resumeMessageLimit({
        scrollTop: 0,
        follow: true,
        anchorId: 'row-1',
        rowsAfterAnchor: 400,
      }),
    ).toBeUndefined();
  });

  it('caps an extreme resume read instead of fetching the whole chat', () => {
    expect(
      resumeMessageLimit({
        scrollTop: 9999,
        follow: false,
        anchorId: 'row-1',
        rowsAfterAnchor: 50_000,
      }),
    ).toBe(MAX_RESUME_PAGE_SIZE);
  });

  it('round-trips the row anchor through the saved state', () => {
    const id = 'transcript-scroll-test-round-trip';
    saveTranscriptScrollState(id, {
      scrollTop: 1234,
      follow: false,
      anchorId: 'hist-message-12',
      anchorOffset: 7,
      rowsAfterAnchor: 42,
    });

    expect(getTranscriptScrollState(id)).toEqual({
      scrollTop: 1234,
      follow: false,
      anchorId: 'hist-message-12',
      anchorOffset: 7,
      rowsAfterAnchor: 42,
    });
  });

  it('drops invalid anchors rather than restoring against a corrupt row', () => {
    const id = 'transcript-scroll-test-invalid';
    saveTranscriptScrollState(id, {
      scrollTop: 10,
      follow: false,
      anchorId: '',
      anchorOffset: Number.NaN,
      rowsAfterAnchor: -1,
    });

    expect(getTranscriptScrollState(id)).toEqual({ scrollTop: 10, follow: false });
  });
});
