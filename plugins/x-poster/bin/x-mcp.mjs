#!/usr/bin/env node
// x-mcp.mjs — Claude Code plugin entry point for the x-poster MCP server.
// Relies on _mcp-server.mjs, _poster.mjs, and _token-store.mjs being beside it
// (all three are vendored here by scripts/vendor-core.sh).
import { startServer } from "./_mcp-server.mjs";
startServer();
