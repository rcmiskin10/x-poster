# x-poster v1.9.0 — scheduled posts can carry media

Schedule a post with an image or video and let vibedraft post it for you — even
with your machine asleep. Previously scheduling was text-only; media meant
posting immediately or not at all.

## New

- **Media on `schedule_post` (MCP) and `--at` (CLI).** Attach one `image`
  (jpg/png/webp ≤ 5 MB) or one `video` (.mp4 ≤ 512 MB) to a scheduled post or
  thread (it rides on the first tweet). The file uploads to vibedraft's v1
  media API at schedule time — metadata init, a direct PUT of the bytes to
  storage (no proxy body caps), then a completion check that verifies the
  upload landed intact — and vibedraft's dispatcher attaches it when the post
  fires.
- **Upload happens AFTER you confirm.** A declined or edited draft never
  spends an upload.
- **The confirmation nonce covers media both directions.** A preview without
  media can't be replayed to schedule with media, and vice versa — same
  payload-binding rule publishing has always had.

## Behavior notes

- **Bulk scheduling stays text-only, loudly.** A `--bulk` item carrying
  `image`/`video` is rejected with a clear error instead of silently dropping
  the attachment. Schedule media posts one at a time.
- Requires the vibedraft side of the contract (v1 media API); text-only
  scheduling keeps working against older vibedraft deployments unchanged.
- Docs: `commands/x-post.md` and `env/.env.example` updated for
  media-on-schedule.

## Verification

157/157 tests across all four surfaces (core, MCP, `.mcpb`, plugin CLI),
including new surface-parity rows for schedule-media. Live-smoked end to end
against production vibedraft with a 13.9 MB mp4: upload → ready → scheduled
row carrying the media id.

`.mcpb` rebuilt (core/ and mcp/ changed).
