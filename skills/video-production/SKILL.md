---
name: video-production
description: Produce and edit video and audio from the command line with ffmpeg, from planning a piece through cuts, joins, subtitles, audio levels and exports for each platform. Use when making, editing, converting or checking video or audio files.
---

# Video production

Plan what the viewer sees and hears, work on copies, and check every export by watching it, not
by trusting the command.

## 1. Plan the piece

- The point, the audience, where it'll be shown (a platform, a screen, a projector), length and
  aspect ratio (16:9, 9:16, 1:1).
- A shot list or script: each segment with its source file, in and out times, on-screen text and
  audio. Keep it in a text file next to the media. It's the edit decision list.
- Keep originals untouched. Work in a separate folder, and name outputs by version
  (`intro-v2.mp4`).

## 2. Know your sources

- Inspect before editing: `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate,channels -of compact file`.
- Mixed frame rates, sizes or sample rates must be made equal before joining. Do it explicitly.

## 3. Common operations (ffmpeg)

- **Cut precisely** (re-encodes, accurate):
  `ffmpeg -ss 00:01:05 -to 00:01:40 -i in.mp4 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k cut.mp4`.
  Fast cut without re-encoding (`-c copy`) snaps to keyframes; use it only when exact frames
  don't matter.
- **Join** files with the same format: list them in `files.txt` (`file 'a.mp4'` per line), then
  `ffmpeg -f concat -safe 0 -i files.txt -c copy joined.mp4`. Different formats: normalize first,
  or use the `concat` filter.
- **Resize and pad** to a target frame:
  `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"`.
- **Vertical from horizontal:** crop the region of interest (`-vf "crop=ih*9/16:ih"`), and check
  that faces and text stay in frame.
- **Subtitles:** keep them as an `.srt` file (also useful for accessibility). Burn them in only
  when the platform needs it: `-vf subtitles=subs.srt`.
- **Audio levels:** normalize speech to a consistent loudness, for example
  `-af loudnorm=I=-16:TP=-1.5:LRA=11` for online video. Mix music under speech with `amix`, and
  lower it with `volume`.
- **Thumbnails and stills:** `ffmpeg -ss 00:00:12 -i in.mp4 -frames:v 1 still.png`.
- **Export:** H.264 and AAC in MP4 play nearly everywhere: `-c:v libx264 -crf 20 -preset slow
  -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart`.

Long encodes are long-running processes. Run them so they finish on their own, and watch the log
for errors.

## 4. Check the result

- `ffprobe` the export: duration, resolution, frame rate and audio channels are what you intended.
- Look at stills from the start, a few cuts and the end (extract frames). Check for black frames,
  jumps, out-of-sync audio, cropped text and subtitle timing.
- Listen for clipping and level jumps between segments.
- Say what you checked, and share the export and a few stills for the person reviewing it.
