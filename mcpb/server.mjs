// mcp/server.mjs — X Poster MCP server
// Exports:
//   makeTools(deps)    — pure factory; testable with no SDK and no network
//   loadEnvFile(path)  — parse a KEY=VALUE env file (no --env-file dependency)
//   startServer()      — wires real deps + SDK stdio transport; run guard at bottom

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildPlan, costEstimate, containsUrl, postCost } from "./_poster.mjs";
import { makeTokenStore } from "./_token-store.mjs";

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
  // Order-preserving canonical form of the normalized payload.
  function canonical(tweets, image) {
    return JSON.stringify({ tweets, image: image || null });
  }

  function mintNonce(tweets, image) {
    const ts = Date.now();
    const payload = canonical(tweets, image);
    const sig = createHmac("sha256", secret).update(`${payload}.${ts}`).digest("hex");
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    return `${hash}.${ts}.${sig}`;
  }

  function verifyNonce(nonce, tweets, image) {
    if (!nonce || typeof nonce !== "string") return false;
    const parts = nonce.split(".");
    // Format: payloadHash.ts.sig — sig (64-char hex) last, ts second-to-last, payloadHash everything before.
    if (parts.length < 3) return false;
    const sig = parts[parts.length - 1];
    const ts = parseInt(parts[parts.length - 2], 10);
    const hash = parts.slice(0, parts.length - 2).join(".");

    if (isNaN(ts)) return false;
    if (Date.now() - ts >= 600_000) return false; // 10-min TTL

    const payload = canonical(tweets, image);
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
// makeTools — pure factory; no SDK, no network required
// deps = { postThread, statePath, elicit? }
//   postThread(tweets, image?) → ids[]   (injected; may be mock)
//   elicit is either null or async ({rendered, costUsd}) => boolean
// ---------------------------------------------------------------------------

export function makeTools(deps) {
  const {
    postThread: injectedPostThread,
    statePath,
    elicit = null,
  } = deps;

  // Per-factory random secret for nonces
  const nonceSecret = randomBytes(32);
  const { mintNonce, verifyNonce } = makeNonceFns(nonceSecret);

  // -------------------------------------------------------------------------
  // preview_post — PURE, zero network
  // -------------------------------------------------------------------------
  async function previewHandler({ text, thread, image }) {
    const tweets = normalize({ text, thread });
    const plan = buildPlan({ tweets, dryRun: true, image: image || null });
    const confirm_nonce = mintNonce(tweets, image || null);
    return {
      tweets: plan.tweets,
      perPost: plan.perPost,
      estimatedCostUsd: plan.estimatedCostUsd,
      isThread: plan.isThread,
      hasImage: plan.hasImage,
      errors: plan.errors,
      confirm_nonce,
    };
  }

  // -------------------------------------------------------------------------
  // publish_post — the ONLY writer
  // -------------------------------------------------------------------------
  async function publishHandler({ text, thread, image, confirm_nonce }) {
    const tweets = normalize({ text, thread });
    if (tweets.length === 0 || tweets.every(t => !t || !t.trim())) {
      throw new Error("no tweets: text is empty");
    }

    // Server-side recompute of cost — never trust model-supplied cost
    const plan = buildPlan({ tweets, dryRun: false, confirm: true, hasCreds: true, image: image || null });
    if (plan.errors.length) throw new Error(plan.errors.join("; "));

    // Confirmation gate
    if (typeof elicit === "function") {
      const rendered = tweets.join("\n---\n");
      const approved = await elicit({ rendered, costUsd: plan.estimatedCostUsd });
      if (!approved) throw new Error("user declined");
    } else {
      if (!verifyNonce(confirm_nonce, tweets, image || null)) {
        throw new Error("missing/invalid confirm_nonce — call preview_post first to get a nonce");
      }
    }

    // Post via injected postThread
    const ids = await injectedPostThread(tweets, image || null);
    const urls = ids.map(id => `https://x.com/i/web/status/${id}`);
    return { posted: ids, urls };
  }

  // -------------------------------------------------------------------------
  // auth_instructions — read-only
  // -------------------------------------------------------------------------
  async function authHandler() {
    return {
      steps: [
        "1. Create an X Developer App at https://developer.x.com with 'Read and Write' permissions.",
        "2. Add 'http://localhost:3000/callback' as an OAuth 2.0 redirect URI.",
        "3. Set environment variables: X_CLIENT_ID, X_CLIENT_SECRET.",
        "4. Run the auth flow: node --env-file=.env bin/x-auth.mjs",
        "5. The tool will print a refresh token. Set X_REFRESH_TOKEN=<value> in your .env file.",
        "6. Start the MCP server: X_CLIENT_ID=... X_CLIENT_SECRET=... X_REFRESH_TOKEN=... node mcp/server.mjs",
      ],
      command: "node --env-file=.env bin/x-auth.mjs",
      envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN"],
      optionalEnvVars: {
        X_STATE_FILE: "Path to persist the rotating refresh token (default: ~/.local/state/x-poster/token)",
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
  return (tweets, image) => {
    const run = _postChain.then(() =>
      corePostThread(
        tweets,
        { clientId, clientSecret, refreshToken: tokenStore.current() },
        (newToken) => tokenStore.persist(newToken),
        image || null,
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

  // Credential resolution. The .mcpb bundle injects creds via user_config → env.
  // The Claude Code plugin path has no UI for that, so it can point X_ENV_FILE at
  // the SAME env file the CLI uses. process.env always wins over the file.
  const fileCreds = process.env.X_ENV_FILE ? loadEnvFile(process.env.X_ENV_FILE) : {};
  const clientId = process.env.X_CLIENT_ID ?? fileCreds.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET ?? fileCreds.X_CLIENT_SECRET;

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
  const seedRefreshToken = process.env.X_REFRESH_TOKEN ?? fileCreds.X_REFRESH_TOKEN;

  const tokenStore = makeTokenStore({ statePath, seedRefreshToken });

  const { postThread: corePostThread } = await import("./_poster.mjs");

  const server = new McpServer({ name: "x-poster", version: "0.1.0" });

  // The post adapter is stable across connections; only `elicit` varies per
  // request (client elicitation capability is per-connection). So we build a
  // fresh tools instance per publish call with the right `elicit`, but reuse
  // this one adapter so corePostThread is called exactly once per post.
  const injectedPostThread = makePostAdapter({ tokenStore, corePostThread, clientId, clientSecret });

  // makeTools(elicit) — factory bound to the stable deps, parameterized on elicit.
  const buildTools = (elicit) =>
    makeTools({ postThread: injectedPostThread, statePath, elicit });

  // preview_post / auth_instructions never elicit, so a nonce-mode instance is fine.
  // IMPORTANT: nonces are bound to a per-factory random secret, so preview_post and
  // publish_post (nonce branch) must share ONE tools instance, or a preview nonce
  // won't verify at publish. Use this shared instance for both.
  const nonceTools = buildTools(null);

  // Register tools with JSON schema inputs
  server.registerTool(
    "preview_post",
    {
      description: "Preview an X post or thread. Returns cost estimate and a confirm_nonce for publish_post. PURE — no network I/O.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Single tweet text (mutually exclusive with thread)" },
          thread: {
            type: "array",
            items: { type: "string" },
            description: "Array of tweet texts for a thread (mutually exclusive with text)",
          },
          image: { type: "string", description: "Absolute path to an image file to attach to the first tweet" },
        },
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
      description: "Publish an X post or thread. Re-validates and recomputes cost server-side. Requires a valid confirm_nonce from preview_post (when elicitation not supported by client).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Single tweet text (mutually exclusive with thread)" },
          thread: {
            type: "array",
            items: { type: "string" },
            description: "Array of tweet texts for a thread (mutually exclusive with text)",
          },
          image: { type: "string", description: "Absolute path to an image file to attach to the first tweet" },
          confirm_nonce: {
            type: "string",
            description: "Nonce issued by preview_post for the SAME payload. Required when client does not support elicitation.",
          },
        },
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
      inputSchema: { type: "object", properties: {} },
    },
    async () => {
      const result = await nonceTools.auth_instructions.handler();
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
