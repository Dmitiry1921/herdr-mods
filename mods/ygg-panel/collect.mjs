// ygg-panel: данные правой панели для активной вкладки Herdr.
// node collect.mjs <terminalId> <cwd> <kind>  → JSON в stdout.
// Источники: состояние чата herdr-chat (cwd, провайдер, файл сессии), git, хвост файла сессии
// (контекст), rollout-файлы Codex (лимиты Codex), снимок статусной строки Claude Code (лимиты Claude),
// config.toml Codex и settings.json Claude (коннекторы).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const [, , term = "", argCwd = "", argKind = "", action = ""] = process.argv;
const HOME = os.homedir();
const APP = path.join(HOME, ".config/herdr-app");
const DATA = path.join(APP, "data/ygg-panel");
const ICONS = path.join(DATA, "icons");

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const tail = (p, bytes) => {
  try {
    const fd = fs.openSync(p, "r"), size = fs.fstatSync(fd).size, len = Math.min(size, bytes);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    return buf.toString("utf8").split("\n");
  } catch { return []; }
};
const lastJSON = (lines, test) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!test(lines[i])) continue;
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
};
const git = (cwd, args) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000 }).trim(); } catch { return ""; } };

// 1. Сессия активной вкладки.
let agent = argKind || null, cwd = argCwd || null, sessionFile = null, chat = null;
const chats = path.join(APP, "data/herdr-chat/chats");
try {
  for (const f of fs.readdirSync(chats)) {
    const s = readJSON(path.join(chats, f));
    if (s && term && s.terminal === term) { chat = s; agent = s.provider; cwd = s.cwd; sessionFile = s.sessionFile; break; }
  }
} catch {}
// ponytail: терминальная сессия Claude — берём свежий транскрипт её папки; терминальный Codex без файла.
if (!sessionFile && agent === "claude" && cwd) {
  const dir = path.join(HOME, ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  try {
    const f = fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))
      .map((x) => ({ x, t: fs.statSync(path.join(dir, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (f) sessionFile = path.join(dir, f.x);
  } catch {}
}

// 2. Git.
const repo = cwd ? { folder: path.basename(cwd), branch: git(cwd, ["branch", "--show-current"]) } : null;
if (repo) {
  const st = git(cwd, ["diff", "--shortstat", "HEAD"]);
  const n = (re) => Number((st.match(re) || [])[1] || 0);
  repo.files = n(/(\d+) files? changed/); repo.add = n(/(\d+) insertion/); repo.del = n(/(\d+) deletion/);
}

// Хост herdr-chat: WebSocket по токену из файла состояния. Снимок несёт точный контекст агента,
// запрос compact сжимает сессию.
const host = (req) => new Promise((resolve) => {
  if (!chat?.wsPort || typeof WebSocket === "undefined") return resolve(null);
  const ws = new WebSocket(`ws://127.0.0.1:${chat.wsPort}`);
  const done = (v) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
  const timer = setTimeout(() => done(null), req ? 120000 : 2500);
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: chat.token, client: "ygg-panel" }));
  ws.onerror = () => done(null);
  ws.onmessage = (m) => {
    const r = JSON.parse(m.data);
    if (r.t === "snapshot" && !req) done(r.state);
    else if (r.t === "snapshot" && req) ws.send(JSON.stringify({ t: "req", id: "ygg", ...req }));
    else if (r.t === "res" && r.id === "ygg") done(r);
  };
});
if (action === "compact") { const r = await host({ op: "compact" }); process.stdout.write(JSON.stringify(r)); process.exit(0); }

// 3. Контекст.
let context = null;
const usage = (await host(null))?.usage;
if (usage?.contextTokens && usage.contextWindow) context = { used: usage.contextTokens, window: usage.contextWindow, exact: true };
else if (sessionFile && agent === "codex") {
  const e = lastJSON(tail(sessionFile, 4e6), (l) => l.includes('"token_count"') && l.includes('"last_token_usage"'));
  const info = e?.payload?.info;
  if (info) context = { used: info.last_token_usage.total_tokens, window: info.model_context_window };
} else if (sessionFile && agent === "claude") {
  const e = lastJSON(tail(sessionFile, 4e6), (l) => l.includes('"usage"') && l.includes('"assistant"'));
  const u = e?.message?.usage;
  if (u) {
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    // ponytail: окно Claude по факту заполнения (200k или 1M); точное придёт со статусной строкой.
    context = { used, window: used > 200000 ? 1000000 : 200000, model: e.message.model };
  }
}

// 4. Лимиты.
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const resetText = (sec) => {
  if (!sec) return "";
  const d = new Date(sec * 1000), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d - Date.now() < 864e5 ? `сброс ${hm}` : `${WD[d.getDay()]} ${hm}`;
};
const windowLabel = (min) => (min <= 300 ? "5 часов" : min >= 10080 ? "Неделя" : `${Math.round(min / 60)} ч`);
const limits = { claude: null, codex: null };

// Claude: снимок статусной строки, пишет data/ygg-panel/statusline.sh.
const cs = readJSON(path.join(DATA, "claude-status.json"));
if (cs?.rate_limits) {
  const MODEL = (k) => k.replace(/^seven_day_?/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  limits.claude = {
    plan: cs.plan || "",
    at: fs.statSync(path.join(DATA, "claude-status.json")).mtimeMs,
    rows: Object.entries(cs.rate_limits).filter(([, w]) => w && typeof w === "object").map(([k, w]) => {
      const pct = w.used_percentage ?? w.utilization ?? w.used_percent ?? 0;
      const reset = w.resets_at ? (typeof w.resets_at === "number" ? w.resets_at : Date.parse(w.resets_at) / 1000) : 0;
      const label = k === "five_hour" ? "5 часов" : k === "seven_day" ? "Неделя · все модели" : k.startsWith("seven_day") ? `Неделя · ${MODEL(k)}` : k;
      return { label, pct: reset && reset * 1000 < Date.now() ? 0 : Math.round(pct), reset: resetText(reset) };
    }),
  };
}

// Codex: последнее событие token_count с rate_limits в свежих rollout-файлах.
try {
  const root = path.join(HOME, ".codex/sessions");
  const files = execFileSync("find", [root, "-name", "rollout-*.jsonl", "-mtime", "-8"], { encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 15);
  let best = null;
  for (const { f } of files) {
    const e = lastJSON(tail(f, 2e6), (l) => l.includes('"rate_limits":{'));
    if (e?.payload?.rate_limits && (!best || e.timestamp > best.timestamp)) best = e;
  }
  const rl = best?.payload?.rate_limits;
  if (rl) {
    const row = (w) => w && { label: windowLabel(w.window_minutes), pct: w.resets_at * 1000 < Date.now() ? 0 : Math.round(w.used_percent), reset: resetText(w.resets_at) };
    limits.codex = {
      plan: { prolite: "Pro", pro: "Pro", plus: "Plus", team: "Team", business: "Business" }[rl.plan_type] ?? rl.plan_type ?? "",
      rows: [row(rl.primary), row(rl.secondary)].filter(Boolean),
      credits: rl.credits?.has_credits && !rl.credits.unlimited ? Math.round(Number(rl.credits.balance)) : null,
    };
  }
} catch {}

// 5. Коннекторы активного агента.
// Значок: логотип плагина Codex, иначе бренд из Simple Icons по имени, иначе вилка.
const BRANDS = [
  [/grafana/, "grafana", "#F46800"], [/home.?assistant/, "homeassistant", "#18BCF2"], [/blender/, "blender", "#E87D0D"],
  [/typescript/, "typescript", "#3178C6"], [/github/, "github", null], [/figma/, "figma", "#F24E1E"],
  [/gmail/, "gmail", "#EA4335"], [/drive/, "googledrive", "#4285F4"], [/jira/, "jira", "#2684FF"],
  [/confluence/, "confluence", "#2684FF"], [/atlassian/, "atlassian", "#2684FF"], [/notion/, "notion", null], [/slack/, "slack", "#E01E5A"],
];
const codexLogos = (() => {
  const out = {};
  const scan = (dir, depth) => {
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && d.name === ".codex-plugin") {
        const m = readJSON(path.join(p, "plugin.json")), logo = m?.interface?.logo;
        if (m?.name && logo) {
          const src = path.resolve(dir, logo), t = (() => { try { return fs.statSync(src).mtimeMs; } catch { return 0; } })();
          if (t && (!out[m.name] || out[m.name].t < t)) out[m.name] = { src, t, title: m.interface.displayName };
        }
      } else if (d.isDirectory() && depth > 0 && !d.name.startsWith(".")) scan(p, depth - 1);
    }
  };
  scan(path.join(HOME, ".codex/plugins"), 4);
  return out;
})();
fs.mkdirSync(ICONS, { recursive: true });
const icon = (name) => {
  const key = name.toLowerCase();
  const logo = codexLogos[key];
  if (logo) {
    const dst = path.join(ICONS, `${key}${path.extname(logo.src)}`);
    try { if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < logo.t) fs.copyFileSync(logo.src, dst); } catch {}
    return { image: path.relative(APP, dst), title: logo.title };
  }
  const b = BRANDS.find(([re]) => re.test(key));
  return b ? { svg: `mods/ygg-panel/brands/${b[1]}.svg`, color: b[2] } : { svg: "mods/ygg-panel/icons/plug.svg" };
};
const connectors = [];
if (agent === "codex") {
  let section = null;
  const add = (kind, name) => { section = { kind, name, on: true }; connectors.push(section); };
  for (const line of (fs.existsSync(path.join(HOME, ".codex/config.toml")) ? fs.readFileSync(path.join(HOME, ".codex/config.toml"), "utf8") : "").split("\n")) {
    let m;
    if ((m = line.match(/^\[plugins\."([^"@]+)@[^"]*"\]/))) add("plugin", m[1]);
    else if ((m = line.match(/^\[mcp_servers\.([^.\]]+)\]/))) add("mcp", m[1]);
    else if (line.startsWith("[")) section = null;
    else if (section && /^enabled\s*=\s*false/.test(line)) section.on = false;
  }
} else if (agent === "claude") {
  const s = readJSON(path.join(HOME, ".claude/settings.json"));
  for (const [k, v] of Object.entries(s?.enabledPlugins || {})) connectors.push({ kind: "plugin", name: k.split("@")[0], on: !!v });
  const mcp = { ...(readJSON(path.join(HOME, ".claude.json"))?.mcpServers || {}), ...(cwd ? readJSON(path.join(cwd, ".mcp.json"))?.mcpServers || {} : {}) };
  for (const k of Object.keys(mcp)) connectors.push({ kind: "mcp", name: k, on: true });
}
for (const c of connectors) Object.assign(c, icon(c.name));
connectors.sort((a, b) => Number(b.on) - Number(a.on));

process.stdout.write(JSON.stringify({ agent, cwd, repo, context, limits, connectors, chat: !!chat }));
