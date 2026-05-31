# x-poster

Post a tweet or a linear thread (with an optional image) to X **from your terminal**, inside Claude
Code. Dependency-free Node, OAuth2-PKCE bootstrap, a dry-run cost preview, and a hard
**never-auto-publish** gate. Bring your own X app.

- `/x-poster:x-post` — draft (or take) text, score it, preview cost, **confirm**, then post.
- `bin/x-post.mjs` — the mechanical poster (single tweet or thread, optional image, dry-run, cost).
- `bin/x-auth.mjs` — one-time flow to mint your refresh token.

Nothing posts without your explicit confirmation, and the poster defaults to **dry-run** whenever
credentials are absent — a bare run can never spend.

---

## Install

```
/plugin marketplace add rcmiskin10/x-poster-marketplace
/plugin install x-poster@x-poster-marketplace
```

(Local dev before publishing: `claude --plugin-dir ./plugins/x-poster`.)

## 1. Create your own X app

At [developer.x.com](https://developer.x.com), create a project/app, then in **User authentication
settings**:

- App type: **Web App / Confidential client**
- Add this **exact** callback URL: `http://127.0.0.1:8723/callback`
  (If port 8723 is taken, pick another, set `X_AUTH_PORT`, and register the matching URL.)
- Scopes: `tweet.read tweet.write users.read media.write offline.access`
  - `media.write` is **required** for image upload (else `/2/media/upload` returns 403).
  - `offline.access` is **required** to receive a refresh token.
- Copy the app's **Client ID** and **Client Secret**.

## 2. Create your env file

Copy the template to a writable file you control (never commit it):

```
cp "${CLAUDE_PLUGIN_ROOT}/env/.env.example" ./x-poster.env
```

Fill in `X_CLIENT_ID` and `X_CLIENT_SECRET`.

## 3. Mint your refresh token (one time)

```
node --env-file=./x-poster.env "${CLAUDE_PLUGIN_ROOT}/bin/x-auth.mjs"
```

A browser opens — click **Authorize**. The script prints `X_REFRESH_TOKEN=…`. Paste that line into
`./x-poster.env`. The token stays on your machine; nothing is committed. (Refresh tokens are
single-use and rotate; the poster rewrites the new one back to `X_ENV_FILE` on every post.)

## 4. Permissions (you add these — plugins can't)

Claude Code plugins cannot set permissions for you. Add an allow-rule for the poster to your own
`settings.json` so the command can run it without a prompt, e.g.:

```json
{ "permissions": { "allow": ["Bash(node --env-file=*)"] } }
```

## 5. Use it

```
export X_ENV_FILE="$PWD/x-poster.env"   # so rotated tokens persist to the right file
/x-poster:x-post draft a post about what I shipped today
```

It drafts, scores against the built-in rubric, **dry-runs the cost**, then asks **"ship it?"** —
nothing posts until you confirm.

**Cost:** X pay-per-use, ~$0.015/post, ~$0.20/post-with-URL.

### Optional
- `VOICE_CONFIG_PATH=/path/to/voice.md` — match your own voice file when drafting.
- `AVOID_SLOP_PATH=/path/to/avoid-slop.md` — enforce your own forbidden-phrase list (see
  `config/avoid-slop.example.md`).
- Pre-flight image auth without spending: `node --env-file=./x-poster.env "${CLAUDE_PLUGIN_ROOT}/bin/x-post.mjs" --upload-only ./shot.png`

## Notes
- Browser open uses macOS `open`; on Linux/Windows the authorize URL is printed for manual paste.
- Tests (no network): `node --test "${CLAUDE_PLUGIN_ROOT}/bin/_tests/"*.test.mjs`

## License
MIT (applied at public release).
