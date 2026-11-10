---
name: speech-audio-ai
description: Engineer speech recognition, synthesis, diarization, and conversational audio with explicit timing and consent. Use when speech model behavior, streaming transcription, or endpointing changes; use audio-production for mixing and editing and fine-tuning-training for weight updates.
---

# Speech and Audio AI

Treat the acoustic signal, transport, model configuration, timing semantics and downstream language task as one contract. A transcript can look plausible while being unusable because channels were swapped, interim text was mistaken for final text, named entities were corrupted, silence hallucinated speech or latency exceeded the interaction budget.

## Workflow

1. **Define the speech task and unit.** Distinguish batch transcription, streaming ASR, translation, diarization, keyword/entity capture, voice activity/endpointing, TTS, speech-to-speech or another audio-model task. State whether correctness is word-, entity-, speaker-, turn-, utterance- or conversation-level.
2. **Pin signal and transport identity.** Record codec/container, sample rate, bit depth when relevant, channel layout, microphone/device class, resampling/downmix policy and streaming framing/chunk size. Never infer channel/sample-rate behavior from a filename extension alone.
3. **Preserve time semantics.** For streaming, distinguish interim from final hypotheses, committed turns, result end offsets, endpoint/VAD decisions and reconnect/resume behavior. Do not append mutable interim text as if it were final or lose words at chunk/session boundaries.
4. **Define language and speaker behavior.** Pin language hints/detection policy, multilingual/code-switch handling, punctuation/casing normalization, diarization/speaker-label semantics and whether speaker identity is stable or only locally numbered. Evaluate accents/languages and overlapping speakers that match deployment.
5. **Normalize references deliberately.** For ASR scoring, define casing, punctuation, numerals, abbreviations, fillers and tokenizer/word-segmentation rules before computing WER/CER or semantic metrics. Keep raw model output for audit; do not normalize away product-critical errors such as names, amounts or codes.
6. **Evaluate more than aggregate WER.** Measure WER/CER when appropriate, but also critical entity accuracy, hallucinated speech on silence/noise, deletion/substitution patterns, diarization/turn accuracy and downstream task success. Slice by noise/SNR, device/channel, accent/language, overlap, utterance length, silence and streaming boundary conditions.
7. **Calibrate confidence and fallback.** If the provider exposes confidence/stability or alternatives, validate how they correlate with actual errors before using them. Define abstain/retry/human-review or confirmation behavior for low-confidence or critical fields rather than silently guessing.
8. **Measure interaction latency.** For live speech, measure capture-to-first-partial, capture-to-final/commit and end-of-turn response latency, not just offline real time factor. Include network, buffering, resampling and endpointing delays.
9. **Treat TTS text normalization as product logic.** Specify how numbers, dates, currency, acronyms, URLs, names and punctuation become spoken text. Verify pronunciations, pauses/prosody, truncation, clipping, encoding/sample-rate output and target playback profile on representative prompts.
10. **Require voice authority and provenance.** Use only voices and source recordings the user is authorized to use. Record provider/voice/model/version, custom-voice consent or license evidence when applicable and any disclosure requirements. Do not infer permission to clone or imitate a real person's voice.
11. **Verify synthesis quality on the target channel.** Test intelligibility, pronunciation, naturalness/task suitability, loudness/clipping and latency after the actual telephony/mobile/browser/device encoding path. A studio WAV alone is not deployment evidence.
12. **Version migrations and regressions.** Pin model aliases/snapshots when available, dual-run provider/model changes on the same held out audio, persist transcripts/audio/timestamps/configuration and keep failures as regressions. Roll back when critical entity, language, hallucination or latency gates fail.

## Boundaries

- `ml-evaluation` owns generic statistical evaluation design. This skill owns speech/audio-specific references, WER/CER normalization, timing, speaker/language slices, silence hallucination and acoustic failure semantics.
- `fine-tuning-training` owns model/adapter weight changes. This skill defines the signal, transcript/synthesis and deployment evidence that training must improve.
- `audio-production` owns recording cleanup, mixing, mastering, podcast/music editing and sound design when no speech-model behavior is changing.
- `agentic-systems` or LLM application skills own conversational policy/tool orchestration. This skill owns ASR/TTS/endpointing and audio-turn quality at the speech interface boundary.
- `embedding-systems` owns audio/vector representation semantics when audio is embedded for similarity/search; this skill owns speech recognition/synthesis and acoustic behavior.
- File-format conversion alone, transcript copyediting alone or a quoted historical speech request does not activate this skill unless the current task changes or evaluates speech/audio AI behavior.

Use [the maintained source map](references/sources.md) before encoding model, streaming, format, voice or limit behavior specific to the provider.
