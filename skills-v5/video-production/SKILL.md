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

A measurement is only a measurement when the probe succeeded. A nonzero encoder or analyser exit status means the file was never inspected, so record the check as unavailable and fix the pipeline instead of reporting a number. The classic silent failure is a filter graph or stream-map expression that matches no streams: the command exits non-zero and any "measured" loudness afterwards is fiction. Name the exact stream you intend to read (`-map 0:v:0`, `-map 0:a:0`) rather than relying on implicit selection.

Prove motion, not just frame count. A render assembled from a handful of stills can carry a perfectly regular timestamps list while every frame repeats, so hash decoded frames at several cue times and compare: a duplicate-frame ratio above roughly a third means the delivery is a slide show, whatever the frame rate says. Likewise, a visual marker that only exists in the source must be visible in the decoded output at each of its cue times, before, during and after.

For loudness, normalise to the declared delivery target and verify with an EBU R128 meter on the encoded file: if the task names a target, hit it within the stated tolerance, and if it does not, use the web default of -18 LUFS integrated with a plus or minus 3 LUFS tolerance and say that you chose it. Keep true peak at or below -1 dBTP so lossy encoding cannot clip. The tolerance is the deliverable: -14 LUFS against an unstated web target reads as out of range, not as a conservative choice, so measure with `-af ebur128` after the final encode and re-normalise with `loudnorm=I=-18:TP=-1` before you call the file finished.

A delivery contract is a fixed shape, not a summary you design. When the task declares a result object with a boundary, a neighbour skill, a decision sequence, and labels for pacing, shot grammar, motion language, captions, brand constraints and ownership, fill every one of those keys at the declared path. Each entry needs enough substance to be checkable: a sentence that names the choice and why, or a list of at least two concrete items. An empty key, a renamed key, or a nested object where the contract asked for a string fails the check even when the production itself is right.

Separate what you verified from what you judged. Write the verification object with the field names `negativePath`, `recovery` and `subjectivePlayback`: the failed export you actually exercised and measured, the rebuild you actually recovered from, and one of the two literal strings `unverified` or `human-reviewed`. Each string needs real content, not a placeholder, and `human-reviewed` is only for a person who watched the file end to end on a real display. A prose summary of the same work under other keys, such as `review` or `notes`, reads as a missing verification report. Never mark subjective quality as reviewed when the only evidence is your own reading of the file. A report that claims human review it did not receive, or omits the path that failed and was then repaired, fails the same check as a missing report.

Keep an artifact receipt for every delivery version: source and generated media identifiers/hashes, rights or permission boundary, project/renderer and FFmpeg versions, effective settings or command, output path and SHA-256, and the measured probe/loudness results tied to that exact file. A project file, preview, successful encoder exit, or copied measurement from another version is not final-file evidence. If the renderer, decoder, required media, or playback review is unavailable, record the precise blocker and leave the affected check unavailable; do not fill the gap with a still frame, transcript, metadata inference, or text-only claim.

When failure and recovery are in scope, export a genuine decodable version with the specified defect, measure its failure, rebuild a corrected version from source material, and verify the recovered export independently. Report measured results, actual visual or listening review, and any unavailable human review separately. Never claim an inspection that was not performed.

For commands, acceptance records, failed export evidence, and recovery checks, read [export verification procedures](references/export-verification.md). Consult [the maintained source map](references/sources.md) for version sensitive claims and conflicts.
