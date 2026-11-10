# Audio-production evaluation contract

The task JSON files define two authored scenarios, each with six falsifiable checks and deterministic/blind-semantic scorer weights of 0.75/0.25. `routing.jsonl` contains 16 authored held-out cases: five positive, five negative, three ambiguous, and three adversarial. Their presence is a contract, not evidence that routing, paired execution, or blind review has passed.

## Current executable media contract

The registered implementation is `backend/src/kory/skill-eval-audio-production-runtime.ts`; its isolated regression checks are in `backend/src/kory/__tests__/skill-eval-audio-production-runtime.test.ts`. These paths identify existing repository infrastructure, not package-contained media or a requirement for the portable skill's production workflow.

| Scenario ID                               | Generated source media                                                         | Encoded delivery requirement                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `audio-production-full-task-1-individual` | Two unequal-level synthesized speech stems with added noise, 48 kHz/24-bit PCM | 18-second stereo AAC at 48 kHz, -16 LUFS integrated with runtime tolerance ±2 LU, true peak ≤ -1 dBTP |
| `audio-production-full-task-2-individual` | Synthesized narration plus a two-tone music proxy, 48 kHz/24-bit PCM           | 30-second stereo AAC at 48 kHz, -16 LUFS integrated with runtime tolerance ±2 LU, true peak ≤ -1 dBTP |

The runtime checks duration within 0.15 seconds of its contract. These numbers are fixture acceptance limits, not universal delivery recommendations; the ±2 LU runtime tolerance is not permission to ignore a stricter real-world brief. On a materialized run, inspect `evidence/contract.json`, `evidence/source-sha256.json`, and the fixture README before processing. Preserve their original contents and source stems.

The runtime requires independently decodable `.kory-eval/final.m4a`, `.kory-eval/negative.m4a`, and `.kory-eval/recovered.m4a`, plus task-specific `.kory-eval/result.json` and `.kory-eval/verification.json` reports. Positive/recovered media must meet the encoded format, complete-program loudness, true peak, source-preservation and mono/small-speaker proxy checks. The interview checks whether both source speech envelopes survive; the narration task checks source-envelope retention and music reduction/recovery. The negative must be playable in the required format and fail a substantive signal check, not merely have a broken container. A recovered file needs its own post-encode inspection.

## Coverage and honesty boundaries

- `environment.kind="synthetic"` describes generated test content. The runtime renders actual media bytes and measures decoded AAC; this is stronger than supplied meter numbers, but it is not a human interview or a dense commercial music mix.
- The scenario descriptions ask for HVAC/plosive/consonant-artifact handling, phrase-aware ducking, and representative listening. The current materializer does not supply all of those conditions: it adds generated noise rather than a measured HVAC recording, does not verify an exact 9 dB speaker gap or supply the promised consonant timestamp set, and does not supply an existing faulty sidechain/limiter project or a separate phrase/silence timing map. Inspect actual sources and label these fixture-fidelity gaps instead of inventing observations.
- Source-envelope correlation can detect missing or unrelated speech; it cannot establish word intelligibility, absence of metallic consonants, or natural dynamics. The current music proxy checks relative bed energy, not the smoothness of every gain transition or preservation of musical impact.
- Mono and band-limited RMS checks are automated compatibility proxies. They cannot establish actual headphone/small-speaker playback, absence of pumping, or subjective quality. The reports' `subjectiveListening` status must remain `unverified` unless independent human playback actually occurred; a `human-reviewed` string alone is not a listening receipt.
- A deterministic scorer pass therefore does not by itself satisfy every qualitative assertion in the task JSON. Keep those assertions, explicitly separate the measured technical result from unresolved listening/source-representativeness checks, and require appropriate independent evidence before claiming a complete task result or qualification.
- Readiness requires FFmpeg/ffprobe with the relevant filters/encoders and an available host speech generator (`say` or `espeak-ng`). A skipped media regression due to missing tools is unavailable evidence, not a passing render. No external provider/model call or qualification campaign is needed for the isolated regression test.

Changes to the runtime's coverage or scorer behavior belong to its owner. This package records those limitations without manufacturing listening evidence or changing the shared qualification state.
