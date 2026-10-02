# Source map

`speech-audio-ai` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Speech provider model catalogs, streaming transports, limits and voice offerings change quickly; refresh provider documentation before encoding exact model IDs, limits or voice behavior and preserve the tested model/configuration identity in artifacts.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI GPT-Transcribe model**: https://developers.openai.com/api/docs/models/gpt-transcribe
  - Scope: OpenAI GPT-Transcribe documentation as available 2026-09-19.
  - Use: current transcription model surfaces, context/keyword/language hints and supported file/realtime behavior.
  - Verified: 2026-09-19; refresh after 14 days.
- **OpenAI model catalog**: https://developers.openai.com/api/docs/models
  - Scope: rolling OpenAI model catalog as available 2026-09-17.
  - Use: current realtime, transcription and speech-generation families. Recheck aliases, snapshots and deprecations before provider migration.
  - Verified: 2026-09-17; refresh after 7 days.
- **Google Cloud streaming Speech-to-Text**: https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize
  - Scope: Google Cloud Speech-to-Text streaming guide as available 2026-09-05.
  - Use: current bidirectional streaming recognition workflow and transport/streaming constraints.
  - Verified: 2026-09-05; refresh after 30 days.
- **Google Cloud `StreamingRecognitionResult`**: https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/StreamingRecognitionResult
  - Scope: Google Cloud Speech-to-Text v2 result reference as available 2026-09-05.
  - Use: interim versus final results, stability, result-end offsets, channel tags and language codes; model these explicitly in streaming assembly.
  - Verified: 2026-09-05; refresh after 30 days.
- **Google Cloud Text-to-Speech `AudioConfig`**: https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/AudioConfig
  - Scope: Google Cloud Text-to-Speech v1 audio configuration as available 2026-09-05.
  - Use: output encoding, speaking rate, pitch, gain, sample rate and device-profile configuration; verify selected provider semantics rather than assuming portability.
  - Verified: 2026-09-05; refresh after 30 days.
- **NIST AI Risk Management Framework**: https://www.nist.gov/itl/ai-risk-management-framework
  - Scope: NIST AI RMF materials as available 2026-09-05.
  - Use: representative lifecycle evaluation, transparency and governance for speech systems with material user impact.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Pin codec/container, sample rate, channel/downmix/resampling and model/language/streaming configuration. Signal-format mismatch can masquerade as model quality change.
- For streaming recognition, treat interim hypotheses as mutable and final/committed hypotheses as durable according to the selected provider's semantics. Preserve offsets and test reconnect/chunk-boundary behavior.
- Define reference-text normalization before WER/CER. Keep raw output and separately score product-critical entities so punctuation/number normalization cannot hide names, amounts, codes or other consequential errors.
- Include silence/noise hallucination, deletions, accents/languages/code-switching, device/channel, overlap, long utterances and streaming boundaries in deployment-relevant slices.
- For live systems measure latency from capture to the first partial result, from capture to the final or committed result, and at the end of the turn. Include buffering, network, and endpointing rather than measuring only offline model speed.
- TTS quality depends on text normalization, pronunciation, voice/model identity, output encoding and playback path. Evaluate critical prompts on the actual target channel and inspect clipping/truncation/chunk joins.
- Require authorization/provenance for custom or cloned voices. Do not treat technical capability as permission to imitate a real person.
- Model/provider changes are migrations: dual-run the same held-out audio/text, pin artifacts, preserve regressions and keep a tested rollback when quality, hallucination, language or latency gates fail.
