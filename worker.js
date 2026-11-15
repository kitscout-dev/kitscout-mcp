// KitScout MCP server (Cloudflare Worker, stateless Streamable HTTP, JSON responses).
// Reads the static search index that build_site.py publishes on kitscout.dev (s/p/<2ch>.json, s/m<n>.json, s/tl<n>.json, s/cats.json).
// Deploy: cd products/exp005-kitscout/mcp && npx wrangler deploy   (run wrangler login from ~, not the repo: .env token is Pages-only)
const SITE = "https://kitscout.dev/";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CH = 500;
const KIND = { 0: "skill", 1: "mcp", 2: "plugin" };
const TAG = { v: "first_party", o: "verified_publisher", l: "live", f: "free_to_try" };
const INSTRUCTIONS = `KitScout indexes ~84,000 AI agent tools: MCP servers (official MCP Registry), Agent Skills (GitHub SKILL.md) and Claude Code plugins, with GitHub stars, categories and a daily live check of every remote MCP server (live = answers; free_to_try = a read-only call worked with no API key).
To plan an automation: split the user's workflow into steps, call search_tools once per step with short product/action keywords (e.g. "jira create issue", "slack post message", "google sheets"), prefer first_party, live and well-starred tools, then call get_tool on finalists for install lines and the actual tool list. If you already have candidates (from web search, a README or the user), call check_tools on them first: it verifies maker, maintenance, adoption and live status and suggests better alternatives. Name the tools you chose per step and why. Stars for Agent Skills are their repo's stars.`;

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
  const p = fetch(SITE + key, { cf: { cacheTtl: 86400, cacheEverything: true } }).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(v => { if (v === null) cache.delete(key); return v; });  // never cache a failure (subrequest limit, network) — retry next call
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

// ranking v3 (2026-11-15, mirrored in eval/search_eval.py — change both): IDF-weighted word coverage, name weight 3 vs description 1,
// quality prior; category intent (s/ci.json): a multi-word task query that points at one category ranks that category's best tools
// (s/cl.json) by quality; product words (brand or mostly used in tool names) must still match; brand boost (s/b.json).
async function intentMembers(T, sc) {
  const [CI, CL, B] = await Promise.all([jget("s/ci.json"), jget("s/cl.json"), jget("s/b.json")]);
  if (!CI || !CL || T.length < 2) return { mem: new Set(), req: new Set() };
  const req = new Set(T.filter(([t, o]) => (B && (B[t] || B[o])) || ((CI.t[t] || CI.t[o] || [0, 0, 0])[2] >= 0.4)).map(([t]) => t));
  const by = new Map(); let tot = 0;
  for (const [t, o] of T) {
    const e = CI.t[t] || CI.t[o]; if (!e) continue;
    const idf = Math.log(CI.n / (e[0] + 1)); tot += idf;
    for (const [l2, p] of e[1]) by.set(l2, (by.get(l2) || 0) + p * idf);
  }
  if (!by.size) return { mem: new Set(), req };
  const [l2, v] = [...by].sort((a, b) => b[1] - a[1])[0];
  if (v / tot < 0.25) return { mem: new Set(), req };
  const mem = new Set();
  for (const c of CL[String(l2)] || []) {
    const i = c >>> 11; mem.add(i);
    if (!sc.has(i) && !req.size) sc.set(i, { n: 0, w: 0, c, t: new Set(), inj: true });
  }
  return { mem, req };
}

async function rank(q) {
  const T = await qterms(q);
  if (!T.length) return [];
  const sc = new Map(), idf = new Map(), N = 90000;
  const shards = await Promise.all(T.map(([t]) => jget("s/p/" + t.slice(0, 2) + ".json")));
  T.forEach(([t, o], n) => {
    const sh = shards[n]; if (!sh) return;
    idf.set(t, Math.log(N / (((sh[t] || sh[o] || []).length) + 1)));
    const best = new Map();
    for (const [k, codes] of Object.entries(sh)) {
      const ex = k === t || k === o; if (!ex && !(t.length >= 4 && k.startsWith(t))) continue;
      for (const c of codes) { const w = ((c >> 9) & 3) * (ex ? 1 : 0.85), i = c >>> 11; if ((best.get(i) || [0])[0] < w) best.set(i, [w, c]); }
    }
    for (const [i, [w, c]] of best) { const x = sc.get(i) || { n: 0, w: 0, c, t: new Set() }; x.n++; x.w += w; x.t.add(t); sc.set(i, x); }
  });
  const { mem, req } = await intentMembers(T, sc);
  const tot = [...idf.values()].reduce((a, b) => a + b, 0) || 1, L = T.length;
  let R = [...sc].map(([i, o]) => {
    const b = (o.c >> 5) & 15, cov = [...o.t].reduce((a, t) => a + (idf.get(t) || 0), 0) / tot;
    let s = 10 * L * cov + o.w + b * 0.3;
    if (mem.has(i)) s = 10 * L * (0.6 + 0.4 * cov) * (o.inj ? 0.85 : 1) + Math.min(o.w, L) + 1.2 * b + 3;
    else if (mem.size) s *= 0.9;
    return { i, c: o.c, s, cov, m: mem.has(i), t: o.t };
  });
  const full = R.filter(r => r.cov >= 0.75 || (r.m && [...req].every(t => r.t.has(t)))); if (full.length) R = full;
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
  else if (out.repo) out.how_to_install = `Not in the MCP Registry: follow the install steps in the README at ${out.repo}.`;
  return out;
}
const slugName = s => s.toLowerCase().replace(/^.*\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "server";

async function listCategories() {
  const cats = await jget("s/cats.json");
  return Object.entries(cats || {}).map(([id, [name, group, count]]) => ({ id, name, group, count }));
}


// ---- check_tools: verify candidates an agent found elsewhere (web search, README, a colleague) before installing them ----
let ENV = {};
async function md5hex(s) { const b = await crypto.subtle.digest("MD5", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function keyOf(raw) {
  let s = String(raw || "").trim();
  const gh = s.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?]|$)/i); if (gh) return { key: gh[1].toLowerCase(), repo: gh[1] };
  if (/^https?:\/\//i.test(s)) return { key: s.replace(/^https?:\/\//i, "").split("?")[0].replace(/\/+$/, "").toLowerCase(), url: s };
  s = s.replace(/^(npx|uvx|pipx|pip install|npm i|npm install)\s+(-y\s+)?/i, "").replace(/^(npm|pypi|oci|nuget|cargo):/i, "").trim();
  if (/^@?[\w.-]+\/[\w.-]+$/.test(s) && !s.startsWith("@")) return { key: s.toLowerCase(), repo: s, pkg: s.toLowerCase() };
  if (/^@[\w.-]+\/[\w.-]+/.test(s) || /^[\w.-]+$/.test(s)) return { key: s.replace(/(?<=.)@[^/@]*$/, "").toLowerCase(), alt: s.toLowerCase().replace(/[^a-z0-9]+/g, "") };
  return { key: s.toLowerCase().replace(/[^a-z0-9]+/g, "") };
}
async function lookup(k) { const sh = await jget(`s/k/${(await md5hex(k)).slice(0, 2)}.json`); return (sh && sh[k]) || []; }
async function extra(i) { const e = await jget(`s/e${Math.floor(i / CH)}.json`); return (e && e[i % CH]) || []; }
async function probe(url) {  // live MCP initialize right now (5 s)
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kitscout-check", version: "1" } } }) });
    return r.ok ? "answers" : (r.status === 401 || r.status === 403) ? "answers, sign-in or key required" : `HTTP ${r.status}`;
  } catch (e) { return "no answer (timeout or connection error)"; }
}
async function ghRepo(repo) {
  const h = { "User-Agent": "KitScout-check", Accept: "application/vnd.github+json" }; if (ENV.GITHUB_TOKEN) h.Authorization = "Bearer " + ENV.GITHUB_TOKEN;
  const r = await fetch("https://api.github.com/repos/" + repo, { headers: h, cf: { cacheTtl: 3600 } }).catch(() => null);
  if (!r) return null; if (r.status === 404) return { missing: true };
  if (!r.ok) return null; return r.json();
}
const days = d => d ? Math.round((Date.now() - Date.parse(d)) / 864e5) : null;

const GENERIC = new Set(["mcp", "server", "servers", "model", "context", "protocol", "tool", "tools", "agent", "agents", "ai", "llm", "claude", "for", "and", "with", "the", "your", "a", "an", "to", "of", "in", "via", "using", "official", "simple", "powerful", "lets", "allows", "enables", "integration", "api"]);
async function alternativesFor(name, desc, kindCode, myBits, selfIdx, cats, onlyOfficial) {
  // same job = search with the candidate's own name + description words; better = same kind, clearly higher quality prior
  const clean = t => [...new Set((String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 2 && !GENERIC.has(w)))];
  let words = clean(String(name).replace(/^.*\//, ""));  // the tool's own name says what it is for ('google-sheets-mcp')
  words = [...new Set([...words, ...clean(desc).slice(0, 2)])].slice(0, 4);  // name + what the description says it does
  const q = words.slice(0, 4).join(" ");
  if (!q) return [];
  const B = (await jget("s/b.json")) || {};
  const RR = await rank(q), inR = new Set(RR.slice(0, 200).map(r => r.i));
  const official = [...new Set(words.flatMap(w => B[st(w)] || []))].filter(j => j !== selfIdx && inR.has(j)).slice(0, 2);  // the maker's own tool first (must fit the job)
  const R = RR.filter(r => r.i !== selfIdx && !official.includes(r.i) && ((r.c >> 3) & 3) === kindCode && ((r.c >> 5) & 15) >= myBits + 2).slice(0, 3 - official.length);
  const metas = await Promise.all([...official, ...R.map(r => r.i)].map(meta));
  return metas.map((m, n) => m && { ...shape(m, cats), why: n < official.length ? "official: made by the product's maker" : "same job, more adopted / better maintained" })
    .filter(Boolean).filter(x => onlyOfficial ? x.why.startsWith("official") : true)
    .map(x => ({ name: x.name, why: x.why, badges: x.badges, stars: x.stars ?? x.repo_stars, install: x.install, page: x.page }));
}

async function checkOne(raw, cats, arch) {
  const k = keyOf(raw);
  let hits = await lookup(k.key); if (!hits.length && k.alt) hits = await lookup(k.alt);
  const res = { input: raw, in_kitscout: hits.length > 0 };
  const reasons = [], facts = {};
  let a = null, i = null;
  if (hits.length) {
    const ms = await Promise.all(hits.slice(0, 5).map(meta));
    let k2 = 0;
    if (k.repo) {  // a repo URL means the code: prefer an MCP-server entry, then anything not hosted by a third-party proxy
      const pick = ms.findIndex(m => m && m[7].endsWith("m") && !String(m[4]).startsWith("https://")), local = ms.findIndex(m => m && !String(m[4]).startsWith("https://"));
      k2 = pick >= 0 ? pick : local >= 0 ? local : 0;
    }  // a repo URL means the code, not a third-party hosted proxy of it
    i = hits[k2]; a = ms[k2];
  }
  if (a) {
    const sh = shape(a, cats), [pushed, license, lstate, lat] = await extra(i);
    Object.assign(res, { name: a[0], page: sh.page });
    Object.assign(facts, { type: sh.type, category: sh.category, stars: sh.stars ?? sh.repo_stars, first_party: a[7].includes("v"), verified_publisher: a[7].includes("o"),
      last_push_days: days(pushed), license: license || null, runs: sh.runs, install: sh.install, repo: sh.repo });
    if (lstate) facts.daily_check = `${lstate} (${lat})`;
    if (sh.install && sh.install.startsWith("https://")) facts.live_now = await probe(sh.install);
  }
  const repo = k.repo || (a && a[6]) || null;
  if (repo && (!a || facts.last_push_days == null)) {
    const g = await ghRepo(repo);
    if (g && g.missing) { reasons.push("GitHub repo not found (deleted, private or renamed)"); res.verdict = "avoid"; }
    else if (g) {
      Object.assign(facts, { stars: facts.stars ?? g.stargazers_count, last_push_days: days(g.pushed_at), license: facts.license || (g.license && g.license.spdx_id) || null, archived: g.archived, repo: facts.repo || g.html_url });
      if (g.full_name && g.full_name.toLowerCase() !== repo.toLowerCase()) {  // renamed repo: same project, look it up under the new name
        facts.moved_to = g.full_name;
        if (!a) { const h2 = await lookup(g.full_name.toLowerCase()); if (h2.length) { i = h2[0]; a = await meta(i); res.in_kitscout = true; } }
      }
      if (!a) { res.name = g.full_name; facts.description = g.description; }
    }
  }
  if (a && !res.name) {  // found via the renamed repo
    const sh = shape(a, cats);
    Object.assign(res, { name: a[0], page: sh.page });
    Object.assign(facts, { type: sh.type, category: sh.category, first_party: a[7].includes("v"), verified_publisher: a[7].includes("o"), runs: sh.runs, install: sh.install });
  }
  if (!a && k.url) facts.live_now = await probe(k.url);
  if (repo && arch && arch.includes(repo.toLowerCase())) facts.archived = true;
  // verdict
  if (facts.archived) reasons.push("repository is archived (no longer maintained)");
  if (facts.live_now && facts.live_now.startsWith("no answer")) reasons.push("remote server did not answer just now");
  if (facts.live_now && facts.live_now.startsWith("HTTP")) reasons.push("remote server returned " + facts.live_now);
  if (facts.last_push_days > 365) reasons.push(`no code changes for ${facts.last_push_days} days`);
  else if (facts.last_push_days > 180) reasons.push(`slow maintenance: last change ${facts.last_push_days} days ago`);
  if ((facts.stars ?? 0) < 10 && !facts.first_party) reasons.push(`little adoption (${facts.stars ?? 0} GitHub stars) and not made by the product's maker`);
  if (!a && !repo && !k.url) reasons.push("not found in KitScout (88k tools) — check the exact name, repo URL or package id");
  if (!res.verdict) res.verdict = (facts.archived || (facts.live_now || "").startsWith("no answer") || (facts.live_now || "").startsWith("HTTP 5") || facts.last_push_days > 365) ? "avoid" : reasons.length ? "caution" : "ok";
  if (res.verdict === "ok" && facts.first_party) reasons.push("made by the product's own company");
  res.reasons = reasons; res.facts = facts;
  if (res.verdict !== "ok" || !facts.first_party) {
    const bits = a ? await (async () => { for (const [t] of [[String(a[0]).toLowerCase()]]) { const r = (await rank(t)).find(x => x.i === i); if (r) return (r.c >> 5) & 15; } return Math.min(15, Math.floor(Math.log10((facts.stars || 0) + 1) * 2)); })() : Math.min(15, Math.floor(Math.log10((facts.stars || 0) + 1) * 2));
    const kindCode = a ? ({ s: 0, m: 1, p: 2 }[a[7].slice(-1)] ?? 1) : 1;
    // ok + not first-party: only point to the maker's own tool; caution/avoid: also more adopted tools for the same job
    const alts = await alternativesFor(res.name || raw, a ? a[5] : facts.description, kindCode, bits, i, cats, res.verdict === "ok");
    if (alts.length) res.alternatives = alts;
  }
  return res;
}

async function checkTools(args) {
  const list = (Array.isArray(args.tools) ? args.tools : [args.tools]).filter(Boolean).slice(0, 5);  // Workers free plan: 50 subrequests per call
  if (!list.length) return { error: "Pass tools: a list of repo URLs, package ids (npm/pypi), remote MCP URLs or names." };
  const [cats, arch] = await Promise.all([jget("s/cats.json"), jget("s/arch.json")]);
  return { checked: await Promise.all(list.map(x => checkOne(x, cats, arch))), note: "verdict: ok / caution / avoid. live_now = we called the remote server during this check." };
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
    name: "check_tools",
    description: "Before installing tools you found elsewhere (web search, a README, a blog), verify them: is it the product maker's own tool, maintained (last code change, archived?), adopted (stars), does the remote server answer right now, where does your data go — with a verdict (ok / caution / avoid) and better alternatives. Pass up to 5 GitHub URLs, package ids (npm/pypi), remote MCP URLs or names per call.",
    inputSchema: { type: "object", required: ["tools"], properties: { tools: { type: "array", items: { type: "string" }, maxItems: 5, description: "e.g. https://github.com/owner/repo, @scope/package, https://mcp.example.com/mcp" } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
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
  const q = String(a.query || a.name || (Array.isArray(a.tools) ? a.tools.join(" | ") : a.tools) || "").slice(0, 500);
  const filters = ["type", "only_official", "only_live", "only_free_to_try", "limit"].filter(k => a[k] !== undefined).map(k => k + "=" + a[k]).join(",");
  const res = data && data.results ? data.results.map(r => r.name).slice(0, 10) : data && data.checked ? data.checked.map(c => `${c.name || c.input}:${c.verdict}`) : data && data.name ? [data.name] : [];
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
    const fn = { search_tools: searchTools, get_tool: getTool, check_tools: checkTools, list_categories: listCategories }[params.name];
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
    ENV = env || {};
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
