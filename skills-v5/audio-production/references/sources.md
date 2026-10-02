# Source map

Separate signal-processing mechanics from the listener's goal and the destination's delivery contract. Neither an API specification nor a successful export establishes subjective audio quality.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader human-experience.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Web Audio API**: https://www.w3.org/TR/webaudio-1.1/
  - Scope: W3C Web Audio API 1.1
  - Use: browser audio graph, timing, channel, and rendering semantics only when Web Audio is the actual runtime; not a general mastering standard.
  - Verified: 2026-09-04; refresh after 180 days.
- **FFmpeg documentation**: https://ffmpeg.org/documentation.html
  - Scope: FFmpeg documentation as available 2026-09-04
  - Use: Video/audio codecs, containers, filter graphs, timing, and media-processing reference.
  - Verified: 2026-09-04; refresh after 90 days.
- **FFmpeg Filters Documentation: loudnorm**: https://ffmpeg.org/ffmpeg-filters.html#loudnorm
  - Use: measured integrated loudness, loudness range, true peak, single/double pass, and output sample-rate implications.
  - Verified: 2026-09-06; refresh after 90 days.

## Interpretation rules

- Adopted: distinguish loudness and peak measurements, and recheck the rendered file rather than infer its properties from the processing settings.
- Adapted: normalization mode, target values, and output format follow the destination and listening brief; audition remains a separate check.
- Rejected: imposing one LUFS target on every medium, assuming filter defaults are delivery requirements, or claiming that numerical compliance proves intelligibility or creative quality.
