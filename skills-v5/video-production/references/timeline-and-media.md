# Timeline and media procedures

Use this reference when an edit has trims, multiple cameras, external audio, sync cues, or burned captions. Adapt the examples to the actual sources, renderer, and delivery specification.

## Inspect and map the edit

Probe every input before choosing a common timebase, frame rate, dimensions, color space, and audio layout:

```sh
ffprobe -v error -show_entries 'format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,color_space,color_primaries,color_transfer,color_range,sample_rate,channel_layout' -of json source.mp4
```

Compare the contract with the sources, then record one row per shot and timed cue. For example:

| Shot   | Source interval (s) | Output interval (s) | Treatment               | Timed content                  |
| ------ | ------------------- | ------------------- | ----------------------- | ------------------------------ |
| Intro  | camera A, 0 to 3    | 0 to 3              | Native speed, fit frame | Narration, title, flash at 1 s |
| Detail | camera B, 1 to 4    | 3 to 6              | Native speed, fit frame | Caption, music, flash at 5 s   |

Use `output duration = (source out - source in) / speed` for a constant speed segment. Subtract transition overlaps when positioning the next shot. Explicitly map each source cue to output presentation time. Check audio transients and visual flashes both immediately before and during their expected output frame. For variable speed, derive mapping from the retiming curve rather than one constant offset. Track source frame boundaries with the selected timebase; a timestamp rounded to a decimal may land on a neighboring frame.

## Assemble actual moving footage

The following example joins two three second video segments at 30 fps with a previously mixed and synchronized six second audio file. It preserves aspect ratio with padding; change the fit rule if the delivery requires a crop. The mix must already reflect the edit and the expected slate positions.

```sh
ffmpeg -i shot-a.mov -i shot-b.mov -i mix.wav \
  -filter_complex "[0:v]trim=start=0:end=3,settb=AVTB,setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[a];[1:v]trim=start=1:end=4,settb=AVTB,setpts=PTS-STARTPTS,fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[b];[a][b]concat=n=2:v=1:a=0[v];[2:a]atrim=duration=6,asetpts=PTS-STARTPTS,aresample=48000[audio]" \
  -map '[v]' -map '[audio]' -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart edit.mp4
```

`trim` selects source intervals; `setpts` restarts each composition segment, and `fps` makes the chosen cadence explicit. A change from 24 or 25 fps to 30 fps can repeat frames by design. Distinguish that conversion from unintended freezes or a still image replacing moving footage. Inspect the decoded sequence at each cut and in the middle of each shot. Recalculate audio and captions when any cut, speed, or overlap changes.

### Color and sync decisions

Inspect the actual primaries, transfer, matrix, and range for every camera. Convert the pixel values into a common working space before concatenation, using a color managed editor or a verified filter configuration. For a source confirmed as SMPTE 170M and an SDR BT.709 target, an FFmpeg filter can use:

```text
colorspace=iall=smpte170m:all=bt709
```

Insert that conversion into the affected video stream before the join, and inspect the resulting pixels and scopes. Do not apply that setting to unknown sources or HDR footage. Output color tags must describe the already converted pixels; setting only stream metadata changes no image values. Verify source assumptions against the installed FFmpeg build and an encoded sample.

When an external recording starts late, trim its measured leading offset before mixing, then reset its timestamps. For example, for an observed 240 ms offset:

```sh
ffmpeg -i reference.wav -af 'atrim=start=0.24,asetpts=PTS-STARTPTS,aresample=48000' -c:a pcm_s16le aligned.wav
```

An early recording may need delay instead. Measure alignment again near the beginning and late in the timeline; a constant initial offset does not rule out long take drift. Preserve slate transients and avoid changing their position independently in video and audio.

## Visible and independent captions

Correct the transcript against speech. Time cues on the final output timeline, including trims and retiming. Keep text within the target title safe area, with a consistent bottom margin and a high contrast panel that leaves important UI content visible. Check legibility at the final encoded scale.

If the normal text filter is unavailable, render each caption as a transparent image, loop it, and enable its overlay only for the desired interval. For one cue from 1.2 to 2.8 seconds:

```sh
ffmpeg -i edit.mp4 -loop 1 -i caption.png \
  -filter_complex "[0:v][1:v]overlay=x=(W-w)/2:y=H-h-60:enable='between(t,1.2,2.8)'[v]" \
  -map '[v]' -map '0:a?' -c:v libx264 -crf 18 -c:a copy -shortest captioned.mp4
```

When a distinct subtitle track is required for MP4, mux the corrected and retimed WebVTT file with the visibly captioned video:

```sh
ffmpeg -i captioned.mp4 -i captions.vtt -map 0:v:0 -map '0:a?' -map 1:s:0 \
  -c:v copy -c:a copy -c:s mov_text -movflags +faststart deliver.mp4
```

Probe and extract the final subtitle stream to confirm its text and timing. Other target containers may require different subtitle codecs. A visible caption overlay alone does not satisfy a separate subtitle track requirement.
