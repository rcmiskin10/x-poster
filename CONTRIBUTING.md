# Contributing to x-poster

Thanks for the interest. This is a small, deliberately-minimal plugin. PRs and issues welcome.

## Ground rules (design invariants — please don't break these)

1. **Never auto-publish.** The human confirmation gate is the whole point. `bin/x-post.mjs` must
   refuse to post without `--confirm` and must default to dry-run when credentials are absent. Any
   change that lets a post go out without an explicit human OK will be rejected.
2. **The harness calls no LLM.** Drafting happens in the user's own Claude Code session, never in the
   script. Keep `bin/` dependency-free Node with no AI/API calls beyond X itself.
3. **No secrets in the repo.** Credentials live only in a user-owned env file that is never committed.
   Don't add real tokens to tests, examples, or fixtures.
4. **Bring-your-own everything.** No hardcoded handles, paths, or accounts. Config is env vars with
   documented defaults in `env/.env.example`.

## Dev loop

```
# run the tests (no network required)
node --test plugins/x-poster/bin/_tests/*.test.mjs

# try changes locally without installing
claude --plugin-dir ./plugins/x-poster
```

## Submitting changes

- Keep PRs focused; one behavior change per PR.
- Add or update a test for any behavior change in `bin/`.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- If you change the command's interface or env contract, update both READMEs and `env/.env.example`.

## Reporting bugs

Open an issue with: what you ran (redact creds), what you expected, what happened, and your OS. The
`--dry-run` output (which posts nothing and spends nothing) is the most useful thing to paste.
