# Source map

Separate signal processing mechanics from the listener's goal and the destination's delivery contract. Neither an API specification nor a successful export establishes subjective audio quality.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader human-experience.
- Routing: five positive, five negatives from near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Web Audio API**: https://www.w3.org/TR/webaudio-1.1/
  - Scope: Web Audio API 1.1, W3C Working Draft of 22 September 2026; dated revision https://www.w3.org/TR/2026/WD-webaudio-1.1-20260922/.
  - Use: browser audio graph, timing, channel, and rendering semantics only when Web Audio is the actual runtime; not a general mastering standard.
  - Verified: 2026-10-17; refresh after 180 days. This is a working draft, not a final Recommendation or proof of browser implementation support.
- **FFmpeg documentation**: https://ffmpeg.org/documentation.html
  - Scope: nightly documentation index inspected 2026-10-17; the site states that it follows the newest revision, not a pinned installed release.
  - Use: Video/audio codecs, containers, filter graphs, timing, and media processing reference.
  - Verified: 2026-10-17; refresh after 90 days. Record the installed version and consult its local help before relying on newer options.
- **FFmpeg Filters Documentation: loudnorm**: https://ffmpeg.org/ffmpeg-filters.html#loudnorm
  - Scope: nightly filter documentation inspected 2026-10-17, section `loudnorm`.
  - Use: measured integrated loudness, loudness range, true peak, single/double pass, measured-value inputs, linear-to-dynamic fallback, dual mono, and output sample rate implications.
  - Verified: 2026-10-17; refresh after 90 days.
- **FFmpeg Filters Documentation: ebur128**: https://ffmpeg.org/ffmpeg-filters.html#ebur128-1
  - Scope: nightly filter documentation inspected 2026-10-17, section `ebur128`.
  - Use: complete-program integrated loudness scanning; `peak=true` explicitly enables oversampled true peak and requires libswresample. Default peak mode is `none`; a target on the meter visualization is not normalization.
  - Verified: 2026-10-17; refresh after 90 days.
- **ffprobe documentation**: https://ffmpeg.org/ffprobe.html
  - Scope: nightly command documentation inspected 2026-10-17.
  - Use: stream/container inspection, audio stream selection, JSON output, codec/rate/channel/duration and tags. Missing optional fields may be inapplicable; metadata alone is not full decoding or listening evidence.
  - Verified: 2026-10-17; refresh after 90 days.

## Applied source decisions, 2026-10-17

- Added [a practical production and QC workflow](production-workflow.md) while retaining the encoded-artifact provenance protocol below. Processing suggestions are diagnostic starting points, not a prescribed mix chain.
- Adopted the documented `loudnorm` measured-input conditions and dynamic fallback; two passes do not guarantee linear normalization. Keep analysis/render inputs identical and choose an explicit output rate after internal upsampling.
- Local mechanics check: FFmpeg 9.0.2 used linear mode for a measured varying-level test signal and dynamic mode for a peak-conflicting target; a constant tone with measured LRA 0 also remained dynamic. These synthetic checks establish tool behavior only, not mix quality or listening evidence.
- Added direct `ffprobe` and `ebur128` references for metadata and post-encode measurements. Do not use normalization output statistics in place of independently scanning the delivered encode.
- Refreshed only the linked official documentation listed above. Source inspection is not empirical qualification or proof that a human heard a rendered file. The [evaluation contract notes](../evals/README.md) record the current synthetic-media and listening-coverage limits.

## Interpretation rules

- Adopted: distinguish loudness and peak measurements, and recheck the rendered file rather than infer its properties from the processing settings.
- Adapted: normalization mode, target values, and output format follow the destination and listening brief; audition remains a separate check.
- Rejected: imposing one LUFS target on every medium, assuming filter defaults are delivery requirements, or claiming that numerical compliance proves intelligibility or creative quality.

## Evidence and provenance protocol

- The evidence unit is the actual final encoded file. Tie its path and SHA256 to the source/stem manifest, processing tool/version, effective settings, codec/sample rate/channels/duration, and loudness and true peak measurements after encoding.
- Preserve original stems and record their hashes before processing. For supplied or generated media, record the rights/permission boundary and distinguish evaluator generated or synthetic material from human recordings.
- Keep objective encoded file checks, automated mono and small speaker proxies, and actual listening observations as separate evidence classes. A proxy can expose a compatibility risk but cannot certify a listener experience.
- Missing encoder/decoder, source media, or listening device/context is a blocked or unavailable check. Do not turn a successful command, meter, waveform, or prose assertion into a claim that the file was heard or that speech remained intelligible.
