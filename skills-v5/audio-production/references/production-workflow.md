# Production and QC workflow for encoded files

Use this sequence to diagnose and deliver audio, not as a mandatory plugin chain. A speech repair, a guitar/vocal mix, and a designed effect may need different treatment. The destination's written brief owns numerical targets; the [source map](sources.md) bounds claims about specific tools.

## 1. Inspect and establish the contract

- Inventory source paths, hashes, permissions, duration, start offsets, sample rate, PCM bit depth, channels/layout, and any clipped or missing material. Listen to the raw sources when playback is available. A waveform alone cannot identify intelligibility or tone problems.
- Record audience, intended listening level/context, edit intent, required sync/duration, speech/music priorities, integrated loudness target and tolerance, true peak ceiling, delivery codec/container/bitrate, sample rate, channel layout, and required metadata. Do not manufacture a target if the destination has not supplied one.
- If recording is in scope, make a test of the loudest expected passage, check mic placement, room noise, and interface gain, and leave capture headroom. Improve the capture before depending on restoration. Keep room tone for edits. Source clipping cannot reliably be undone by turning the file down afterward.
- Work on copies or a reversible session, retain a lossless working mix, and keep any required video or cue alignment intact. Do not repeatedly transcode a lossy delivery to revise the mix.

## 2. Edit, balance, and reduce defects

| Observed problem                         | Action and acceptance check                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One speaker is quieter                   | Compare active speech, not averages over whole stems dominated by silence. Use clip gain/automation to balance phrases before compression; raising the quiet stem also raises its noise and bleed. Check overlap and quieter word endings.                                                                    |
| HVAC/rumble in pauses                    | Identify steady noise separately from voice. Try conservative filtering or denoising on a duplicate, compare at matched speech level, and audition consonants and room tone transitions. Reduce treatment if speech becomes metallic. A hard gate that removes breaths or opens audibly is not a repair.      |
| Clicks, plosives, or abrupt room changes | Repair locally, use short fades/crossfades appropriate to the material, and preserve natural pauses with compatible room tone. Check that fades do not soften the first consonant or trim a final word/reverb tail.                                                                                           |
| Large peaks or uneven phrases            | Correct phrase level first, then use only the dynamics needed. Tune threshold/ratio and attack/release against gain reduction and audible transients, breaths, and noise modulation. Loudness normalization alone does not balance speakers.                                                                  |
| Narration masked by music                | Set the bed level against the voice, automate phrases with smooth ramps, and recover the bed in genuine sections without speech. If sidechaining, tune attack/hold/release to the speech rhythm; avoid fast recovery into every breath. Consider selective EQ for masking before reducing all musical impact. |
| Voice disappears or changes tone in mono | Check polarity, delay/widening effects, stereo routing, and the downmix matrix. Compare the summed signal at matched level; do not mistake normal level changes from the pan law for cancellation or fix cancellation merely by increasing gain.                                                              |

Mark timestamps for each problem and compare bypass/processed passages at matched listening levels. An attractive louder version is not automatically the better treatment. Recheck the combined mix: processing a stem in isolation can hide masking, doubled room noise, or pumping in the sum.

## 3. Normalize and encode deliberately

Measure the complete intended program after edits, routing, automation, and mix processing. Keep the measured range and channel layout identical between analysis and render. Silence, a partial selection, a changed mix, or a different downmix invalidates a prior pass. Integrated LUFS is not a peak measurement; a safe sample peak does not guarantee a safe true peak after AAC encoding.

If using FFmpeg `loudnorm` for an offline workflow with two passes:

1. Analyze the same lossless working mix that will be rendered, with the requested `I`, `TP`, and deliberately chosen `LRA`; retain `print_format=json` statistics. A loudness range setting is a processing choice, not necessarily a delivery requirement.
2. Supply analysis `input_i`, `input_lra`, `input_tp`, and `input_thresh` as `measured_I`, `measured_LRA`, `measured_TP`, and `measured_thresh`, and `target_offset` as `offset` on the render pass. Keep targets and upstream processing unchanged.
3. `linear=true` is a request, not a guarantee. All four measured values are required; if the target LRA is below the source LRA or the required gain would exceed the TP target, the filter falls back to dynamic mode. Inspect the reported normalization mode and audition dynamics rather than assume two passes preserve them. A check with a constant tone on FFmpeg 9.0.2 also stayed dynamic with measured LRA 0; retain genuine statistics rather than invent nonzero values to force a mode.
4. Dynamic mode upsamples internally to 192 kHz. Set the intended output rate explicitly with `-ar` or `aresample`, and choose the output channel layout before measuring the program. For mono intended for stereo reproduction, explicitly agree the dual mono measurement convention; do not apply compensation again to a file already rendered as two channels.
5. Encode to a new delivery path with explicit codec, rate, channels, and bitrate/quality settings. Decode and measure it. If peaks after encoding exceed the ceiling, lower the ceiling before encoding or revise dynamics, render again from the lossless mix, and repeat both loudness and peak checks. There is no fixed codec headroom that guarantees every encode.

Check the installed tool's version and filter help; the public FFmpeg site documents nightly development and may expose options absent from an older installed release. Neither a filter default nor an illustrative `-16 LUFS` target overrides the brief.

## 4. Inspect the exact delivery

These are inspection examples for an existing `delivery.m4a`, not a rendering prescription. Record the tool versions separately:

```sh
ffmpeg -version
ffprobe -version
ffprobe -v error -select_streams a -show_streams -show_format -of json "delivery.m4a"
ffmpeg -hide_banner -nostats -i "delivery.m4a" -map 0:a:0 -af ebur128=peak=true -f null -
```

Keep the complete probe output and loudness summary for the entire program. The `ebur128` command scans the decoded audio without a gain change; `peak=true` requests oversampled true peak rather than the default of no peak scan. Its true peak summary may label the numeric peak `dBFS`; preserve the raw log and identify it as the true peak result when comparing with the dBTP ceiling. Confirm that true peak is actually present. Decoder/filter failure or missing/nonfinite results are not a pass. Probe metadata cannot prove that the whole file decodes or sounds correct.

Confirm actual codec, channel layout, sample rate, duration, stream selection, and required tags. Compressed audio need not expose a meaningful PCM bit depth field; a missing `bits_per_raw_sample` in AAC is not evidence that source media with 24 bits per sample was mishandled. Measure every requested audio program/track separately rather than assume the first stream represents all deliveries.

For an ordinary L/R file with two channels only, a separately named mono review copy can expose cancellation:

```sh
ffmpeg -hide_banner -v error -n -i "delivery.m4a" -map 0:a:0 -af "pan=mono|c0=0.5*c0+0.5*c1" -c:a pcm_s24le "mono-check.wav"
```

Use the destination's defined downmix for other layouts. Listen to the actual encode on the requested headphones/speakers at representative levels, inspect quiet speech and transitions, and compare mono. A proxy that limits bandwidth to approximate a small speaker can reveal missing midrange energy but cannot establish what an actual speaker or listener experienced.

## 5. Deliver evidence and handle recovery

Tie source hashes, processing settings/version, delivery path and SHA256, format/duration, meter results for the complete file, and timestamped observations to each exact output version. Label objective measurements, actual listening context, automated proxies, synthetic media, and unavailable checks separately. Report a met technical envelope and unverified listening quality separately when playback is unavailable.

When a task calls for failure and recovery, preserve the final delivery and create a separate decodable defective artifact with a genuine signal problem, such as a level above the limit, masked speech, or stereo cancellation. Measure its failure, repair from the original working material, and independently inspect the recovered encode. A corrupt container or invented measurement is not evidence of an audio-production failure. Never introduce a defect into a user's source or only copy a passing report to a differently encoded file.
