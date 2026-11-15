// KitScout MCP server (Cloudflare Worker, stateless Streamable HTTP, JSON responses).
// Reads the static search index that build_site.py publishes on kitscout.dev (s/p/<2ch>.json, s/m<n>.json, s/tl<n>.json, s/cats.json).
// Deploy: cd products/exp005-kitscout/mcp && npx wrangler deploy   (run wrangler login from ~, not the repo: .env token is Pages-only)
const SITE = "https://kitscout.dev/";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CH = 500;
const KIND = { 0: "skill", 1: "mcp", 2: "plugin" };
const TAG = { v: "first_party", o: "verified_publisher", l: "live", f: "free_to_try" };
const INSTRUCTIONS = `KitScout indexes ~84,000 AI agent tools: MCP servers (official MCP Registry), Agent Skills (GitHub SKILL.md) and Claude Code plugins, with GitHub stars, categories and a daily live check of every remote MCP server (live = answers; free_to_try = a read-only call worked with no API key).
To plan an automation: split the user's workflow into steps, call search_tools once per step with short product/action keywords (e.g. "jira create issue", "slack post message", "google sheets"), prefer first_party, live and well-starred tools, then call get_tool on finalists for install lines and the actual tool list. Name the tools you chose per step and why. Stars for Agent Skills are their repo's stars.`;

// every index file is fetched with ?v=<build id> so a daily rebuild never mixes old shards with new meta (indices shift between builds)
let VER = { v: "", at: 0 };
async function ver() {
  if (Date.now() - VER.at > 60000) {
    const v = await fetch(SITE + "s/v.json", { cf: { cacheTtl: 60 } }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    if (v.v && v.v !== VER.v) cache.clear();
    VER = { v: v.v || VER.v, at: Date.now() };
  }
  return VER.v;
}
const cache = new Map();
async function jget(path) {
  const key = path + "?v=" + (await ver());
  if (cache.has(key)) return cache.get(key);
  const p = fetch(SITE + key, { cf: { cacheTtl: 86400, cacheEverything: true } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  cache.set(key, p);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}

let SW = null;
const st = w => { for (const x of ["ing", "ers", "er", "ed", "es", "s", "e"]) if (w.length - x.length >= 4 && w.endsWith(x)) return w.slice(0, -x.length); return w.slice(0, 20); };
async function qterms(q) {
  SW = SW || new Set((await jget("s/stop.json")) || []);
  const out = new Map();  // stem -> original word (an exact hit on either counts as exact)
  for (const w of String(q).toLowerCase().match(/[a-z0-9]+/g) || []) if (w.length >= 2 && !SW.has(w)) out.set(st(w), w.slice(0, 20));
  return [...out];
}

// same ranking as the site: AND-first, exact token 1.0 / prefix 0.85, name weight 3 vs description 1, plus quality prior
async function rank(q) {
  const T = await qterms(q);
  if (!T.length) return [];
  const sc = new Map();
  const shards = await Promise.all(T.map(([t]) => jget("s/p/" + t.slice(0, 2) + ".json")));
  T.forEach(([t, o], n) => {
    const sh = shards[n]; if (!sh) return;
    const best = new Map();
    for (const [k, codes] of Object.entries(sh)) {
      const ex = k === t || k === o; if (!ex && !(t.length >= 4 && k.startsWith(t))) continue;
      for (const c of codes) { const w = ((c >> 9) & 3) * (ex ? 1 : 0.85), i = c >>> 11; if ((best.get(i) || [0])[0] < w) best.set(i, [w, c]); }
    }
    for (const [i, [w, c]] of best) { const o = sc.get(i) || { n: 0, w: 0, c }; o.n++; o.w += w; sc.set(i, o); }
  });
  let R = [...sc].map(([i, o]) => ({ i, c: o.c, n: o.n, s: o.n * 10 + o.w + ((o.c >> 5) & 15) * 0.3 }));
  const full = R.filter(r => r.n === T.length); if (full.length) R = full;
  // vendor boost: the maker's own tool first when the query names the brand (s/b.json from build_site.py vendor_brand)
  const B = (await jget("s/b.json")) || {}, vb = new Set(T.flatMap(([t, o]) => [...(B[t] || []), ...(B[o] || [])]));
  for (const r of R) if (vb.has(r.i)) r.s += 8;
  return R.sort((a, b) => b.s - a.s);
}

async function meta(i) { const m = await jget(`s/m${Math.floor(i / CH)}.json`); return m && m[i % CH]; }
function shape(a, cats) {
  const [name, link, l2, stars, install, desc, repo, tags] = a;
  return {
    name, type: { p: "plugin", s: "skill", m: "mcp" }[tags.slice(-1)] || "mcp",
    category: (cats && cats[l2] && cats[l2][0]) || l2,
    ...(tags.endsWith("s") ? { repo_stars: stars, stars_note: "GitHub stars of the whole repo this skill lives in, not of the skill itself" } : { stars }),
    runs: install.startsWith("https://") ? `remote: your requests and data go to ${install.split("/")[2]}` : tags.endsWith("s") ? "local: runs inside your agent" : install ? "local: runs on your machine" : "unknown",
    badges: [...tags].map(g => TAG[g]).filter(Boolean),
    install: install || null, description: desc,
    page: link.startsWith("http") ? link : SITE + link.replace(/\.html(\?|$)/, "$1"), repo: repo ? "https://github.com/" + repo : null,
  };
}

async function searchTools(args) {
  const q = String(args.query || "").slice(0, 200), lim = Math.min(Math.max(+args.limit || 10, 1), 25);
  const want = { mcp: 1, skill: 0, plugin: 2 }[args.type];
  const bits = (args.only_verified || args.only_official ? 4 : 0) | (args.only_live ? 2 : 0) | (args.only_free_to_try ? 1 : 0);
  const R = (await rank(q)).filter(r => (want === undefined || ((r.c >> 3) & 3) === want) && (r.c & bits) === bits);
  // at most 2 results per source repo (one 300-skill pack must not fill the list)
  const [cats, ...rows] = await Promise.all([jget("s/cats.json"), ...R.slice(0, lim * 3).map(r => meta(r.i))]);
  const per = new Map(), out = [];
  for (const a of rows) {
    if (!a || out.length >= lim) continue;
    const k = a[6] || a[0]; per.set(k, (per.get(k) || 0) + 1);
    if (per.get(k) <= 2) out.push(a);
  }
  return { query: q, total_matches: R.length, results: out.map(a => shape(a, cats)) };
}

async function getTool(args) {
  const name = String(args.name || "").trim();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const R = (await rank(name)).slice(0, 40);
  const metas = await Promise.all(R.map(r => meta(r.i)));
  let k = metas.findIndex(a => a && norm(a[0]) === norm(name));
  if (k < 0) k = metas.findIndex(a => a && norm(a[0]).endsWith(norm(name)));
  if (k < 0) return { error: `No tool named "${name}". Use search_tools first and pass an exact name from its results.`, close_matches: metas.filter(Boolean).slice(0, 5).map(a => a[0]) };
  const i = R[k].i, a = metas[k];
  const [cats, tl] = await Promise.all([jget("s/cats.json"), jget(`s/tl${Math.floor(i / CH)}.json`)]);
  const out = shape(a, cats);
  const tools = tl && tl[String(i % CH)];
  if (tools) out.tools = tools.map(([n, d]) => ({ name: n, description: d }));
  const ins = a[4] || "";
  if (ins.startsWith("https://")) out.how_to_connect = {
    claude_code: `claude mcp add --transport http ${slugName(a[0])} ${ins}`,
    claude_app: `Settings > Connectors > Add custom connector > ${ins}`,
  };
  else if (out.type === "skill" && out.repo) out.how_to_install = `Copy the skill folder (with SKILL.md) from ${out.repo} into ~/.claude/skills/ (or .claude/skills/ in a project).`;
  else if (ins) out.how_to_install = ins;
  return out;
}
const slugName = s => s.toLowerCase().replace(/^.*\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "server";

async function listCategories() {
  const cats = await jget("s/cats.json");
  return Object.entries(cats || {}).map(([id, [name, group, count]]) => ({ id, name, group, count }));
}

const TOOLS = [
  {
    name: "search_tools",
    description: "Search ~84k AI agent tools (MCP servers, Agent Skills, Claude Code plugins) by keywords. Returns ranked matches with type, category, GitHub stars, badges (first_party = made by the product's own maker, verified_publisher, live, free_to_try), install line and KitScout page. Use short keywords: product + action, e.g. 'postgres', 'slack post message', 'pdf extract tables'.",
    inputSchema: {
      type: "object", required: ["query"], properties: {
        query: { type: "string", description: "Keywords (product names and actions work best)" },
        type: { type: "string", enum: ["mcp", "skill", "plugin"], description: "Only this kind of tool" },
        only_verified: { type: "boolean", description: "Only verified publishers (domain-verified registry namespace, Anthropic marketplace). Does not mean made by the product's vendor; see the first_party badge" },
        only_official: { type: "boolean", description: "Deprecated alias of only_verified" },
        only_live: { type: "boolean", description: "Only remote MCP servers that answered our latest daily check" },
        only_free_to_try: { type: "boolean", description: "Only remote MCP servers that worked without an API key" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Max results (default 10)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_tool",
    description: "Details for one tool by its exact name from search_tools: description, badges, stars, repo, install or connect instructions, and for remote MCP servers the actual tool list the server exposes (from our live check).",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "Exact tool name as returned by search_tools" } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_categories",
    description: "All KitScout categories (id, name, group, tool count). Useful to see what kinds of tools exist before searching.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// Anonymous demand log (policy: https://kitscout.dev/privacy). Stored in D1 `kitscout-log`: time, country, client product name,
// tool called, its arguments (search keywords / tool name), result count + top result names. Never IPs, accounts, headers or session ids.
const clientOf = (req, params) => {
  const ci = params && params.clientInfo;
  if (ci && ci.name) return String(ci.name).slice(0, 40) + (ci.version ? "/" + String(ci.version).slice(0, 15) : "");
  const ua = req.headers.get("user-agent") || "";
  return (ua.match(/^[A-Za-z][\w.-]{0,39}(\/[\w.-]{0,15})?/) || [""])[0];  // product token only, e.g. "claude-code/2.1.0"
};
function logRow(env, ctx, req, method, params, data) {
  if (!env || !env.LOG) return;
  const a = (params && params.arguments) || {};
  const tool = method === "tools/call" ? String(params.name || "").slice(0, 40) : method;
  const q = String(a.query || a.name || "").slice(0, 200);
  const filters = ["type", "only_official", "only_live", "only_free_to_try", "limit"].filter(k => a[k] !== undefined).map(k => k + "=" + a[k]).join(",");
  const res = data && data.results ? data.results.map(r => r.name).slice(0, 10) : data && data.name ? [data.name] : [];
  const n = data && (data.total_matches ?? (data.error ? 0 : data.name ? 1 : null));
  ctx.waitUntil(env.LOG.prepare("INSERT INTO q (ts, country, client, tool, query, filters, n, results) VALUES (?,?,?,?,?,?,?,?)")
    .bind(new Date().toISOString().slice(0, 16), (req.cf && req.cf.country) || "", clientOf(req, params), tool, q, filters, n ?? null, JSON.stringify(res))
    .run().catch(() => {}));
}

async function handle(msg, req, env, ctx) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1];
    logRow(env, ctx, req, method, params, null);
    return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kitscout", title: "KitScout", version: "1.0.0", websiteUrl: SITE }, instructions: INSTRUCTIONS });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "tools/call") {
    const fn = { search_tools: searchTools, get_tool: getTool, list_categories: listCategories }[params.name];
    if (!fn) return err(-32602, "Unknown tool: " + params.name);
    try {
      const data = await fn(params.arguments || {});
      logRow(env, ctx, req, method, params, Array.isArray(data) ? null : data);
      return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: Array.isArray(data) ? { categories: data } : data, isError: !!data.error });
    } catch (e) {
      return ok({ content: [{ type: "text", text: "KitScout error: " + String(e).slice(0, 200) }], isError: true });
    }
  }
  return err(-32601, "Method not found: " + method);
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "Mcp-Session-Id" };
const LANDING = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KitScout MCP</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#17332D;background:#EEF1EF}code{background:#fff;padding:2px 6px;border-radius:4px;word-break:break-all}</style>
<h1>KitScout MCP server</h1><p>Lets your AI agent search ~84,000 MCP servers, Agent Skills and Claude Code plugins on <a href="${SITE}">kitscout.dev</a>, with live checks and install lines. Free, read-only, no key.</p>
<p><b>Claude Code:</b> <code>claude mcp add --transport http kitscout https://mcp.kitscout.dev/mcp</code></p>
<p><b>Claude app:</b> Settings → Connectors → Add custom connector → <code>https://mcp.kitscout.dev/mcp</code></p>
<p>Tools: search_tools, get_tool, list_categories. Contact: contact@kitscout.dev</p>
<p>Privacy: we keep an anonymous log of searches (keywords, results, country, client app name) to learn which tools agents need. No IPs, accounts or file contents. <a href="${SITE}privacy">Data policy</a></p>`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname !== "/mcp") return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (req.method === "GET") return new Response("Use POST (Streamable HTTP, JSON responses).", { status: 405, headers: { Allow: "POST", ...CORS } });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: CORS });
    let body;
    try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS }); }
    const msgs = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(msgs.filter(m => m && m.id !== undefined && m.method).map(m => handle(m, req, env, ctx))));
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return Response.json(Array.isArray(body) ? out : out[0], { headers: CORS });
  },
};
