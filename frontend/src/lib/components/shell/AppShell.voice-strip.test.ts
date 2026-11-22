// @vitest-environment jsdom
import { render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';

import AppShell from './AppShell.svelte';
import { voiceRecorder } from '$lib/stores/voice-recorder.svelte';

function fakeAnalyser() {
  return { fftSize: 1024 } as unknown as AnalyserNode;
}

function shell() {
  return render(AppShell, {
    feed: undefined,
    contextBar: undefined,
    backgroundShells: undefined,
  });
}

function strip() {
  return screen.getByTestId('voice-waveform-strip');
}

describe('the voice waveform strip sits above the context bar in flow', () => {
  beforeEach(() => {
    voiceRecorder.end();
  });

  it('collapses to no space while idle so the composer does not move', () => {
    const { unmount } = shell();
    const el = strip();
    expect(el.getAttribute('data-state')).toBe('idle');
    expect(el.textContent?.trim()).toBe('');
    expect(el.getAttribute('style')).toContain('padding-top: 0');
    // aria-hidden while idle: it is not a live region when nothing is recorded.
    expect(el.getAttribute('aria-hidden')).toBe('true');
    unmount();
  });

  it('shows the live capture when a recording is published', () => {
    const { unmount } = shell();
    voiceRecorder.begin('recording', fakeAnalyser(), 65_000);
    // Runes flush on a microtask, so the assertion must see the settled DOM.
    flushSync();
    const el = strip();
    expect(el.getAttribute('data-state')).toBe('recording');
    expect(el.getAttribute('aria-hidden')).toBe('false');
    expect(el).toHaveTextContent('1:05');
    expect(el).toHaveTextContent('Recording');
    expect(el.querySelector('canvas')).toBeTruthy();
    // In flow, never an overlay over the chat or the Context row.
    expect(el.className).toContain('shrink-0');
    expect(el.className).not.toContain('absolute');
    expect(el.getAttribute('style')).toContain('padding-top:');
    unmount();
  });

  it('keeps the strip up through transcription, then clears it', () => {
    const { unmount } = shell();
    voiceRecorder.begin('transcribing', null, 12_000);
    flushSync();
    const el = strip();
    expect(el.getAttribute('data-state')).toBe('transcribing');
    expect(el).toHaveTextContent('Transcribing');
    expect(el).toHaveTextContent('0:12');

    voiceRecorder.end();
    flushSync();
    expect(strip().getAttribute('data-state')).toBe('idle');
    expect(strip().textContent?.trim()).toBe('');
    unmount();
  });

  it('keeps the same waveform canvas when recording changes to transcription', () => {
    const { unmount } = shell();
    const analyser = fakeAnalyser();
    voiceRecorder.begin('recording', analyser, 12_000);
    flushSync();
    const canvas = strip().querySelector('canvas');
    expect(canvas).toBeTruthy();

    voiceRecorder.begin('transcribing', analyser, 12_000);
    flushSync();
    expect(strip().getAttribute('data-state')).toBe('transcribing');
    expect(strip().querySelector('canvas')).toBe(canvas);
    expect(strip()).toHaveTextContent('Transcribing');

    voiceRecorder.end();
    flushSync();
    expect(strip().getAttribute('data-state')).toBe('idle');
    unmount();
  });

  it('shows the live transcript as the speech is transcribed', () => {
    const { unmount } = shell();
    voiceRecorder.begin('recording', fakeAnalyser(), 4_000);
    voiceRecorder.setPartialText('the quick brown fox');
    flushSync();
    expect(screen.getByTestId('voice-live-transcript')).toHaveTextContent('the quick brown fox');
    // The screen reader hears the live words, not just the recording state.
    expect(strip()).toHaveTextContent('the quick brown fox');

    voiceRecorder.end();
    flushSync();
    expect(strip().textContent?.trim()).toBe('');
    unmount();
  });

  it('ignores an elapsed tick that arrives after the capture ended', () => {
    voiceRecorder.begin('recording', fakeAnalyser(), 0);
    voiceRecorder.end();
    // A timer that was not yet cleared must not resurrect the strip.
    voiceRecorder.setElapsed(9_000);
    expect(voiceRecorder.active).toBe(false);
    expect(voiceRecorder.state.elapsedMs).toBe(0);
  });
});
