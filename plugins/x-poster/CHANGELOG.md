# Changelog

## 1.0.0 (unreleased)
- Initial package: `/x-poster:x-post` command + `x-post.mjs` (single/thread posting, optional image
  via X v2 media upload, dry-run cost preview, 429 backoff, rotating-refresh-token persistence) +
  `x-auth.mjs` (one-time OAuth2-PKCE refresh-token bootstrap).
- Built-in minimal bookmarkability rubric; bring-your-own voice/avoid-slop via env vars.
- Never-auto-publish gate enforced at both the command and the poster.

> Not yet published. License (MIT) applied at public release.
