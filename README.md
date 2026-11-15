# KitScout MCP server

[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-dev.kitscout%2Fkitscout-17332D)](https://registry.modelcontextprotocol.io/v0/servers?search=dev.kitscout)
[![Endpoint](https://img.shields.io/badge/endpoint-mcp.kitscout.dev%2Fmcp-E9B824)](https://kitscout.dev/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-4D6A86)](LICENSE)

**Check AI agent tools before you install them.** Your agent finds MCP servers, Agent Skills and Claude Code plugins on the web; KitScout tells it which ones are deprecated, abandoned, unofficial, renamed or down, and what to use instead. Backed by an index of ~88,000 tools with publisher identity, GitHub activity and a daily live check of every remote MCP server.

![check_tools output: one tool to avoid, one caution with an official alternative, two ok](https://raw.githubusercontent.com/kitscout-dev/kitscout-plugin/main/assets/check-tools-demo.png)

> Using Claude Code? The **[KitScout plugin](https://github.com/kitscout-dev/kitscout-plugin)** adds this server plus a skill that verifies every tool your agent recommends. Start there.

## Connect

Endpoint: `https://mcp.kitscout.dev/mcp` (Streamable HTTP, free, no API key needed, read-only; optional free key for the watch list)

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http kitscout https://mcp.kitscout.dev/mcp` |
| Claude app / claude.ai | Settings → Connectors → Add custom connector → `https://mcp.kitscout.dev/mcp` |
| Cursor, VS Code, Codex, others | add a remote (HTTP) MCP server with that URL. Step-by-step: https://kitscout.dev/mcp |

## Tools

| Tool | What it does |
|---|---|
| `check_tools(tools)` | **Verify up to 5 candidates** (GitHub URLs, npm/PyPI ids, remote MCP URLs or names): made by the product's own company? deprecated, archived or renamed? last code change, stars, does the remote server answer *right now*, where your data goes → verdict `ok` / `caution` / `avoid` plus official or better-maintained alternatives. |
| `search_tools(query, type?, only_verified?, only_live?, only_free_to_try?, limit?)` | Ranked search across MCP servers, skills and plugins. Badges: `first_party` (made by the product's maker), `verified_publisher`, `live`, `free_to_try` (worked without an API key). |
| `get_tool(name)` | Full details for one tool, including the actual tool list a remote server exposes and a ready-to-paste connect/install line. |
| `list_categories()` | All categories with tool counts. |
| `watchlist(remove?)` | With a free key (`https://mcp.kitscout.dev/mcp?key=<key>`, get one at [kitscout.dev/watch](https://kitscout.dev/watch)): every tool you `check_tools` is watched, and KitScout emails you when one is renamed, archived, deprecated or stops answering. Lists or edits the watch list. |

Try: *"Is `@modelcontextprotocol/server-postgres` still OK to install?"* or *"I want a Slack message whenever a Jira issue is closed. Find and check tools for each step with KitScout."*

## Privacy

We keep a log of calls (time to the minute, country code, client app name, what was searched or checked, and the results; with a free key, a short key id) to learn which tools agents need. No IP addresses, headers or file contents. Free-key signups store an email (alerts only) and a hash of the key, never the key. Policy: https://kitscout.dev/privacy

## Source

`worker.js` is the Cloudflare Worker that serves the endpoint; it reads the static index published on kitscout.dev and makes live calls for `check_tools`. `schema.sql` holds the D1 tables (call log, free keys, watch list). `server.json` is the MCP Registry entry.

Wrong verdict or missing tool? Open an issue or email contact@kitscout.dev. License: MIT
