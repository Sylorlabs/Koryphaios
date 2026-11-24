# Images, video, audio, and speech

Koryphaios can display images and play audio/video attachments in the conversation. Model understanding and media generation depend on the selected provider's actual API capabilities.

| Workflow               | Where to use it                                                                                               | Provider requirements                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Image input            | Composer paperclip → Attach image, audio, video; paste screenshots; drag files into the composer              | A chat integration and model that support image input                                                                  |
| Image output           | Settings → Images, or the image generation workflow                                                           | A connected image generation provider                                                                                  |
| Video input            | Attach a short video in the composer                                                                          | The native Gemini integration: Google, AI Studio, Vertex AI, or a Gemini-compatible custom endpoint                    |
| Video output           | Settings → Video, or ask the manager to use `generate_video`                                                  | A connected Luma, Kling AI, Prodia, or Replicate account and an appropriate model                                      |
| Audio input / analysis | Attach an audio file in the composer                                                                          | The native Gemini integration                                                                                          |
| Speech-to-text         | Press the composer microphone to start and again to stop, or choose **Use transcript** on an audio attachment | Settings → Voice selects Kory Voice, system microphone recognition, a local endpoint, or a connected transcription API |
| Text-to-speech         | **Listen** beneath an assistant reply, Voice settings' test button, or automatic reply playback               | Settings → Voice selects operating-system voices, a local endpoint, or a connected speech API                          |

## Media uploads and playback

Use the paperclip menu's **Attach image, audio, video…** action to upload actual file bytes. **Pick file…** and **Pick folder…** insert workspace references instead. Browser file drops into the composer also upload media.

Audio and video use playback controls and a download link, with no autoplay. Playback uses the runtime's codecs; if a format cannot play, download it to open in another player. Common formats include MP4/WebM video and MP3/WAV/M4A/Ogg/FLAC audio.

Inline media uploads are bounded to 15 MB. A Gemini request containing audio or video is also bounded to 15 MB across its retained conversation media; start a new chat or use smaller clips when needed. Model context limits still apply. Native input forwards the bytes and MIME type, and a provider rejection is surfaced rather than silently substituting text. Other chat integrations explicitly reject raw audio/video input.

**Use transcript** replaces the selected audio attachment with editable text in the draft. Kory Voice decodes the file locally, mixes channels to mono, and transcribes 16 kHz PCM. Local/API transcription uses the selected Voice input configuration. Operating-system speech recognition supports the microphone, so choose Kory Voice or a transcription endpoint for existing files. Transcribed text can then be sent to any chat model.

## Video settings

**Settings → Video** contains the video studio with provider, model (including custom model IDs), prompt, duration, aspect ratio, optional resolution and negative prompt, and synchronized audio. Available options depend on the upstream model; synchronized audio currently targets supported Kling models.

Duration starts at **5 seconds** and is an editable field. Enter your own positive number of seconds, including decimals; changing the provider or model preserves your value. The provider determines which durations its model accepts.

The studio plays and downloads results and provides a recent-clip gallery. Manager `generate_video` results also load the saved clip for playback in the conversation's tool result. Video generation uses the spend-cap gate and usage ledger. Completed videos are downloaded into Koryphaios storage rather than relying on expiring provider URLs; the gallery retains them for 30 days.

This studio currently generates videos from text prompts. Image-to-video and video editing require their own source-media contracts and are not exposed as studio input modes.

## Verification

Media upload, authenticated generated-video loading, player URL cleanup, transcription, provider transport, unsupported-input rejection, and security headers are covered by focused tests. Provider transport/generation tests use stubbed responses; account entitlement and real playback codecs require a live provider/runtime check.
