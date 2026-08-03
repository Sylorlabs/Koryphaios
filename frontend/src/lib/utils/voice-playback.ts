import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { chunkSpeech, markdownToSpeech } from './speech-text';

let activeAudio: HTMLAudioElement | null = null;
let activeToken = 0;

export function stopVoicePlayback() {
  activeToken++;
  speechSynthesis?.cancel();
  activeAudio?.pause();
  activeAudio = null;
  window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: null }));
}

export async function playVoiceResponse(id: string, markdown: string): Promise<void> {
  stopVoicePlayback();
  const token = ++activeToken;
  window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: id }));
  const settingsResponse = await apiFetch(apiUrl('/api/voice/settings'));
  const settings = (await settingsResponse.json()).data;
  const chunks = chunkSpeech(markdownToSpeech(markdown));
  try {
    if (settings.output.provider === 'system') {
      for (const text of chunks) {
        if (token !== activeToken) return;
        await new Promise<void>((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = settings.input.language || 'en'; utterance.rate = settings.output.speed;
          const selected = speechSynthesis.getVoices().find(v => v.voiceURI === settings.output.voiceId || v.name === settings.output.voiceId);
          if (selected) utterance.voice = selected;
          utterance.onend = () => resolve(); utterance.onerror = event => reject(new Error(event.error || 'Speech playback failed'));
          speechSynthesis.speak(utterance);
        });
      }
    } else {
      for (const text of chunks) {
        if (token !== activeToken) return;
        const response = await apiFetch(apiUrl('/api/voice/synthesize'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings.output, text }) });
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        const audio = new Audio(`data:${result.data.mimeType};base64,${result.data.audioBase64}`); activeAudio = audio;
        await audio.play(); await new Promise<void>((resolve, reject) => { audio.onended = () => resolve(); audio.onerror = () => reject(new Error('Audio playback failed')); });
      }
    }
  } finally { if (token === activeToken) { window.dispatchEvent(new CustomEvent('kory:voice-playback', { detail: null })); activeAudio = null; } }
}
