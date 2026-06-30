# v1.6.0 — Native video upload 🎬

Attach an `.mp4` to a post or thread — in both the CLI and the MCP connector.

## Added
- **`--video <path.mp4>`** (CLI) and a **`video`** parameter on the `preview_post` /
  `publish_post` MCP tools. The video attaches to the first tweet; mutually exclusive
  with `--image`.
- Chunked upload via X's **current v2 dedicated endpoints** —
  `POST /2/media/upload/initialize` → `/{id}/append` (≤5 MB segments) →
  `/{id}/finalize` → STATUS poll until transcoding completes — using your existing
  OAuth2 user token (`media.write` scope). No OAuth 1.0a.
- `preview_post` reports `hasVideo` + `videoBytes`; the confirm-nonce is bound to the
  video payload, so a preview for one clip can't authorize a different one.

## Notes
- **Video must have an audio track.** X's transcoder can reject silent clips. If yours
  is silent, add a silent track first:
  `ffmpeg -i in.mp4 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v copy -c:a aac -shortest out.mp4`
- The legacy `command=INIT/APPEND/FINALIZE` upload flow (sunset by X on 2025-05-30)
  is **not** used — this release targets the dedicated endpoints that work today.

## Install
- **One-click:** download `x-poster.mcpb` from the release assets and open it.
- **From source:** clone, then `bash scripts/build-mcpb.sh`.

> Maintainer note: the `x-poster.mcpb` asset must be rebuilt (`bash scripts/build-mcpb.sh`)
> and attached to the GitHub Release — the bundle is a frozen snapshot and won't contain
> the video code until re-packed.

**Full diff:** https://github.com/rcmiskin10/x-poster/pull/1
