# x-poster

**Post to X without leaving Claude Code. Just say what you're thinking.**

You're deep in a build session. A thought lands. A realization, a hot take, the thing you just
figured out. Normally it dies in the terminal, or in a notes file you never reopen.

x-poster gives that thought a mouth. You talk to Claude like you already do. It drafts the tweet in
your voice, shows you the cost, and posts only when you say "ship it."

No browser tab. No context switch. No autospam.

---

## Why it's basically free

x-poster doesn't run its own AI. The drafting happens inside *your* Claude Code session, so it's
covered by the Claude subscription you already pay for. The plugin itself calls no API and costs you
nothing. The only charge is X's own pay-per-use posting (~$0.015 a post), billed to your own X app.

You bring: a Claude Code subscription you already have, and a free X developer app. That's it.

## What it does

- **Draft by talking.** `/x-poster:x-post draft a post about what I shipped today` gives you a tweet
  in your voice. Or hand it final text and it posts that verbatim.
- **Single tweet, thread, or image.** Linear threads and one image (via X's v2 media upload).
- **Cost preview before you spend.** Every draft is dry-run priced and character-checked first.
- **A hard never-auto-publish gate.** Nothing leaves your machine until you confirm. With no
  credentials the poster refuses to post at all, so a bare run literally cannot spend.
- **Your voice, your rules.** Point it at your own voice file and your own banned-phrase list.
- **Token hygiene built in.** OAuth2-PKCE bootstrap, refresh-token rotation persisted for you.

## Who it's for

Indie hackers vibing in Claude Code who have good thoughts mid-build and want them out in the world
the moment they land, without breaking flow to open X, write, and post. If your best material dies
in the terminal, this is for you.

## Install

```
/plugin marketplace add rcmiskin10/x-poster
/plugin install x-poster@x-poster
```

Then a one-time setup: create your own X app, mint a refresh token, point one env var at a writable
file. Full steps in [plugins/x-poster/README.md](plugins/x-poster/README.md), about 5 minutes.

## Use it

```
/x-poster:x-post draft a post about the bug I just killed
```

It drafts, scores against a built-in bookmarkability rubric, dry-runs the cost, and asks "ship it?"
Nothing posts until you say so.

## What it is NOT

- Not an autoposter. There is no "post while I sleep" mode, by design. The human gate is the point,
  and it's also what keeps it free (an always-on version would bill the API, not your subscription).
- Not a growth-hack bot. One thought, one confirmation, one post.
- Not a hosted service. It runs on your machine, with your keys, on your subscription.

## How it works

Two pieces, cleanly split:
- **The harness** (`bin/x-post.mjs`, `bin/x-auth.mjs`): dependency-free Node. OAuth, posting, threads,
  image upload, dry-run cost, token rotation. Calls no AI.
- **The payload** (the `/x-poster:x-post` command): runs in your Claude session, does the drafting and
  scoring. This is where the "just by talking" comes from.

That split is why your subscription covers the smart part and the tool costs nothing to run.

## License

[MIT](LICENSE).
