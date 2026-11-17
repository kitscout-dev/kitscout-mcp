// KitScout MCP server (Cloudflare Worker, stateless Streamable HTTP, JSON responses).
// Reads the static search index that build_site.py publishes on kitscout.dev (s/p/<2ch>.json, s/m<n>.json, s/tl<n>.json, s/cats.json).
// Deploy: cd products/exp005-kitscout/mcp && npx wrangler deploy   (run wrangler login from ~, not the repo: .env token is Pages-only)
const SITE = "https://kitscout.dev/";
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CH = 500;
const KIND = { 0: "skill", 1: "mcp", 2: "plugin" };
const TAG = { v: "first_party", o: "verified_publisher", l: "live", f: "free_to_try" };
const INSTRUCTIONS = `KitScout indexes ~88,000 AI agent tools: MCP servers (official MCP Registry and GitHub), Agent Skills (GitHub SKILL.md) and Claude Code plugins, with GitHub activity, publisher identity and a daily live check of every remote MCP server (live = answers, some need sign-in; free_to_try = a read-only call worked with no API key).
Tools: search_tools finds tools by product or task keywords; get_tool returns details, install or connect lines and a remote server's tool list; check_tools verifies tools the user already has in mind (maker, maintenance, adoption, live status, alternatives); list_categories lists categories. first_party = made by the product's own maker; verified_publisher = domain-verified publisher. Stars for Agent Skills are their repo's stars.`;

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

// constraint phrases are not search words: 'web search no api key' -> search 'web search', prefer tools that worked without a key
const FREE_RE = /\b(?:no|without|zero)\s+(?:an?\s+)?(?:api\s+)?(?:keys?|sign[- ]?ups?|auth|accounts?|registration)\b|\bkeyless\b|\bfree\b|\bno[- ]key\b/g;
async function rank(q0) {
  const q = String(q0).toLowerCase().replace(FREE_RE, " "), prefFree = q !== String(q0).toLowerCase();
  let T = await qterms(q);
  if (!T.length && prefFree) T = await qterms(q0);  // query was only a constraint ('free')
  if (!T.length) return [];
  const sc = new Map(), idf = new Map(), N = 90000;
  const shards = await Promise.all(T.map(([t]) => jget("s/p/" + t.slice(0, 2) + ".json")));
  T.forEach(([t, o], n) => {
    const sh = shards[n]; if (!sh) return;
    idf.set(t, Math.log(N / (Math.max((sh[t] || []).length, (sh[o] || []).length) + 1)));  // stem and word: a 1-entry stem key ('youtub') must not make 'youtube' look rare
    const best = new Map();
    for (const [k, codes] of Object.entries(sh)) {
      const ex = k === t || k === o; if (!ex && !(t.length >= 4 && k.startsWith(t))) continue;
      for (const c of codes) { const w = ((c >> 9) & 3) * (ex ? 1 : 0.85), i = c >>> 11; if ((best.get(i) || [0])[0] < w) best.set(i, [w, c]); }
    }
    for (const [i, [w, c]] of best) { const x = sc.get(i) || { n: 0, w: 0, c, t: new Set(), nt: new Set() }; x.n++; x.w += w; x.t.add(t); if (w >= 2) x.nt.add(t); sc.set(i, x); }
  });
  const { mem, req } = await intentMembers(T, sc);
  const tot = [...idf.values()].reduce((a, b) => a + b, 0) || 1, L = T.length;
  let R = [...sc].map(([i, o]) => {
    const b = (o.c >> 5) & 15, cov = [...o.t].reduce((a, t) => a + (idf.get(t) || 0), 0) / tot;
    let s = 10 * L * cov + o.w + b * 0.3;
    if (mem.has(i)) s = 10 * L * (0.6 + 0.4 * cov) * (o.inj ? 0.85 : 1) + Math.min(o.w, L) + 1.2 * b + 3;
    else if (mem.size && cov >= 0.99) s = 10 * L + Math.min(o.w, L) + 1.2 * b + 3;  // every word matches but filed elsewhere (often misfiled): quality counts like a member
    else if (mem.size) s *= 0.9;
    return { i, c: o.c, s, cov, m: mem.has(i), t: o.t, nt: o.nt || new Set() };
  });
  // product words are required whenever any result has them ('slack post message' must not return Telegram/LINE; dogfood 2026-11-15)
  const [CI, B0, PW] = await Promise.all([jget("s/ci.json"), jget("s/b.json"), jget("s/pw.json")]), pw = new Set(PW || []);
  const need = T.filter(([t, o]) => (B0 && (B0[t] || B0[o])) || pw.has(t) || ((CI && (CI.t[t] || CI.t[o])) || [0, 0, 0])[2] >= 0.4).map(([t]) => t);
  if (need.length && T.length > need.length) { const bm = t => new Set((B0 && B0[t]) || []);  // the maker's own tools count even without the word in their name (jira -> Atlassian Rovo)
    // platform words must be in the NAME (a description that mentions Slack is not a Slack tool); other product words anywhere
    const R2 = R.filter(r => need.every(t => r.nt.has(t) || bm(t).has(r.i) || (!pw.has(t) && r.t.has(t)))); if (R2.length) R = R2; }
  // (after the product-word filter, else it cut the right tools first) near-full matches first; if fewer than 10, partial matches follow below them instead of vanishing (2026-11-17: 'windows desktop app automation UI' -> 2 results)
  const full = R.filter(r => r.cov >= 0.75 || (r.m && [...req].every(t => r.t.has(t))));
  if (full.length >= 10) R = full; else if (full.length) { const fs = new Set(full); for (const r of R) if (!fs.has(r)) r.s -= 1000; }
  const B = (await jget("s/b.json")) || {}, vb = new Set(T.flatMap(([t, o]) => [...(B[t] || []), ...(B[o] || [])]));
  // full +8 only for the maker's flagship tools; its minor tools (3-star CLI) get +1 so a popular community tool can stay above them ('jira')
  const bmax = Math.max(0, ...R.filter(r => vb.has(r.i)).map(r => (r.c >> 5) & 15));
  // 'html to pdf': a tool whose NAME has both ends of an 'A to B' query is a converter for it (+8; a global name boost was tested and hurt, round 6)
  const dm = q.match(/([a-z0-9]+)[\s_-]+(?:to|2|into)[\s_-]+([a-z0-9]+)/), dq = dm && dm[1] !== dm[2] ? [st(dm[1]), st(dm[2])] : null;
  for (const r of R) { if (vb.has(r.i)) { r.s += ((r.c >> 5) & 15) >= bmax - 4 ? 8 : 1; r.vb = true; } if (prefFree && (r.c & 1)) r.s += 2; if (dq && r.nt.has(dq[0]) && r.nt.has(dq[1])) r.s += 8; }  // c bit 0 = worked without an API key
  return R.sort((a, b) => b.s - a.s);
}

async function meta(i) { const m = await jget(`s/m${Math.floor(i / CH)}.json`); return m && m[i % CH]; }
function shape(a, cats) {
  const [name, link, l2, stars, install, desc, repo, tags] = a;
  return {
    name, type: { p: "plugin", s: "skill", m: "mcp" }[tags.slice(-1)] || "mcp",
    category: (cats && cats[l2] && cats[l2][0]) || l2,
    ...(tags.endsWith("s") ? { repo_stars: stars, stars_note: "GitHub stars of the whole repo this skill lives in, not of the skill itself" } : { stars }),
    runs: /[{}<>]/.test(install) ? "self-hosted: the URL is a template, fill in your own host" : install.startsWith("https://") ? `remote: your requests and data go to ${install.split("/")[2]}` : tags.endsWith("s") ? "local: runs inside your agent" : install ? "local: runs on your machine" : "unknown",
    badges: [...tags].map(g => TAG[g]).filter(Boolean),
    install: install || null, description: desc,
    page: link.startsWith("http") ? link : SITE + link.replace(/\.html(\?|$)/, "$1"), repo: repo ? "https://github.com/" + repo : null,
  };
}

// Non-English queries (2026-11-15: '카카오톡 메시지' returned nothing): translate to English with Workers AI, then search.
const SCRIPTS = [[/[\uac00-\ud7af]/, "korean"], [/[\u3040-\u30ff]/, "japanese"], [/[\u4e00-\u9fff]/, "chinese"], [/[\u0400-\u04ff]/, "russian"], [/[\u0600-\u06ff]/, "arabic"]];
async function toEnglish(q) {
  const lang = (SCRIPTS.find(([re]) => re.test(q)) || [])[1];
  if (!lang || !ENV.AI) return null;
  try {
    // small LLM, not m2m100: m2m100 turned 카카오톡 into 'Cacao'; brand names must come out in their official English form
    const r = await ENV.AI.run("@cf/meta/llama-3.2-3b-instruct", { max_tokens: 24, temperature: 0, messages: [
      { role: "system", content: "Translate the user's " + lang + " search for AI agent tools into ONE short English search query of 2-4 words: product name + action, like 'notion create page' or 'kakaotalk send message'. Write product and brand names in their official English spelling (카카오톡 -> kakaotalk, 노션 -> notion). No synonyms, no alternatives, no punctuation. Reply with the query only." },
      { role: "user", content: q }] });
    const t = String((r && r.response) || "").split("\n")[0].split(",")[0].replace(/["'.]/g, " ").replace(/^(keywords?|query):\s*/i, "").trim().split(/\s+/).slice(0, 5).join(" ");
    return t && /[a-z]/i.test(t) ? t.slice(0, 200) : null;
  } catch (e) { return null; }  // daily free allowance used up or model error: fall back to the original words
}

// Meaning-based re-ranking (2026-11-15): word search finds candidates, a cross-encoder (Workers AI bge-reranker-base, free daily
// allowance) orders them by what the query MEANS ('speech to text' != 'text to speech'). Brand-boosted official tools stay on top;
// single-word queries (product names) keep the word ranking. Any AI error -> word ranking unchanged.
async function rerank(q, pool, rows, w, qw) {
  const W = w === undefined ? 0.4 : +w, Q = qw === undefined ? 0.3 : +qw;  // meaning vs word-rank vs quality prior
  if (!ENV.AI || !W || q.trim().split(/\s+/).length < 2 || rows.length < 3) return rows;
  const idx = rows.map((a, i) => i).filter(i => rows[i] && !pool[i].vb);
  if (idx.length < 3) return rows;
  try {
    const r = await ENV.AI.run("@cf/baai/bge-reranker-base", { query: q, contexts: idx.map(i => ({ text: (rows[i][0] + ". " + (rows[i][5] || "")).slice(0, 400) })) });
    const sc = new Map((r.response || r || []).map(x => [x.id, x.score]));
    const vals = [...sc.values()], lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const n = idx.length, fin = idx.map((i, k) => ({ i, f: W * (((sc.get(k) ?? lo) - lo) / span) + Math.max(0, 1 - W - Q) * (1 - k / n) + Q * (((pool[i].c >> 5) & 15) / 15) }));
    fin.sort((a, b) => b.f - a.f);
    const pinned = rows.map((a, i) => i).filter(i => rows[i] && pool[i].vb);
    return [...pinned, ...fin.map(x => x.i)].map(i => rows[i]);
  } catch (e) { return rows; }
}

// 'text to speech' must not rank speech-to-text first (2026-11-17, real query log): for an 'A to B' query, tools whose name (or, if the
// name says neither, description) only says 'B to A' go to the bottom. Same in eval/search_eval.py and build_site.py.
function dirDemote(q, rows, txt) {
  const m = String(q).toLowerCase().match(/([a-z0-9]+)[\s_-]+(?:to|2|into)[\s_-]+([a-z0-9]+)/);
  if (!m || m[1] === m[2]) return rows;
  const norm = s => " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/ (?:into|2) /g, " to ") + " ";
  const f = ` ${m[1]} to ${m[2]} `, b = ` ${m[2]} to ${m[1]} `;
  // tier 0 = the name says 'A to B', 1 = neutral, 2 = only says 'B to A' (stable: rerank order kept inside each tier)
  const tier = a => { if (!a) return 1; const [n, d] = txt(a).map(norm); if (n.includes(f)) return 0; if (n.includes(b)) return 2; return d.includes(b) && !d.includes(f) ? 2 : 1; };
  return rows.map((a, k) => [tier(a), k, a]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(x => x[2]);
}

async function searchTools(args) {
  const q0 = String(args.query || "").slice(0, 200), lim = Math.min(Math.max(+args.limit || 10, 1), 25);
  const tr = await toEnglish(q0), q = tr || q0;
  const want = { mcp: 1, skill: 0, plugin: 2 }[args.type];
  const bits = (args.only_verified || args.only_official ? 4 : 0) | (args.only_live ? 2 : 0) | (args.only_free_to_try ? 1 : 0);
  const R = (await rank(q)).filter(r => (want === undefined || ((r.c >> 3) & 3) === want) && (r.c & bits) === bits);
  // at most 2 results per source repo (one 300-skill pack must not fill the list)
  const pool = R.slice(0, Math.max(lim * 3, 30));
  const [cats, ...rows0] = await Promise.all([jget("s/cats.json"), ...pool.map(r => meta(r.i))]);
  const rows = dirDemote(q, await rerank(q, pool, rows0, args._rr, args._q), a => [a[0], a[5]]);
  const per = new Map(), out = [], also = new Map(), nn = s => String(s).toLowerCase().replace(/^.*\//, "").replace(/[^a-z0-9]+/g, "");
  for (const a of rows) {
    if (!a || out.length >= lim) continue;
    // same repo + same name = one product shipped two ways (Slack remote server + Slack plugin): one row, the other install line as also_install
    // a long identical name (>= 20 chars) is one product listed under several repos/URLs (Printwren x3, 2026-11-17)
    const twin = out.find(b => nn(b[0]) === nn(a[0]) && ((a[6] && b[6] === a[6]) || nn(a[0]).length >= 20));
    if (twin) { if (a[4] && a[4] !== twin[4]) also.set(twin, a[4]); continue; }
    const k = a[6] || a[0]; per.set(k, (per.get(k) || 0) + 1);
    if (per.get(k) <= 2) out.push(a);
  }
  if (!R.length && /[^\x00-\x7f]/.test(q)) return { query: q0, total_matches: 0, results: [], hint: "No match. KitScout indexes English names and descriptions: retry with English keywords (product + action, e.g. 'kakaotalk message')." };
  return { query: q0, ...(tr ? { searched_as: tr } : {}), total_matches: R.length, results: out.map(a => Object.assign(shape(a, cats), also.has(a) ? { also_install: also.get(a) } : {})) };
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
  if (/^plugin:/i.test(s)) return { key: s.slice(7).trim().toLowerCase() };  // Claude Code plugin as installed: name@marketplace
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
  // a Worker fetching its own zone gets Cloudflare 523 -> checking KitScout itself must not say 'avoid' (dogfood 2026-11-15)
  if (/^https?:\/\/(mcp\.)?kitscout\.dev(\/|$)/i.test(url)) return "answers (KitScout itself; this check is running on it)";
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
  const nameWords = words.slice();
  words = [...new Set([...words, ...clean(desc || "").slice(0, 2)])].slice(0, 4);  // desc may be undefined (not in KitScout, no repo) -> was matching the word "undefined"  // name + what the description says it does
  const q = words.slice(0, 4).join(" ");
  if (!q) return [];
  const B = (await jget("s/b.json")) || {};
  const RR = await rank(q), inR = new Set(RR.slice(0, 200).map(r => r.i));
  const official = [...new Set(words.flatMap(w => B[st(w)] || []))].filter(j => j !== selfIdx && inR.has(j)).slice(0, 2);  // the maker's own tool first (must fit the job)
  const R = RR.filter(r => r.i !== selfIdx && !official.includes(r.i) && ((r.c >> 3) & 3) === kindCode && ((r.c >> 5) & 15) >= myBits + 2).slice(0, 3 - official.length);
  const metas = await Promise.all([...official, ...R.map(r => r.i)].map(meta));
  // 2026-11-15 workflow A/B: rank() alone returned off-topic 'alternatives' (job scraper -> kubb OpenAPI codegen). An alternative must
  // itself say it does the job: >= min(2, n) of the query words in its own name + description. No alternative beats a wrong one.
  // name words carry the job ('postgres', 'google sheets'); description words are often filler ('interacting') -> require a name word when we have one
  // candidate name without its registry namespace: 'io.github.tldraw/tldraw' is not a GitHub tool (2026-11-16 review: github -> tldraw)
  const fits = m => { const t = new Set(clean(String(m[0]).replace(/^.*\//, "") + " " + (m[5] || ""))); return nameWords.length ? nameWords.some(w => t.has(w)) : words.filter(w => t.has(w)).length >= Math.min(2, words.length); };
  return metas.map((m, n) => m && fits(m) && { ...shape(m, cats), why: n < official.length ? "official: made by the product's maker" : "same job, more adopted / better maintained" })
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
    if (sh.install && /[{}<>]/.test(sh.install)) facts.runs = "self-hosted: the URL is a template, fill in your own host";
    else if (sh.install && sh.install.startsWith("https://")) facts.live_now = await probe(sh.install);
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
  // npm deprecation = the maker says stop using it (e.g. @modelcontextprotocol/server-postgres). 1 subrequest.
  const npmName = (/^@[\w.-]+\/[\w.-]+$/.test(String(raw).trim().replace(/^(npx|npm i|npm install)\s+(-y\s+)?/i, "").replace(/^npm:/i, "").replace(/(?<=.)@[^/@]*$/, "")) && String(raw).trim().replace(/^(npx|npm i|npm install)\s+(-y\s+)?/i, "").replace(/^npm:/i, "").replace(/(?<=.)@[^/@]*$/, ""))
    || (facts.install && /^npm:/.test(facts.install) ? facts.install.slice(4).replace(/(?<=.)@[^/@]*$/, "") : null);
  let npmFound = false;
  if (npmName) {
    const r = await fetch("https://registry.npmjs.org/" + npmName.replace("/", "%2f") + "/latest", { cf: { cacheTtl: 3600 } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j && j.deprecated) facts.deprecated = String(j.deprecated).slice(0, 200);
    if (j && !res.name) res.name = j.name;
    if (j && !facts.description && j.description) facts.description = String(j.description).slice(0, 200);
    // not in KitScout but on npm (2026-11-15: @modelcontextprotocol/server-filesystem was 'not found'): follow package.json repository
    if (j) npmFound = true;
    const m = j && facts.stars == null && String((j.repository && (j.repository.url || j.repository)) || "").match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#].*)?$/i);
    if (m) {
      const g = await ghRepo(m[1]);
      if (g && !g.missing) Object.assign(facts, { stars: g.stargazers_count, last_push_days: days(g.pushed_at), license: facts.license || (g.license && g.license.spdx_id) || null, archived: facts.archived || g.archived, repo: facts.repo || g.html_url });
      // monorepo (2026-11-16 review: server-filesystem showed 92k = the whole modelcontextprotocol/servers repo): package lives in a
      // sub-directory, or the repo name is not the package name -> say the stars are the repo's
      const base = npmName.replace(/^@[^/]+\//, "").toLowerCase(), rname = m[1].split("/")[1].toLowerCase().replace(/\.git$/, "");
      if (g && !g.missing && ((j.repository && j.repository.directory) || (!rname.includes(base) && !base.includes(rname))))
        facts.stars_note = "GitHub stars of the whole repo, which holds several packages; not of this package alone";
    }
  }
  if (repo && arch && arch.includes(repo.toLowerCase())) facts.archived = true;
  // verdict
  // deprecation that only says "moved to <pkg>" = renamed, not abandoned (2026-11-15: openflowkit)
  const mv = facts.deprecated && facts.deprecated.match(/\b(?:moved|renamed|migrated|published)\s+(?:to|as)\s+(@?[\w.-]+(?:\/[\w.-]+)?)/i);
  const moved = mv && !/retired|unsupported|unmaintained|no longer|archived/i.test(facts.deprecated) ? mv[1].replace(/[.]+$/, "") : null;
  if (moved) { facts.moved_to = moved; delete facts.deprecated; }
  if (facts.deprecated) reasons.push("npm package is deprecated by its maker: " + facts.deprecated);
  if (facts.archived) reasons.push("repository is archived (no longer maintained)");
  // input was a repo (= the code): a hosted endpoint of it being down is a note, not a reason to avoid the code (2026-11-15: metabase, marmot)
  const codeInput = !!k.repo && !k.url, liveFail = !!facts.live_now && (facts.live_now.startsWith("no answer") || facts.live_now.startsWith("HTTP 5"));
  if (facts.live_now && facts.live_now.startsWith("no answer")) reasons.push(codeInput ? `its hosted endpoint (${facts.install}) did not answer just now; self-hosting the code is unaffected` : "remote server did not answer just now");
  if (facts.live_now && facts.live_now.startsWith("HTTP")) reasons.push((codeInput ? "its hosted endpoint returned " : "remote server returned ") + facts.live_now);
  if (facts.last_push_days > 730) reasons.push(`no code changes for ${facts.last_push_days} days (abandoned)`);
  else if (facts.last_push_days > 365) reasons.push(`no code changes for ${facts.last_push_days} days: may be finished or unmaintained`);
  else if (facts.last_push_days > 180) reasons.push(`slow maintenance: last change ${facts.last_push_days} days ago`);
  const vettedPlugin = facts.type === "plugin" && facts.verified_publisher;  // listed in Anthropic's reviewed marketplace: stars of a tiny plugin repo say little
  if (moved) reasons.push(`package moved: use ${moved} instead`);
  if ((facts.stars ?? 0) < 10 && !facts.first_party && !facts.deprecated && !vettedPlugin && facts.stars != null) reasons.push(`little adoption (${facts.stars ?? 0} GitHub stars) and not made by the product's maker`);
  if (!a && !repo && !k.url && !facts.deprecated && !npmFound) reasons.push("not found in KitScout (88k tools) — check the exact name, repo URL or package id");
  if (!res.verdict) res.verdict = (facts.archived || facts.deprecated || (liveFail && !codeInput) || facts.last_push_days > 730) ? "avoid" : reasons.length ? "caution" : "ok";
  if (res.verdict === "ok" && facts.first_party) reasons.push("made by the product's own company");
  // MCP reference servers (modelcontextprotocol org): official, but examples by the protocol's maintainers, not a vendor product
  if (/github\.com\/modelcontextprotocol\//i.test(String(facts.repo || "")) || /^modelcontextprotocol\//i.test(String(repo || ""))) {
    facts.official_reference = true;
    if (res.verdict === "ok") reasons.push("official MCP reference server from the modelcontextprotocol project (an example implementation, not a vendor product)");
  }
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
  return { checked: await Promise.all(list.map(x => checkOne(x, cats, arch))), note: "verdict: ok / caution / avoid, from maker, maintenance, adoption and live status only. ok is not a security or code review: read the code or check the publisher before giving a tool secrets or write access. live_now = we called the remote server during this check." };
}

// ---- Stack guard (KitScout plugin, 2026-11-16): the user's INSTALLED tools, checked from our daily data (no live probes, no GitHub
// calls) so one request can cover a whole stack within the 50-subrequest budget. The plugin sends public ids only (package names,
// server URLs without query strings, plugin names); local "fails to start" comes from the user's own machine, never from us.
const STACK_MAX = 10;
async function stackOne(raw, arch) {
  const k = keyOf(raw);
  let hits = await lookup(k.key); if (!hits.length && k.alt) hits = await lookup(k.alt);
  const res = { input: raw, in_kitscout: hits.length > 0 }, reasons = [];
  let status = "ok";
  const worse = s => { const o = { ok: 0, caution: 1, avoid: 2 }; if (o[s] > o[status]) status = s; };
  if (hits.length) {
    const i = hits[0], a = await meta(i), [pushed, , lstate, lat] = await extra(i);
    if (a) {
      Object.assign(res, { name: a[0], page: shape(a, null).page, first_party: a[7].includes("v") });
      const d = days(pushed);
      if (a[6] && arch && arch.includes(String(a[6]).toLowerCase())) { reasons.push("repository is archived (no longer maintained)"); worse("avoid"); }
      if (d > 730) { reasons.push(`no code changes for ${d} days (abandoned)`); worse("avoid"); }
      else if (d > 365) { reasons.push(`no code changes for ${d} days: may be unmaintained`); worse("caution"); }
      if (lstate === "down" && String(a[4]).startsWith("https://")) { reasons.push(`remote server did not answer our daily check (${lat || "latest"})`); worse("caution"); }  // "auth" = answers with a sign-in request = fine
    }
  }
  const npmName = (k.key && /^(@[\w.-]+\/)?[\w.-]+$/.test(k.key) && /^npm:/i.test(String(raw).trim())) ? k.key : null;
  if (npmName) {
    const r = await fetch("https://registry.npmjs.org/" + npmName.replace("/", "%2f") + "/latest", { cf: { cacheTtl: 3600 } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (j && j.deprecated) {
      const dep = String(j.deprecated).slice(0, 200), mv = dep.match(/\b(?:moved|renamed|migrated|published)\s+(?:to|as)\s+(@?[\w.-]+(?:\/[\w.-]+)?)/i);
      if (mv && !/retired|unsupported|unmaintained|no longer|archived/i.test(dep)) { reasons.push(`package moved: use ${mv[1].replace(/[.]+$/, "")} instead`); worse("caution"); }
      else { reasons.push("npm package is deprecated by its maker: " + dep); worse("avoid"); }
    }
    if (j && !res.name) res.name = j.name;
  }
  res.verdict = status; res.reasons = reasons;
  return res;
}
async function stack(req, env, ctx) {
  let b = {}; try { b = await req.json(); } catch {}
  const list = (Array.isArray(b.tools) ? b.tools : []).map(x => String(x || "").trim().slice(0, 200)).filter(Boolean).slice(0, STACK_MAX);
  if (!list.length) return Response.json({ error: "Pass tools: a list of package ids (npm:, pypi:), remote MCP URLs or plugin names (max " + STACK_MAX + " per request)." }, { status: 400, headers: CORS });
  const arch = await jget("s/arch.json");
  const checked = await Promise.all(list.map(x => stackOne(x, arch).catch(() => ({ input: x, verdict: "ok", reasons: [], error: "check failed" }))));
  const params = { clientInfo: { name: String(b.client || "kitscout-plugin").slice(0, 40) } };
  logRow(env, ctx, req, "tools/call", { ...params, name: "stack", arguments: { tools: list } }, { checked });
  return Response.json({ checked, note: "From KitScout's daily data. Details and alternatives: ask your agent to run check_tools on any flagged tool." }, { headers: CORS });
}
// Opt-in crowd health (plugin setting share_health): did each tool start on the user's machine today. No ids of people or machines.
async function health(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const rows = (Array.isArray(b.results) ? b.results : []).slice(0, 50).map(r => [String(r.tool || "").slice(0, 200), ["ok", "fail", "auth"].includes(r.status) ? r.status : null]).filter(r => r[0] && r[1]);
  if (!rows.length || !env || !env.LOG) return new Response(null, { status: 204, headers: CORS });
  const day = new Date().toISOString().slice(0, 10), client = String(b.client || "").slice(0, 40), cc = (req.cf && req.cf.country) || "";
  await env.LOG.batch(rows.map(([t, s]) => env.LOG.prepare("INSERT INTO health (day, tool, status, client, country) VALUES (?,?,?,?,?)").bind(day, t, s, client, cc))).catch(() => {});
  return new Response(null, { status: 204, headers: CORS });
}

// ---- Free key + watch list (kitscout.dev/watch). Key itself is never stored: only sha256 (khash) and its first 12 hex (kid).
const WATCH_MAX = 25;
const WATCH_URL = SITE + "watch";
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
async function keyId(req, url, env) {
  const auth = req.headers.get("authorization") || "";
  const k = (url.searchParams.get("key") || (auth.match(/^Bearer\s+(ks_[0-9a-f]{32})$/i) || [])[1] || "").trim();
  if (!/^ks_[0-9a-f]{32}$/.test(k) || !env || !env.LOG) return null;
  const row = await env.LOG.prepare("SELECT kid FROM subs WHERE khash = ? AND status = 'active'").bind(await sha256hex(k)).first().catch(() => null);
  return row ? row.kid : null;
}
const nowMin = () => new Date().toISOString().slice(0, 16);
async function watchAdd(env, kid, items) {  // items: [{tool, verdict}]; returns {watching, max, skipped}
  const have = new Set(((await env.LOG.prepare("SELECT tool FROM watch WHERE kid = ?").bind(kid).all()).results || []).map(r => r.tool));
  const ts = nowMin(), stmts = [];
  let skipped = 0;
  for (const it of items) {
    const t = String(it.tool || "").trim().slice(0, 200);
    if (!t) continue;
    if (!have.has(t) && have.size >= WATCH_MAX) { skipped++; continue; }
    have.add(t);
    stmts.push(env.LOG.prepare("INSERT INTO watch (kid, tool, verdict, added, checked) VALUES (?,?,?,?,?) ON CONFLICT(kid, tool) DO UPDATE SET verdict = COALESCE(excluded.verdict, watch.verdict), checked = COALESCE(excluded.checked, watch.checked)")
      .bind(kid, t, it.verdict || null, ts, it.verdict ? ts : null));
  }
  if (stmts.length) await env.LOG.batch(stmts);
  return { watching: have.size, max: WATCH_MAX, skipped };
}
const GUARD_REPORT = 'node "$HOME/.kitscout/guard.mjs" --report';
async function watchlist(args, env, kid, via) {
  // KitScout Claude Code plugin (connects with ?via=plugin): installed tools are watched locally by the stack guard, no key needed
  if (!kid && via === "plugin") return { watched_by: "KitScout stack guard (Claude Code plugin)",
    how: `Every MCP server and plugin installed in this Claude Code is checked automatically (at most once a day, at session start). For the current report run: ${GUARD_REPORT}  (add --refresh first for a fresh check; it takes up to a minute). Then use check_tools on flagged tools for alternatives.`,
    note: "Nothing to add or remove by hand: the stack guard follows what is installed. Use the check-my-stack skill for the full flow." };
  if (!kid) return { error: `No KitScout key on this connection. Get a free key at ${WATCH_URL} and connect with https://mcp.kitscout.dev/mcp?key=<your key>. Then every tool you check is watched, and you get an email when one is renamed, archived, deprecated or stops answering.` };
  const rm = (Array.isArray(args.remove) ? args.remove : args.remove ? [args.remove] : []).map(String).slice(0, WATCH_MAX);
  if (rm.length) await env.LOG.batch(rm.map(t => env.LOG.prepare("DELETE FROM watch WHERE kid = ? AND tool = ?").bind(kid, t)));
  const rows = (await env.LOG.prepare("SELECT tool, verdict, added, checked FROM watch WHERE kid = ? ORDER BY added").bind(kid).all()).results || [];
  return { watching: rows.map(r => ({ tool: r.tool, last_verdict: r.verdict || "not checked yet", added: r.added, last_checked: r.checked })), count: rows.length, max: WATCH_MAX,
    note: "Tools are added automatically when you check_tools with this key. We email you when a watched tool is renamed, archived, deprecated or stops answering (weekly digest, free during early access)." };
}

const EMAIL_RE = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,253}\.[A-Za-z]{2,}$/;
async function signup(req, env) {
  const ct = req.headers.get("content-type") || "";
  let f = {};
  try { f = ct.includes("json") ? await req.json() : Object.fromEntries(await req.formData()); } catch { f = {}; }
  const html = !ct.includes("json");
  const reply = (obj, status = 200) => html
    ? new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KitScout key</title><body style="font:16px/1.6 system-ui;max-width:640px;margin:40px auto;padding:0 16px">${obj.error ? `<p>${obj.error}</p>` : `<h1>Your KitScout key</h1><p>Save it now; we cannot show it again.</p><p><code style="word-break:break-all">${obj.key}</code></p><p>Connect: <code style="word-break:break-all">${obj.mcp_url}</code></p>`}<p><a href="${WATCH_URL}">Back to KitScout</a></p>`, { status, headers: { "content-type": "text/html; charset=utf-8", ...CORS } })
    : Response.json(obj, { status, headers: CORS });
  if (f.website) return reply({ error: "Rejected." }, 400);  // honeypot field, invisible to people
  const email = String(f.email || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return reply({ error: "Please enter a valid email address." }, 400);
  if (!env || !env.LOG) return reply({ error: "Signup is temporarily unavailable." }, 503);
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const key = "ks_" + [...rnd].map(x => x.toString(16).padStart(2, "0")).join("");
  const khash = await sha256hex(key), kid = khash.slice(0, 12);
  const pro = ["1", "true", "on", "yes"].includes(String(f.pro || "").toLowerCase()) ? 1 : 0;
  await env.LOG.prepare("INSERT INTO subs (kid, khash, email, ts, source, pro, country, status) VALUES (?,?,?,?,?,?,?, 'active')")
    .bind(kid, khash, email, nowMin(), String(f.source || "web").slice(0, 40), pro, (req.cf && req.cf.country) || "").run();
  const tools = String(f.tools || "").split(/[\n,]+/).map(x => x.trim()).filter(Boolean).slice(0, WATCH_MAX);
  const w = tools.length ? await watchAdd(env, kid, tools.map(t => ({ tool: t }))) : { watching: 0, max: WATCH_MAX };
  return reply({ key, mcp_url: `https://mcp.kitscout.dev/mcp?key=${key}`, watching: w.watching, max: WATCH_MAX });
}

const TOOLS = [
  {
    name: "search_tools",
    description: "Search ~88k AI agent tools (MCP servers, Agent Skills, Claude Code plugins) by keywords. Returns ranked matches with type, category, GitHub stars, badges (first_party = made by the product's own maker, verified_publisher, live, free_to_try), install line and KitScout page. Use short keywords: product + action, e.g. 'postgres', 'slack post message', 'pdf extract tables'.",
    inputSchema: {
      type: "object", required: ["query"], properties: {
        query: { type: "string", description: "Keywords (product names and actions work best)" },
        type: { type: "string", enum: ["mcp", "skill", "plugin"], description: "Only this kind of tool" },
        only_verified: { type: "boolean", description: "Only verified publishers (domain-verified registry namespace, Anthropic marketplace). Does not mean made by the product's vendor; see the first_party badge" },
        only_official: { type: "boolean", description: "Deprecated alias of only_verified" },
        only_live: { type: "boolean", description: "Only remote MCP servers that answered our latest daily check (including ones that answer with a sign-in/OAuth request)" },
        only_free_to_try: { type: "boolean", description: "Only remote MCP servers that worked without an API key" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Max results (default 10)" },
      },
    },
    annotations: { title: "Search agent tools", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "get_tool",
    description: "Details for one KitScout tool by its exact name: description, badges, stars, repo, install or connect instructions, and for remote MCP servers the actual tool list the server exposes (from our live check).",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "Exact tool name as listed in KitScout" } } },
    annotations: { title: "Get tool details", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "check_tools",
    description: "Before installing tools you found elsewhere (web search, a README, a blog), verify them: is it the product maker's own tool, maintained (last code change, archived?), adopted (stars), does the remote server answer right now, where does your data go — with a verdict (ok / caution / avoid; not a security review) and better alternatives. Pass up to 5 GitHub URLs, package ids (npm/pypi), remote MCP URLs or names per call.",
    inputSchema: { type: "object", required: ["tools"], properties: { tools: { type: "array", items: { type: "string" }, maxItems: 5, description: "e.g. https://github.com/owner/repo, @scope/package, https://mcp.example.com/mcp" } } },
    annotations: { title: "Check tools before installing", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_categories",
    description: "All KitScout categories (id, name, group, tool count). Useful to see what kinds of tools exist before searching.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List categories", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "watchlist",
    description: "Your KitScout watch list (needs a free key: connect with https://mcp.kitscout.dev/mcp?key=<key>, get one at kitscout.dev/watch). Tools you check_tools with a key are added automatically; KitScout emails you when one is renamed, archived, deprecated or stops answering. Shows each watched tool with its last verdict; pass remove to stop watching tools.",
    inputSchema: { type: "object", properties: { remove: { type: "array", items: { type: "string" }, description: "Tool names or URLs to stop watching (as listed)" } } },
    annotations: { title: "My watched tools", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
function logRow(env, ctx, req, method, params, data, kid) {
  if (!env || !env.LOG) return;
  if (new URL(req.url).searchParams.get("via") === "plugin") params = { ...params, clientInfo: { name: (clientOf(req, params) || "unknown").slice(0, 32) + "+plugin" } };
  const a = (params && params.arguments) || {};
  const tool = method === "tools/call" ? String(params.name || "").slice(0, 40) : method;
  const q = String(a.query || a.name || (Array.isArray(a.tools) ? a.tools.join(" | ") : a.tools) || "").slice(0, 500);
  const filters = ["type", "only_official", "only_live", "only_free_to_try", "limit"].filter(k => a[k] !== undefined).map(k => k + "=" + a[k]).join(",");
  const res = data && data.results ? data.results.map(r => r.name).slice(0, 10) : data && data.checked ? data.checked.map(c => `${c.name || c.input}:${c.verdict}`) : data && data.name ? [data.name] : [];
  const n = data && (data.total_matches ?? (data.error ? 0 : data.name ? 1 : null));
  ctx.waitUntil(env.LOG.prepare("INSERT INTO q (ts, country, client, tool, query, filters, n, results, kid) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(new Date().toISOString().slice(0, 16), (req.cf && req.cf.country) || "", clientOf(req, params), tool, q, filters, n ?? null, JSON.stringify(res), kid || null)
    .run().catch(() => {}));
}

async function handle(msg, req, env, ctx, kid, via) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[1];
    logRow(env, ctx, req, method, params, null, kid);
    return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kitscout", title: "KitScout", version: "1.0.2", websiteUrl: SITE, icons: [{ src: SITE + "icon.png", mimeType: "image/png", sizes: ["500x500"] }, { src: SITE + "favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] }] }, instructions: INSTRUCTIONS });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: kid ? TOOLS : TOOLS.filter(x => x.name !== "watchlist") });  // email watch list: key holders only (sign-ups paused until alerts ship)
  if (method === "tools/call") {
    const fn = { search_tools: searchTools, get_tool: getTool, check_tools: checkTools, list_categories: listCategories, watchlist: a => watchlist(a, env, kid, via) }[params.name];
    if (!fn) return err(-32602, "Unknown tool: " + params.name);
    try {
      const data = await fn(params.arguments || {});
      if (params.name === "check_tools" && data.checked) {
        if (kid) data.watchlist = { ...(await watchAdd(env, kid, data.checked.map(c => ({ tool: c.name || c.input, verdict: c.verdict })))),
          note: "Watched: we email you if any of these is renamed, archived, deprecated or stops answering." };
        else data.watch_hint = `Using Claude Code? The free KitScout plugin warns at session start when any installed tool fails to start, is archived, deprecated or down: ${WATCH_URL}`;
      }
      logRow(env, ctx, req, method, params, Array.isArray(data) ? null : data, kid);
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
<h1>KitScout MCP server</h1><p>Lets your AI agent search ~88,000 MCP servers, Agent Skills and Claude Code plugins on <a href="${SITE}">kitscout.dev</a>, with live checks and install lines. Free, read-only, no key.</p>
<p><b>Claude Code:</b> <code>claude mcp add --transport http kitscout https://mcp.kitscout.dev/mcp</code></p>
<p><b>Claude app:</b> Settings → Connectors → Add custom connector → <code>https://mcp.kitscout.dev/mcp</code></p>
<p>Tools: check_tools, search_tools, get_tool, list_categories. Contact: contact@kitscout.dev</p>
<p><b>Claude Code:</b> the free KitScout plugin also warns you at session start when an installed tool breaks. <a href="${WATCH_URL}">How it works</a></p>
<p>Privacy: we keep a log of calls (keywords, results, country, client app name; with a key, a short key id) to learn which tools agents need. No IPs or file contents. <a href="${SITE}privacy">Data policy</a></p>`;

export default {
  async fetch(req, env, ctx) {
    ENV = env || {};
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/signup" && req.method === "POST") return signup(req, env);
    if (url.pathname === "/stack" && req.method === "POST") return stack(req, env, ctx);
    if (url.pathname === "/health" && req.method === "POST") return health(req, env);
    if (url.pathname !== "/mcp") return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (req.method === "GET") return new Response("Use POST (Streamable HTTP, JSON responses).", { status: 405, headers: { Allow: "POST", ...CORS } });
    if (req.method !== "POST") return new Response(null, { status: 405, headers: CORS });
    let body;
    try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS }); }
    const msgs = Array.isArray(body) ? body : [body];
    const kid = await keyId(req, url, env), via = url.searchParams.get("via") === "plugin" ? "plugin" : null;
    const out = (await Promise.all(msgs.filter(m => m && m.id !== undefined && m.method).map(m => handle(m, req, env, ctx, kid, via))));
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return Response.json(Array.isArray(body) ? out : out[0], { headers: CORS });
  },
};
