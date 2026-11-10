# Encoded export verification

Use this procedure for each delivery version, especially when source rates, color, audio mix, subtitles, or container requirements differ. Keep the expected target beside measured findings. A successful encoding command is evidence that a file was written, not proof of its viewing quality.

## Inspect the delivered streams

Read the actual container and stream metadata:

```sh
ffprobe -v error -show_entries 'format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,time_base,color_space,color_primaries,color_transfer,color_range,sample_rate,channel_layout' -of json deliver.mp4
```

Confirm the required tracks, dimensions, frame rate, duration, codec and audio layout. Check that subtitles have a supported codec for the target player. If captions are required separately, extract and inspect their decoded text and cue times:

```sh
ffmpeg -i deliver.mp4 -map 0:s:0 -c:s srt extracted.srt
```

Check the full file can decode, then inspect presentation timestamps and sample cadence. A declared average frame rate does not prove that each shot still moves.

```sh
ffmpeg -v error -i deliver.mp4 -f null -
ffprobe -v error -select_streams v:0 -show_entries frame=best_effort_timestamp_time -show_frames -of csv=p=0 deliver.mp4
ffmpeg -i deliver.mp4 -vf vfrdet -an -f null -
```

Compare frame spacing and expected frame count against the edit map; inspect actual decoded frames around cut endpoints, during motion, and at the beginning, middle seek point, and ending. For exact cue inspection, choose times on both sides of the expected frame boundary and save decoded stills:

```sh
ffmpeg -i deliver.mp4 -ss 2.96 -frames:v 1 -update 1 before.png
ffmpeg -i deliver.mp4 -ss 3.00 -frames:v 1 -update 1 at-cut.png
```

Use a player to review the entire final video, including transitions and the ending. Screenshots can establish placement but cannot establish pacing or smooth motion.

## Measure sound and picture

Measure the **encoded audio**, including integrated loudness and true peak, and compare with the target specification. The sample below reports EBU R128 loudness and true peak rather than applying a normalization preset:

```sh
ffmpeg -hide_banner -i deliver.mp4 -map 0:a:0 -vn -af 'ebur128=peak=true' -f null -
```

Correct the mix against the actual target and export again if it fails. Listen for clipped peaks, silence, abrupt fades, intelligibility, balance, and sync near both the beginning and end. Match a visual slate frame with its corresponding audio transient at the same output presentation time.

Inspect final color metadata and pixel levels. For diagnostic signal statistics on decoded frames:

```sh
ffmpeg -hide_banner -i deliver.mp4 -vf 'signalstats,metadata=print' -an -f null -
```

Review scopes or a trustworthy color managed display for clipping, range errors, and visible camera mismatches. Signal statistics and metadata are aids; neither proves that a color conversion was correct. Inspect the final crop, title safe area, readable burned captions, and accessibility of the required separate subtitle track for **each** version. A codec remux cannot fix aspect ratio, mismatched frame cadence, or a bad grade.

## Record measurable outcomes

For each export, first create an artifact receipt tied to the bytes being reviewed. Include source/generated-media paths and SHA-256 values, rights or permission boundary, target name, renderer and FFmpeg versions, effective project settings or command, output path, output SHA-256, and the timestamp of the probe. Then record the source and target specifications and a compact table of results:

| Check                 | Expected             | Observed                                   | Result and evidence                          |
| --------------------- | -------------------- | ------------------------------------------ | -------------------------------------------- |
| Tracks and duration   | Contract             | Stream probe                               | Pass, fail, or unavailable; probe output     |
| Cut and cue positions | Edit map             | Decoded frames and audio marks             | Pass, fail, or unavailable; times and frames |
| Cadence and motion    | Edit map             | Timestamps and watched footage             | Measured result plus playback status         |
| Captions              | Corrected transcript | Extracted subtitle text and visible frames | Text, timing, and occlusion findings         |
| Mix and color         | Target values        | Encoded loudness, true peak, scopes        | Numeric deviations and remaining review      |

Keep file/probe evidence, decoded frame or waveform evidence, and human watching/listening evidence in separate fields. A missing player, missing media tool, unavailable source, or blocked playback is a blocker for the corresponding check and must remain explicit; it is not a passing result. Do not describe a synthetic fixture, preview, transcript, screenshot, or metadata-only result as watching the final render.

When a task calls for negative and recovery evidence, produce an **actual playable export** with a deliberate, specified defect, prove that it fails the relevant measurement, and keep the reason visible in the report. An example for demonstrating audio sync failure delays every audio channel by 240 milliseconds:

```sh
ffmpeg -i deliver.mp4 -filter_complex '[0:a:0]adelay=240:all=1[late]' \
  -map 0:v:0 -map '[late]' -map '0:s?' -c:v copy -c:a aac -c:s copy negative.mp4
```

Confirm that the negative file decodes and that its slate timing fails the task's sync tolerance. Rebuild the corrected output from original media and project settings rather than just relabeling the defective file. Independently repeat stream, sync, audio, caption, cadence, and visual checks on the recovered export; retain both measured failure and successful recovery evidence.

State which checks were performed on actual encoded bytes, which depended on subjective watching or listening, and which remain unverified. Do not label automated probing as a human visual, listening, or accessibility review. Mark stale, simulated, inferred, or unavailable evidence explicitly.
