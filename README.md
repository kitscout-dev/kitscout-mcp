# KitScout MCP server

Let your AI agent find the right tool for the job. KitScout indexes **~84,000 AI agent tools** — MCP servers (official MCP Registry), Agent Skills (GitHub `SKILL.md`) and Claude Code plugins — with GitHub stars, categories and a **daily live check of every remote MCP server** (does it answer? does it work without an API key?).

**Endpoint:** `https://mcp.kitscout.dev/mcp` (Streamable HTTP, free, no key, read-only)
**Website:** https://kitscout.dev

## Connect

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http kitscout https://mcp.kitscout.dev/mcp` |
| Claude app / claude.ai | Settings → Connectors → Add custom connector → `https://mcp.kitscout.dev/mcp` |
| Cursor / VS Code / others | add a remote (HTTP) MCP server with URL `https://mcp.kitscout.dev/mcp` |

## Tools

| Tool | What it does |
|---|---|
| `search_tools(query, type?, only_official?, only_live?, only_free_to_try?, limit?)` | Ranked keyword search across MCP servers, skills and plugins. Each result: type, category, stars, badges (`first_party` = made by the product's own maker, `verified_publisher`, `live`, `free_to_try`), where it runs, install line, KitScout page. |
| `get_tool(name)` | Full details for one tool, including the **actual tool list** a remote server exposes (from our live check) and a ready-to-paste connect/install line. |
| `list_categories()` | All categories with tool counts. |

Example prompt: *"I want to post a Slack message whenever a Jira issue is closed. Find tools for each step with KitScout."*

## Privacy

We keep an anonymous log of calls (time to the minute, country code, client app name, search keywords and the result names returned) to learn which tools agents need. No IP addresses, accounts, headers or file contents. Full policy: https://kitscout.dev/privacy

## Source

`worker.js` is the Cloudflare Worker that serves the endpoint; it reads the static search index published on kitscout.dev. `schema.sql` is the D1 table for the anonymous log. Issues and listing fixes: open an issue or email contact@kitscout.dev.

License: MIT
