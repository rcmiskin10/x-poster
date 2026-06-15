// mcp/server.mjs — X Poster MCP server
// Exports:
//   makeTools(deps)    — pure factory; testable with no SDK and no network
//   loadEnvFile(path)  — parse a KEY=VALUE env file (no --env-file dependency)
//   startServer()      — wires real deps + SDK stdio transport; run guard at bottom

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPlan, costEstimate, containsUrl, postCost, resolveMaxChars, STANDARD_TWEET_CHARS, LONGFORM_TWEET_CHARS } from "./_poster.mjs";
import { makeTokenStore } from "./_token-store.mjs";
import { startAuthSession } from "./_auth.mjs";

// ---------------------------------------------------------------------------
// loadEnvFile — minimal KEY=VALUE parser (mirrors the CLI's X_ENV_FILE support
// without depending on node's --env-file flag, which the plugin path can't set).
// Returns an object of parsed pairs; ignores blank lines and # comments.
// Splits on the FIRST '=' only (values may contain '='). Strips one layer of
// surrounding single/double quotes. Returns {} if the file can't be read.
// ---------------------------------------------------------------------------

export function loadEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nonce helpers (per-process secret; payload-bound; 10-min TTL)
// ---------------------------------------------------------------------------

function makeNonceFns(secret) {
  // Order-preserving canonical form of the normalized payload. in_reply_to is
  // bound so a reply nonce can't be replayed as a standalone post (or vice versa).
  function canonical(tweets, image, inReplyTo) {
    return JSON.stringify({ tweets, image: image || null, in_reply_to: inReplyTo || null });
  }

  function mintNonce(tweets, image, inReplyTo) {
    const ts = Date.now();
    const payload = canonical(tweets, image, inReplyTo);
    const sig = createHmac("sha256", secret).update(`${payload}.${ts}`).digest("hex");
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    return `${hash}.${ts}.${sig}`;
  }

  function verifyNonce(nonce, tweets, image, inReplyTo) {
    if (!nonce || typeof nonce !== "string") return false;
    const parts = nonce.split(".");
    // Format: payloadHash.ts.sig — sig (64-char hex) last, ts second-to-last, payloadHash everything before.
    if (parts.length < 3) return false;
    const sig = parts[parts.length - 1];
    const ts = parseInt(parts[parts.length - 2], 10);
    const hash = parts.slice(0, parts.length - 2).join(".");

    if (isNaN(ts)) return false;
    if (Date.now() - ts >= 600_000) return false; // 10-min TTL

    const payload = canonical(tweets, image, inReplyTo);
    const expectedHash = createHmac("sha256", secret).update(payload).digest("hex");
    const expectedSig = createHmac("sha256", secret).update(`${payload}.${ts}`).digest("hex");

    // Constant-time comparisons
    let hashMatch = false;
    let sigMatch = false;
    try {
      hashMatch = timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
      sigMatch = timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex"));
    } catch {
      return false;
    }
    return hashMatch && sigMatch;
  }

  return { mintNonce, verifyNonce };
}

// ---------------------------------------------------------------------------
// resolveAuthPort — the authorize callback port.
// An UNSET optional .mcpb user_config field arrives as "" (not undefined), and
// Number("") is 0 → an ephemeral port → a callback URL that won't match the
// http://127.0.0.1:8723/callback registered in the X app. So treat blank/invalid
// as the 8723 default. An explicit "0" is honored (tests bind an ephemeral port).
// ---------------------------------------------------------------------------

export function resolveAuthPort(raw) {
  const v = (raw ?? "").toString().trim();
  if (v === "") return 8723;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 8723;
}

// resolveMaxChars + the char-limit constants live in core (single source of
// truth, shared with the CLI). Re-exported here so callers and tests that
// import from the server keep working.
export { resolveMaxChars, STANDARD_TWEET_CHARS, LONGFORM_TWEET_CHARS };

// ---------------------------------------------------------------------------
// normalize: text|thread → tweets[], error if both or neither
// ---------------------------------------------------------------------------

function normalize({ text, thread }) {
  const hasText = text !== undefined && text !== null;
  const hasThread = Array.isArray(thread) && thread.length > 0;

  if (hasText && hasThread) throw new Error("provide either text or thread, not both");
  if (!hasText && !hasThread) throw new Error("provide either text or thread");

  const tweets = hasThread ? thread : [text];
  return tweets;
}

// ---------------------------------------------------------------------------
// renderDashboard — preformatted step-tracker block for tool responses.
// Clients relay it VERBATIM, so the workflow display is deterministic and
// identical across sessions — the model never reformats preview data.
// stage: "preview" | "published"
// ---------------------------------------------------------------------------

export function renderDashboard({ stage, tweets, perPost, estimatedCostUsd, hasImage, inReplyTo, errors = [], urls = [] }) {
  const isThread = tweets.length > 1;
  const kind = isThread ? `thread ×${tweets.length}` : "post";
  const header = `🐦 x-poster ▸ ${kind}${inReplyTo ? ` ▸ reply → ${inReplyTo}` : ""}`;

  const rule = "─".repeat(44);
  const body = tweets.map((t, i) => `${i + 1}│ ${t}`).join("\n");

  const ok = errors.length === 0;
  const steps =
    stage === "published" ? "✅ resolve   ✅ validate   ✅ gate   ✅ publish"
    : ok                  ? "✅ resolve   ✅ validate   🟡 gate   ⚪ publish"
    :                       "✅ resolve   ❌ validate   ⚪ gate   ⚪ publish";

  const chars = perPost.reduce((n, p) => n + p.chars, 0);
  const hasUrl = perPost.some((p) => p.hasUrl);
  const stats = `📝 ${tweets.length} tweet${isThread ? "s" : ""} · ${chars} chars · ${hasImage ? "🖼 image" : "🖼 none"} · ${hasUrl ? "🔗 url" : "🔗 none"}`;
  const cost = stage === "published"
    ? `💸 $${estimatedCostUsd.toFixed(3)} charged`
    : `💸 est. $${estimatedCostUsd.toFixed(3)}`;

  const lines = [header, rule, body, rule, steps, stats, cost];
  if (stage === "published") {
    for (const u of urls) lines.push(`🚀 live: ${u}`);
  } else if (ok) {
    lines.push(`🚦 awaiting explicit confirmation — reply "ship it" to publish`);
  } else {
    for (const e of errors) lines.push(`⚠️ ${e}`);
    lines.push("⛔ fix validation errors, then preview again");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// makeTools — pure factory; no SDK, no network required
// deps = { postThread, statePath, elicit?, maxChars? }
//   postThread(tweets, image?) → ids[]   (injected; may be mock)
//   elicit is either null or async ({rendered, costUsd}) => boolean
//   maxChars is the per-tweet character limit (default 25000; X's hard ceiling)
// ---------------------------------------------------------------------------

export function makeTools(deps) {
  const {
    postThread: injectedPostThread,
    statePath,
    elicit = null,
    maxChars = LONGFORM_TWEET_CHARS,
  } = deps;

  // Per-factory random secret for nonces
  const nonceSecret = randomBytes(32);
  const { mintNonce, verifyNonce } = makeNonceFns(nonceSecret);

  // -------------------------------------------------------------------------
  // preview_post — PURE, zero network
  // -------------------------------------------------------------------------
  async function previewHandler({ text, thread, image, in_reply_to }) {
    const tweets = normalize({ text, thread });
    const plan = buildPlan({ tweets, dryRun: true, image: image || null, maxChars });
    const confirm_nonce = mintNonce(tweets, image || null, in_reply_to || null);
    return {
      tweets: plan.tweets,
      perPost: plan.perPost,
      estimatedCostUsd: plan.estimatedCostUsd,
      isThread: plan.isThread,
      hasImage: plan.hasImage,
      errors: plan.errors,
      confirm_nonce,
      render: renderDashboard({
        stage: "preview",
        tweets: plan.tweets,
        perPost: plan.perPost,
        estimatedCostUsd: plan.estimatedCostUsd,
        hasImage: plan.hasImage,
        inReplyTo: in_reply_to || null,
        errors: plan.errors,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // publish_post — the ONLY writer
  // -------------------------------------------------------------------------
  async function publishHandler({ text, thread, image, confirm_nonce, in_reply_to }) {
    const tweets = normalize({ text, thread });
    if (tweets.length === 0 || tweets.every(t => !t || !t.trim())) {
      throw new Error("no tweets: text is empty");
    }

    // Server-side recompute of cost — never trust model-supplied cost
    const plan = buildPlan({ tweets, dryRun: false, confirm: true, hasCreds: true, image: image || null, maxChars });
    if (plan.errors.length) throw new Error(plan.errors.join("; "));

    // Confirmation gate
    if (typeof elicit === "function") {
      const reply = in_reply_to ? `\n\n(reply to tweet ${in_reply_to})` : "";
      const rendered = tweets.join("\n---\n") + reply;
      const approved = await elicit({ rendered, costUsd: plan.estimatedCostUsd });
      if (!approved) throw new Error("user declined");
    } else {
      if (!verifyNonce(confirm_nonce, tweets, image || null, in_reply_to || null)) {
        throw new Error("missing/invalid confirm_nonce — call preview_post first to get a nonce");
      }
    }

    // Post via injected postThread
    const ids = await injectedPostThread(tweets, image || null, in_reply_to || null);
    const urls = ids.map(id => `https://x.com/i/web/status/${id}`);
    return {
      posted: ids,
      urls,
      render: renderDashboard({
        stage: "published",
        tweets,
        perPost: plan.perPost,
        estimatedCostUsd: plan.estimatedCostUsd,
        hasImage: plan.hasImage,
        inReplyTo: in_reply_to || null,
        urls,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // auth_instructions — read-only
  // -------------------------------------------------------------------------
  async function authHandler() {
    return {
      easiest_path: [
        "1. One-time, in a browser: create a free X Developer App at https://developer.x.com.",
        "   In 'User authentication settings' set App type = Web App / Confidential client,",
        "   add the EXACT callback URL http://127.0.0.1:8723/callback,",
        "   and enable scopes: tweet.read tweet.write users.read media.write offline.access.",
        "2. Give this MCP server the app's Client ID and Client Secret (the .mcpb install dialog asks for them).",
        "3. Run the `authorize` tool — it returns a link. Open it, click Authorize, done. No terminal needed.",
      ],
      cli_alternative: {
        command: "node --env-file=.env bin/x-auth.mjs",
        note: "Prints X_REFRESH_TOKEN=... to paste into your env file. Same flow, terminal flavor.",
      },
      envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
      optionalEnvVars: {
        X_REFRESH_TOKEN: "Seed token — only needed if you skip the authorize tool",
        X_STATE_FILE: "Path to persist the rotating refresh token (default: ~/.local/state/x-poster/token)",
        X_AUTH_PORT: "Callback port for authorize (default 8723; must match the registered callback URL)",
      },
    };
  }

  return {
    preview_post: { handler: previewHandler },
    publish_post: { handler: publishHandler },
    auth_instructions: { handler: authHandler },
  };
}

// ---------------------------------------------------------------------------
// makePostAdapter — pure factory for the injected postThread.
// core.postThread(tweets, creds, onRotatedToken, image) ALREADY owns refresh +
// rotation (it calls refreshAccessToken internally and invokes onRotatedToken
// when the single-use token rotates). So the adapter must:
//   - call corePostThread EXACTLY ONCE (no extra refresh → no double-burn),
//   - pass tokenStore.current() as the refresh token,
//   - persist any rotated token via tokenStore.persist.
// Serialize posts: X refresh tokens are single-use; two concurrent posts could
// double-burn the token and trip reuse-detection (revokes the whole grant).
// Testable with no SDK and no network (inject a fake corePostThread).
// ---------------------------------------------------------------------------

// Module-level promise chain: ensures posts are executed one at a time.
let _postChain = Promise.resolve();

export function makePostAdapter({ tokenStore, corePostThread, clientId, clientSecret }) {
  return (tweets, image, inReplyTo) => {
    // Fail with the FIX, not the symptom: a fresh install has no refresh token
    // yet, and the cure is one authorize call — not an opaque OAuth 400.
    try {
      tokenStore.current();
    } catch {
      return Promise.reject(new Error(
        "Not connected to your X account yet — run the authorize tool first. " +
        "It returns a link; open it, click Authorize, done. No terminal needed.",
      ));
    }
    const run = _postChain.then(() =>
      corePostThread(
        tweets,
        { clientId, clientSecret, refreshToken: tokenStore.current() },
        (newToken) => tokenStore.persist(newToken),
        image || null,
        inReplyTo || null,
      )
    );
    // Keep the chain alive whether this call succeeds or errors.
    _postChain = run.then(() => {}, () => {});
    return run;
  };
}

// ---------------------------------------------------------------------------
// startServer — wires real deps + SDK stdio transport
// ---------------------------------------------------------------------------

export async function startServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  // Credential resolution. The .mcpb bundle injects creds via user_config → env.
  // The Claude Code plugin path has no UI for that, so it can point X_ENV_FILE at
  // the SAME env file the CLI uses. process.env always wins over the file.
  // Blank .mcpb user_config fields arrive as empty strings — treat as unset.
  const norm = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const fileCreds = process.env.X_ENV_FILE ? loadEnvFile(process.env.X_ENV_FILE) : {};
  const clientId = norm(process.env.X_CLIENT_ID) ?? norm(fileCreds.X_CLIENT_ID);
  const clientSecret = norm(process.env.X_CLIENT_SECRET) ?? norm(fileCreds.X_CLIENT_SECRET);

  // Fail fast with an actionable message rather than letting a missing client
  // credential surface as an opaque 401 at publish time.
  if (!clientId || !clientSecret) {
    throw new Error(
      "missing X_CLIENT_ID/X_CLIENT_SECRET. Either install the .mcpb bundle " +
        "(enter keys in the Claude UI) or set X_ENV_FILE to your env file / export " +
        "the vars before launching. Run auth_instructions for help.",
    );
  }

  const XDG_STATE_HOME = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`;
  const defaultStatePath = `${process.env.CLAUDE_PLUGIN_DATA || `${XDG_STATE_HOME}/x-poster`}/token`;
  const statePath = process.env.X_STATE_FILE || defaultStatePath;
  const seedRefreshToken = norm(process.env.X_REFRESH_TOKEN) ?? norm(fileCreds.X_REFRESH_TOKEN);

  const tokenStore = makeTokenStore({ statePath, seedRefreshToken });

  const { postThread: corePostThread } = await import("./_poster.mjs");

  const server = new McpServer({ name: "x-poster", version: "0.1.0" });

  // The post adapter is stable across connections; only `elicit` varies per
  // request (client elicitation capability is per-connection). So we build a
  // fresh tools instance per publish call with the right `elicit`, but reuse
  // this one adapter so corePostThread is called exactly once per post.
  const injectedPostThread = makePostAdapter({ tokenStore, corePostThread, clientId, clientSecret });

  // Char count doesn't block by default (long-form works); X_MAX_TWEET_CHARS can
  // opt back into a stricter limit like 280.
  const maxChars = resolveMaxChars(process.env.X_MAX_TWEET_CHARS);

  // makeTools(elicit) — factory bound to the stable deps, parameterized on elicit.
  const buildTools = (elicit) =>
    makeTools({ postThread: injectedPostThread, statePath, elicit, maxChars });

  // preview_post / auth_instructions never elicit, so a nonce-mode instance is fine.
  // IMPORTANT: nonces are bound to a per-factory random secret, so preview_post and
  // publish_post (nonce branch) must share ONE tools instance, or a preview nonce
  // won't verify at publish. Use this shared instance for both.
  const nonceTools = buildTools(null);

  // Register tools with zod raw-shape inputs (SDK 1.29 rejects plain JSON Schema
  // in registerTool — it only accepts Zod schemas / raw shapes).
  server.registerTool(
    "preview_post",
    {
      description: "Preview an X post or thread. Returns cost estimate, a confirm_nonce for publish_post, and a `render` dashboard block — show `render` to the user VERBATIM (do not reformat). PURE — no network I/O.",
      inputSchema: {
        text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
        thread: z.array(z.string()).optional().describe("Array of tweet texts for a thread (mutually exclusive with text)"),
        image: z.string().optional().describe("Absolute path to an image file to attach to the first tweet"),
        in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — the post (or first tweet of a thread) becomes a reply to it"),
      },
    },
    async (args) => {
      const result = await nonceTools.preview_post.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "publish_post",
    {
      description: "Publish an X post or thread. Re-validates and recomputes cost server-side. Requires a valid confirm_nonce from preview_post (when elicitation not supported by client). Returns a `render` dashboard block — show it to the user VERBATIM.",
      inputSchema: {
        text: z.string().optional().describe("Single tweet text (mutually exclusive with thread)"),
        thread: z.array(z.string()).optional().describe("Array of tweet texts for a thread (mutually exclusive with text)"),
        image: z.string().optional().describe("Absolute path to an image file to attach to the first tweet"),
        in_reply_to: z.string().optional().describe("Existing tweet ID to reply to — must match the in_reply_to passed to preview_post (the nonce is bound to it)"),
        confirm_nonce: z.string().optional().describe("Nonce issued by preview_post for the SAME payload. Required when client does not support elicitation."),
      },
    },
    async (args, ctx) => {
      // Per-connection capability check. Elicitation-capable client → elicit confirm.
      // Non-capable client → fall through to nonce verification (reachable path).
      const supportsElicitation = !!ctx?.clientCapabilities?.elicitation;

      let tools;
      if (supportsElicitation) {
        const elicit = async ({ rendered, costUsd }) => {
          const result = await ctx.mcpReq.elicitInput({
            mode: "form",
            message: `Confirm posting to X:\n\n${rendered}\n\nEstimated cost: $${costUsd.toFixed(3)}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Confirm post",
                  description: "Set to true to approve posting",
                },
              },
              required: ["confirm"],
            },
          });
          return result.action === "accept" && result.content?.confirm === true;
        };
        tools = buildTools(elicit);
      } else {
        // Reuse the shared nonce-mode instance so a confirm_nonce minted by
        // preview_post verifies (nonce secret is per-factory).
        tools = nonceTools;
      }

      const result = await tools.publish_post.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "auth_instructions",
    {
      description: "Returns the steps and command to mint an X OAuth 2.0 refresh token for use with this MCP server.",
      inputSchema: {},
    },
    async () => {
      const result = await nonceTools.auth_instructions.handler();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // authorize — in-chat OAuth bootstrap. Replaces the terminal x-auth.mjs step:
  // returns a link, the localhost callback exchanges the code and persists the
  // refresh token into the token store. One active session at a time.
  let activeAuthSession = null;
  server.registerTool(
    "authorize",
    {
      description:
        "Connect x-poster to the user's X account. Returns a link the user must open and approve — present it as a clickable link. " +
        "Run this on first-time setup, or when posting fails with 'not connected'. No terminal needed.",
      inputSchema: {},
    },
    async () => {
      activeAuthSession?.close();
      activeAuthSession = null;
      const port = resolveAuthPort(process.env.X_AUTH_PORT);
      let session;
      try {
        session = await startAuthSession({
          clientId,
          clientSecret,
          port,
          onToken: (token) => tokenStore.persist(token),
          onDone: () => { activeAuthSession = null; },
        });
      } catch (e) {
        const hint = e.code === "EADDRINUSE"
          ? ` Port ${port} is busy — close whatever is using it, or set X_AUTH_PORT to a free port AND register http://127.0.0.1:<port>/callback in your X app.`
          : "";
        throw new Error(`could not start the authorize listener: ${e.message}.${hint}`);
      }
      activeAuthSession = session;
      const result = {
        action_required: "Open this link in your browser and click 'Authorize app'.",
        authorize_url: session.authorizeUrl,
        expires: "The link is valid for 10 minutes.",
        after_approving: "X redirects to a local page saying 'Authorized ✓'. Come back here and post — setup is done.",
        troubleshooting: `If X shows a callback/redirect error, make sure ${session.redirectUri} is registered EXACTLY in your X app's callback URLs.`,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run guard
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startServer().catch((err) => {
    process.stderr.write(`x-poster-mcp: fatal: ${err.message}\n`);
    process.exit(1);
  });
}
