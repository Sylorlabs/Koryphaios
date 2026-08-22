import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { chunkSpeech, markdownToSpeech } from './speech-text';

let activeAudio: HTMLAudioElement | null = null;
let activeToken = 0;
let cancelSystemUtterance: (() => void) | null = null;

export function stopVoicePlayback() {
  activeToken++;
  cancelSystemUtterance?.();
  cancelSystemUtterance = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  activeAudio?.pause();
  activeAudio = null;
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: null }));
}

export async function playVoiceResponse(id: string, markdown: string): Promise<void> {
  stopVoicePlayback();
  const token = ++activeToken;
  window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: id }));
  const settingsResponse = await apiFetch(apiUrl('/api/voice/settings'));
  const settingsResult = await settingsResponse.json();
  if (!settingsResponse.ok || !settingsResult.data)
    throw new Error(settingsResult.error || 'Voice settings are unavailable');
  const settings = settingsResult.data;
  const chunks = chunkSpeech(markdownToSpeech(markdown));
  try {
    if (settings.output.provider === 'system') {
      if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined')
        throw new Error('Operating system speech synthesis is unavailable in this runtime');
      for (const text of chunks) {
        if (token !== activeToken) return;
        await new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = settings.input.language || 'en';
          utterance.rate = settings.output.speed;
          const selected = speechSynthesis
            .getVoices()
            .find(
              (v) => v.voiceURI === settings.output.voiceId || v.name === settings.output.voiceId,
            );
          if (selected) utterance.voice = selected;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            cancelSystemUtterance = null;
            resolve();
          };
          cancelSystemUtterance = finish;
          utterance.onend = finish;
          utterance.onerror = (event) => {
            if (
              token !== activeToken ||
              event.error === 'canceled' ||
              event.error === 'interrupted'
            ) {
              finish();
              return;
            }
            if (settled) return;
            settled = true;
            cancelSystemUtterance = null;
            reject(new Error(event.error || 'Speech playback failed'));
          };
          speechSynthesis.speak(utterance);
        });
      }
    } else {
      for (const text of chunks) {
        if (token !== activeToken) return;
        const response = await apiFetch(apiUrl('/api/voice/synthesize'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            provider: settings.output.provider,
            modelId: settings.output.modelId,
            voiceId: settings.output.voiceId,
            speed: settings.output.speed,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.data?.audioBase64)
          throw new Error(result.error || 'Speech synthesis failed');
        const audio = new Audio(`data:${result.data.mimeType};base64,${result.data.audioBase64}`);
        activeAudio = audio;
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('Generated speech could not be played'));
          void audio.play().catch(reject);
        });
      }
    }
  } finally {
    if (token === activeToken) {
      window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: null }));
      activeAudio = null;
    }
  }
}
