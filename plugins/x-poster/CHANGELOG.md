# Changelog

## 1.1.0
- Add `env_file` plugin userConfig: set your credentials env-file path once via
  `/plugin configure x-poster` (or `--config env_file=...` at install) instead of exporting
  `X_ENV_FILE` by hand. The command resolves the path as
  `${CLAUDE_PLUGIN_OPTION_ENV_FILE:-$X_ENV_FILE}`, so existing `X_ENV_FILE` setups keep working
  with no change.
- Secrets stay in your own writable env file (never in Claude config or git) — chosen over
  storing them in `sensitive` userConfig because the refresh token rotates on every post and must
  be written back, which secure-storage userConfig can't do.

## 1.0.0
- Initial package: `/x-poster:x-post` command + `x-post.mjs` (single/thread posting, optional image
  via X v2 media upload, dry-run cost preview, 429 backoff, rotating-refresh-token persistence) +
  `x-auth.mjs` (one-time OAuth2-PKCE refresh-token bootstrap).
- Built-in minimal bookmarkability rubric; bring-your-own voice/avoid-slop via env vars.
- Never-auto-publish gate enforced at both the command and the poster.
- MIT, published at github.com/rcmiskin10/x-poster.
