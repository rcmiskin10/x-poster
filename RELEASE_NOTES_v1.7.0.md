# v1.7.0 — schedule posts for later (via vibedraft)

x-poster can now hand a post to [vibedraft](https://vibedraft.app)'s scheduler instead of
posting immediately. The vibedraft cron fires it at the chosen time — **even if your machine
is asleep** — through your vibedraft-connected X account (posting cost billed there, not to
this app's keys).

## New

- **MCP tools:** `schedule_post`, `list_scheduled`, `cancel_scheduled` — available in the
  Claude Desktop connector (`.mcpb`) and the plugin MCP server. `schedule_post` keeps the same
  content-frozen confirmation gate as `publish_post`: preview first, confirm nonce, then schedule.
- **CLI flags:** `--at <ISO time>` to schedule instead of posting now (same `--confirm` gate;
  `--dry-run` schedules nothing), `--list-scheduled` (with `--status pending/posted/…` and
  `--since <ISO>`), and `--cancel <id>` for pending rows.
- **Setup:** create a token in vibedraft under **Settings → API tokens** and add
  `VIBEDRAFT_API_URL` + `VIBEDRAFT_API_TOKEN` to your env file (see `.env.example`).

## Notes & limits

- Text posts and threads only — no media scheduling in v1.
- vibedraft nudges `scheduled_for` by ± a few minutes (per your vibedraft humanization
  setting), so the stored time may differ slightly from what you asked for. That's a feature.
- No scheduling env vars set? Everything else works exactly as before — the scheduling tools
  just report they're not configured.

## Internals

- New vendored core module `core/scheduler.mjs` (client, validation, config resolution),
  wired into every surface and covered by the surface-parity guard, scheduler unit tests,
  and MCP stdio handshake tests.

`.mcpb` rebuilt for this release (core + MCP changed).
