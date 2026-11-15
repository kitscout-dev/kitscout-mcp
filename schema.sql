-- D1 kitscout-log: anonymous demand log of the KitScout MCP server (policy: https://kitscout.dev/privacy)
-- apply: cd products/exp005-kitscout/mcp && npx wrangler d1 execute kitscout-log --remote --file schema.sql
CREATE TABLE IF NOT EXISTS q (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,        -- UTC minute, e.g. 2026-11-15T01:47
  country TEXT,            -- Cloudflare country code only
  client TEXT,             -- MCP clientInfo name/version or User-Agent product token
  tool TEXT NOT NULL,      -- initialize | search_tools | get_tool | list_categories
  query TEXT,              -- search keywords or requested tool name
  filters TEXT,            -- e.g. type=mcp,only_live=true
  n INTEGER,               -- total matches (search) / 1|0 (get_tool)
  results TEXT             -- JSON array: top result names shown (max 10)
);
CREATE INDEX IF NOT EXISTS q_ts ON q (ts);
CREATE INDEX IF NOT EXISTS q_tool ON q (tool, ts);
