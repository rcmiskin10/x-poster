#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in poster.mjs token-store.mjs; do
  for dest in "plugins/x-poster/bin" "mcp" "mcpb"; do
    mkdir -p "$ROOT/$dest"
    cp "$ROOT/core/$f" "$ROOT/$dest/_${f}"
  done
done
# Also vendor the MCP server into the two distribution surfaces.
# plugins/x-poster/bin/_mcp-server.mjs  → used by x-mcp.mjs entry point
# mcpb/server.mjs                        → IS the .mcpb entry (calls startServer)
for dest in "plugins/x-poster/bin:_mcp-server.mjs" "mcpb:server.mjs"; do
  dir="${dest%%:*}"
  name="${dest##*:}"
  mkdir -p "$ROOT/$dir"
  cp "$ROOT/mcp/server.mjs" "$ROOT/$dir/$name"
done
echo "vendored core → plugins/x-poster/bin, mcp, mcpb"
