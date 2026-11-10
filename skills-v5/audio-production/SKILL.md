---
name: audio-production
description: Record, edit, clean up, mix, and deliver speech, music, podcasts, and sound design with explicit loudness, format, and listening checks. Use when audio production, recording cleanup, or mixing is requested; speech recognition, synthesis model behavior, and diarization belong to speech-audio-ai.
---

# Audio Production

## Responsibility

Preserve intelligibility, intent, and natural dynamics while meeting the actual delivery specification. Establish listening context, source quality, edit intent, sample rate/bit depth, channels, codec, loudness, and true peak requirements. Do not turn one platform's target or one example mix chain into a universal rule.

## Hierarchy and routing

- Broader skills: human-experience.
- No narrower bundled child is declared.

Inherit shared human-experience principles. This child owns audio decisions and evidence; video timing/editing or accessibility system design remains with the relevant specialist. Skill guidance does not expand permission to alter source assets.

## Professional practice

Preserve original stems and work reversibly. Choose edits, gain correction, noise treatment, equalization, dynamics, automation, and spatial balance from the audible problem. Loudness is not peak amplitude; a low noise floor is not useful if consonants, transients, or natural pauses are damaged. Avoid blanket heavy compression, aggressive denoising, and audible gain pumping.

Keep speech/music priorities clear without removing the intended musical impact. Compare processed and reference material at matched listening levels. Check edits, fades, silence, phase/mono compatibility, and passages prone to artifacts rather than judging a single loud section or playback system.

## Working sequence

1. Inspect the stems and agree the delivery contract, including program duration, channel layout, integrated loudness target and tolerance, true peak ceiling, and codec. Distinguish source PCM bit depth from compressed delivery format. Resolve missing targets rather than assume a podcast or broadcast default.
2. Preserve timing and original media. Balance unequal speakers with clip gain or automation before asking compression to control peaks. Correct edit clicks and plosives locally; retain breaths, consonants, and deliberate pauses.
3. Reduce noise conservatively against a level matched bypass. Back off when consonants turn metallic or tails vanish. For narration over music, establish the bed level and phrase automation first, then tune any sidechain attack, hold, and release so short gaps do not trigger audible surges.
4. Render from the intended mix with explicit output rate, channels, and codec. Leave enough peak margin for the selected encoder and verify by decoding the delivered encode. If loudness and peak requirements conflict, revisit gain/dynamics or clarify the brief rather than silently trade one limit for another.
5. Recheck the entire encoded program, its quiet and loud passages, opening/ending, mono fold-down, and requested playback contexts. When failure/recovery evidence is requested, retain a separately named playable defective version, demonstrate its actual defect, and independently verify the corrected encode.

Read [the production and encoded-file QC workflow](references/production-workflow.md) for practical diagnosis, normalization pitfalls, and inspection commands. Apply only the processing justified by the source and brief.

## Completion evidence

Measure the final encoded file against its specified integrated loudness and true peak limits; a DAW meter or sample peak is not equivalent evidence. Tie measurements, codec/sample rate/duration/metadata checks, and listening observations to the same delivered artifact. Listen on representative headphones/speakers, at different levels, and in mono as relevant. Record timestamps for clipping, masking, metallic speech, or pumping. Explicitly distinguish actual listening, objective measurements, synthetic fixtures, and unavailable checks: meters alone cannot prove intelligibility or listening quality.

Maintain an artifact receipt for the delivered encode: source/stem identifiers and hashes, rights or permission boundary, processing/render tool and version, effective settings or command, output path and SHA256, codec/sample rate/channels/duration, and the loudness and true peak result of the encoded file. Keep source preservation and measurements of the final file tied to the same delivery version. If encoding, decoding, required stems, or a requested listening context is unavailable, report the exact blocker and leave that check unavailable; never substitute a DAW preview, meter screenshot, waveform, synthetic fixture, or written listening description for the missing media or listening evidence.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
