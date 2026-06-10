#!/usr/bin/env bash
# build-mcpb.sh — idempotent build for x-poster.mcpb
# Usage: scripts/build-mcpb.sh [--output /path/to/x-poster.mcpb]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/x-poster.mcpb}"

echo "==> [1/4] Vendoring core files into mcpb/"
bash "$ROOT/scripts/vendor-core.sh"

echo "==> [2/4] Installing production deps in mcp/"
# Use a project-local npm cache to avoid system cache EPERM issues.
MCPB_CACHE="$ROOT/.mcpb-cache"
mkdir -p "$MCPB_CACHE"
cd "$ROOT/mcp"
if [[ -f package-lock.json ]]; then
  npm_config_cache="$MCPB_CACHE" npm ci --omit=dev
else
  npm_config_cache="$MCPB_CACHE" npm install --omit=dev
fi

echo "==> [3/4] Copying node_modules + package.json into mcpb/ bundle"
cd "$ROOT"
# Clean previous copy so removed deps don't linger
rm -rf mcpb/node_modules mcpb/package.json
cp -r mcp/node_modules mcpb/node_modules
cp mcp/package.json mcpb/package.json

echo "==> [4/4] Packing mcpb/ → $OUTPUT"
# Use @anthropic-ai/mcpb (real package, v2.1.2+).
npm_config_cache="$MCPB_CACHE" npx @anthropic-ai/mcpb pack "$ROOT/mcpb" "$OUTPUT"

echo ""
echo "Built: $OUTPUT"
echo "Size:  $(du -sh "$OUTPUT" | cut -f1)"
