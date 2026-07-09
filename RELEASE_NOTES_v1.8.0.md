# v1.8.0 — bulk scheduling: up to 20 posts in one confirmed action

Draft a week of content, schedule it all at once. Each item in a batch is an independent
post (or 2-6-tweet thread) at **its own time**, scheduled through your
[vibedraft](https://vibedraft.app) account — the vibedraft cron fires each one on time,
even if your machine is asleep.

## New

- **MCP tools:** `preview_bulk` / `schedule_bulk` — a batch is
  `posts: [{text|thread, scheduled_for, in_reply_to?}]`, max **20 items**. `preview_bulk`
  shows every post, its time, per-item + total cost, and mints ONE confirm nonce for the
  whole batch; `schedule_bulk` submits after your single explicit confirmation. The nonce
  freezes batch **content** — you can still adjust times between preview and confirm — and
  bulk nonces can never authorize `schedule_post` (or vice versa).
- **CLI flag:** `--bulk <posts.json>` — same item shape in a JSON file. Without `--confirm`
  it's a dry-run that prints the plan (per-item + total cost) and schedules nothing.
- **`.mcpb` manifest catch-up:** the Claude Desktop connector now lists the v1.7.0
  scheduling tools in its manifest and offers optional `VIBEDRAFT_API_URL` /
  `VIBEDRAFT_API_TOKEN` install fields — scheduling no longer requires an env file on the
  desktop path.

## Behavior & limits

- **Validation is all-or-nothing:** one invalid item blocks the whole batch; nothing
  partially submits from a bad spec. Bulk times must be ISO 8601 **with an explicit offset
  or `Z`** (stricter than single scheduling — 20 posts landing an hour off is the bulk
  footgun).
- **Submission is item-by-item** (the vibedraft API takes one post/thread per call), so a
  batch can partially succeed. Results are per-item: `scheduled` (with ids) / `failed` /
  `skipped` (batch aborted early on fatal errors like a revoked token or the pending-post
  cap) / `unknown` (network blip — check `list_scheduled` before resubmitting; ambiguous
  failures are never blindly retried). Rate-limit 429s are retried after a wait (safe:
  rejected before insert).
- Text only (vibedraft API v1 has no media), max 20 per batch, ≤30 days out, vibedraft's
  ±few-minutes humanization jitter applies to each post independently — keep items ≥30 min
  apart if posting order matters.

## Internals

- New core: `validateBulkSchedule` + `client.scheduleBulk` in `core/scheduler.mjs`
  (vendored to every surface), bulk nonce canonical in the MCP server, and
  `renderBulkDashboard` for the verbatim preview/result blocks. Covered by scheduler unit
  tests, a new MCP bulk-tools suite, the stdio handshake test, and new surface-parity rows.

`.mcpb` rebuilt for this release (core + MCP changed).
