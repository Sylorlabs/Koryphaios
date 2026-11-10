---
name: video-production
description: Plan and produce video around story, shot design, timing, motion, audio, captions, encoding, platform, and review evidence. Use when the request specifically requires video production, motion video, edit this video, programmatic video.
---

# Video Production

## Responsibility and delivery contract

Own the finished video's story, shot design, edit, motion, voice/music/SFX mix, captions, encodes, and video quality review. The broader skill is `human-experience`; no child skill is bundled. Treat a separate audio production or accessibility audit as an adjacent responsibility only when requested.

Before editing, inspect the actual sources and delivery specification. Record the audience and outcome; platform, aspect ratio, duration, frame rate, timebase, and safe text area; ordered narrative beats, shot grammar, pacing, visual continuity, and motion language; voice/music/SFX, caption language and format, brand rules, and media rights. Identify ownership, consequential assumptions, decision order, and unresolved conflicts. If the task requires a structured report, create it before rendering and revise it with evidence from the final files.

## Edit and render

1. Make a shot and cue map with each source in/out, output time, speed, cut endpoints, transitions, voice, captions, and sync marks. Recalculate cue times after trims, speed changes, and overlaps. Normalize timestamps and deliberately convert frame rates. Check that moving shots retain motion and that the intended first and last frames survive each cut.
2. For multiple cameras, reconcile color primaries, transfer, matrix, range, and frame cadence before concatenation. Color metadata alone cannot convert pixels. Preserve visual continuity; use motion to explain priority or change instead of filling gaps with presets.
3. Correct transcript text against the audio. Time captions to speech and reading duration; check contrast, occlusion, safe placement, and bottom margin. Preserve visual slates and audio transients at the same output time. If text rendering is unavailable, composite transparent caption graphics at their cue times. Supply a separate timed subtitle track when required.
4. Render each requested delivery version from the intended edit and mix. A different aspect ratio or frame rate may require another composition or render, rather than a container remux. Keep speech intelligible, avoid clipping, and use media with appropriate rights.

For practical source inspection, timestamp mapping, filter graphs, color conversion, audio sync, and caption delivery, read [timeline and media procedures](references/timeline-and-media.md).

## Verify and report

Inspect the **encoded** video and audio streams for duration, dimensions, frame rate, channel layout, codecs, and subtitles. Measure integrated loudness and true peak against each delivery target. Decode and review frame cadence, color scopes and levels, cut boundaries, opening, seek points, captions, cue alignment, and ending on every version. Watch the full render and listen to representative playback when possible; project previews and metadata alone cannot prove pacing, sync, legibility, or audio balance.

Keep an artifact receipt for every delivery version: source and generated media identifiers/hashes, rights or permission boundary, project/renderer and FFmpeg versions, effective settings or command, output path and SHA-256, and the measured probe/loudness results tied to that exact file. A project file, preview, successful encoder exit, or copied measurement from another version is not final-file evidence. If the renderer, decoder, required media, or playback review is unavailable, record the precise blocker and leave the affected check unavailable; do not fill the gap with a still frame, transcript, metadata inference, or text-only claim.

When failure and recovery are in scope, export a genuine decodable version with the specified defect, measure its failure, rebuild a corrected version from source material, and verify the recovered export independently. Report measured results, actual visual or listening review, and any unavailable human review separately. Never claim an inspection that was not performed.

For commands, acceptance records, failed export evidence, and recovery checks, read [export verification procedures](references/export-verification.md). Consult [the maintained source map](references/sources.md) for version sensitive claims and conflicts.
