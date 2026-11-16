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
  results TEXT,            -- JSON array: top result names shown (max 10)
  kid TEXT                 -- key id (first 12 hex of sha256(key)) when the call used a free key, else NULL
);
CREATE INDEX IF NOT EXISTS q_ts ON q (ts);
CREATE INDEX IF NOT EXISTS q_tool ON q (tool, ts);

-- Free keys (kitscout.dev/watch). The key itself is never stored.
CREATE TABLE IF NOT EXISTS subs (
  kid TEXT PRIMARY KEY,         -- first 12 hex of sha256(key)
  khash TEXT NOT NULL UNIQUE,   -- sha256 hex of the key
  email TEXT NOT NULL,          -- for watch alerts only; deletion on request (contact@kitscout.dev)
  ts TEXT NOT NULL,             -- UTC minute
  source TEXT,                  -- page/channel the signup came from
  pro INTEGER DEFAULT 0,        -- 1 = ticked 'I would pay for Pro' (demand signal, no charge)
  country TEXT,
  status TEXT DEFAULT 'active'  -- active | deleted
);
CREATE INDEX IF NOT EXISTS subs_email ON subs (email);
CREATE TABLE IF NOT EXISTS watch (
  kid TEXT NOT NULL,
  tool TEXT NOT NULL,           -- name or URL as checked/entered
  verdict TEXT,                 -- last check_tools verdict ok|caution|avoid
  added TEXT, checked TEXT,
  PRIMARY KEY (kid, tool)
);

-- Opt-in crowd health from the KitScout plugin: did a tool start on a user's machine (one row per tool per report). No user/machine ids.
CREATE TABLE IF NOT EXISTS health (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,      -- UTC date
  tool TEXT NOT NULL,     -- public id: npm:pkg, pypi:pkg, server URL without query, plugin name
  status TEXT NOT NULL,   -- ok | fail | auth
  client TEXT,            -- e.g. kitscout-plugin/1.1.0
  country TEXT
);
CREATE INDEX IF NOT EXISTS health_tool ON health (tool, day);
