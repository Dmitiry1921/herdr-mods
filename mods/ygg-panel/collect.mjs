// ygg-panel: данные правой панели для активной вкладки Herdr.
// node collect.mjs <terminalId> <cwd> <kind>  → JSON в stdout.
// Источники: состояние чата herdr-chat (cwd, провайдер, файл сессии), git, хвост файла сессии
// (контекст), rollout-файлы Codex (лимиты Codex), снимок статусной строки Claude Code (лимиты Claude),
// config.toml Codex и settings.json Claude (коннекторы).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

const [, , term = "", argCwd = "", argKind = "", action = "", argSid = "", machine = ""] = process.argv;
const HOME = os.homedir();
const APP = path.join(HOME, ".config/herdr-app");
const DATA = path.join(APP, "data/ygg-panel");
// LiteLLM: свой шлюз у каждого, настройки вне репозитория в data/ygg-panel/litellm.json:
// { "base_url": "https://…", "budget": 10, "period": "неделю", "keychain": "<служба в Keychain>", "model": "<самая дешёвая модель>" }.
// Нет файла — раздела нет. ponytail: бюджет обычно стоит на пользователя, а шлюз отдаёт только расход ключа
// (x-litellm-key-spend): при одном ключе это одно и то же, но время сброса бюджета API не отдаёт, и после сброса расход
// ключа, скорее всего, не обнулится. Понадобится точнее: день сброса из кабинета LiteLLM и базовая точка.
const LITELLM_CONF = path.join(DATA, "litellm.json");
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
const PATHS = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
const sh = (cmd, args, timeout = 3000) => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PATH: PATHS } }).trim(); } catch { return ""; } };
// Git папки сессии; у сессии на сервере — там же, через hc exec.
const git = (cwd, args) => (machine ? sh("hc", ["exec", "--on", machine, "git", "-C", cwd, ...args], 6000) : sh("git", ["-C", cwd, ...args]));
const fresh = (p, ms) => { try { return Date.now() - fs.statSync(p).mtimeMs < ms; } catch { return false; } };
// Долгое (разбивка контекста, лимиты Claude, PR) считается отдельным процессом в кэш: панель не ждёт.
const later = (...args) => spawn(process.execPath, [process.argv[1], ...args], { detached: true, stdio: "ignore", cwd: args[1] && fs.existsSync(args[1]) ? args[1] : HOME, env: { ...process.env, PATH: PATHS } }).unref();
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(`${p}.tmp`, JSON.stringify(v)); fs.renameSync(`${p}.tmp`, p); };
const MD_ROWS = (text, title) => {
  const part = text.split(/^### /m).find((x) => x.startsWith(title)) ?? "";
  return part.split("\n").filter((l) => l.startsWith("|") && !/^\|[-\s|]+\|$/.test(l)).slice(1).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
};
const NUM = (v) => { const m = String(v).replace(/[~,]/g, "").match(/([\d.]+)\s*([km]?)/i); return m ? Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1) : 0; };

// Фоновые задачи (запускает later).
if (action === "bg-codex-context") {
  // Разбивка контекста Codex (codex-context.mjs); у сессии на сервере тот же скрипт гоняется там через hc exec.
  const [id, file] = [argSid, argCwd], out = path.join(DATA, `ctx-codex-${id}.json`);
  const script = path.join(path.dirname(process.argv[1]), "codex-context.mjs");
  const raw = machine
    ? sh("hc", ["exec", "--on", machine, "sh", "-c", `f=$(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*-${id}.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] && node --input-type=module -e "$0" "$f"`, fs.readFileSync(script, "utf8")], 60000)
    : sh(process.execPath, [script, file], 60000);
  try { writeJSON(out, JSON.parse(raw)); } catch { writeJSON(out, { at: Date.now(), error: true }); }
  process.exit(0);
}
if (action === "bg-context") {
  // /context Claude без вызова модели: те же категории, что в окне контекста Claude.
  const [sid, dir, out] = [argSid, argCwd, path.join(DATA, `ctx-${argSid}.json`)];
  const raw = sh("claude", ["-p", "/context", "--resume", sid, "--no-session-persistence", "--output-format", "json"], 60000);
  try {
    const text = JSON.parse(raw.slice(raw.indexOf("{"))).result ?? "";
    const head = text.match(/\*\*Tokens:\*\*\s*([\d.]+k?)\s*\/\s*([\d.]+[km]?)/i);
    const cats = MD_ROWS(text, "Estimated usage").map(([name, tok]) => ({ name, tokens: NUM(tok) }));
    const mcp = {};
    for (const [, server, tok] of MD_ROWS(text, "MCP Tools")) mcp[server] = (mcp[server] ?? 0) + NUM(tok);
    const memory = MD_ROWS(text, "Memory Files").map(([type, p, tok]) => ({ type, path: p, tokens: NUM(tok) }));
    const skills = MD_ROWS(text, "Skills").map(([name, source, tok]) => ({ name, source, tokens: NUM(tok) }));
    writeJSON(out, { at: Date.now(), cwd: dir, used: head ? NUM(head[1]) : null, window: head ? NUM(head[2]) : null, cats,
      mcp: Object.entries(mcp).map(([name, tokens]) => ({ name: name.replace(/^claude_ai_/, "").replace(/_/g, " "), tokens })).sort((a, b) => b.tokens - a.tokens),
      memory, skills: skills.sort((a, b) => b.tokens - a.tokens) });
  } catch {}
  process.exit(0);
}
if (action === "bg-claude-limits") {
  // Лимиты Claude: каждый ход Claude Code присылает rate_limit_event; самый дешёвый ход (Haiku, без
  // инструментов и настроек, ~3,5k токенов) раз в 15 минут.
  const raw = sh("claude", ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", ""], 90000);
  const ev = raw.split("\n").filter((l) => l.includes('"rate_limit_event"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).at(-1);
  const w = ev?.rate_limit_info?.unifiedWindows;
  if (w) writeJSON(path.join(DATA, "claude-status.json"), { rate_limits: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, { used_percentage: Math.round((v.utilization ?? 0) * 100), resets_at: v.resetsAt }])) });
  else writeJSON(path.join(DATA, "claude-status.json.miss"), { at: Date.now() });
  process.exit(0);
}
// Бюджет LiteLLM (через него ходит DeepSeek): служебные ручки /key/info и /spend/* обычному ключу закрыты (403),
// расход ключа приходит только заголовком x-litellm-key-spend в ответе на вызов модели. Самый дешёвый вызов
// раз в 15 минут. Ключ из LITELLM_API_KEY или Keychain (служба из litellm.json), только в заголовок запроса.
const LITELLM = readJSON(LITELLM_CONF);
if (action === "bg-litellm") {
  const out = path.join(DATA, "litellm-status.json");
  const key = process.env.LITELLM_API_KEY || (LITELLM?.keychain ? sh("security", ["find-generic-password", "-s", LITELLM.keychain, "-w"]) : "");
  try {
    if (!key || !LITELLM?.base_url || !LITELLM.model) throw new Error("no config");
    const r = await fetch(`${LITELLM.base_url.replace(/\/(v1\/?)?$/, "")}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: LITELLM.model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }) });
    const spend = Number(r.headers.get("x-litellm-key-spend"));
    if (!r.ok || !Number.isFinite(spend)) throw new Error(String(r.status));
    writeJSON(out, { spend });
  } catch { writeJSON(`${out}.miss`, { at: Date.now() }); }
  process.exit(0);
}
if (action === "bg-prs") {
  // PR репозитория, где я автор: GitHub через gh, Bitbucket Server через REST с токеном пользователя.
  const [url, out] = [argSid, path.join(DATA, `prs-${createHash("sha1").update(argCwd).digest("hex").slice(0, 12)}.json`)];
  let list = [];
  const gh = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  const bb = url.match(/^(?:ssh:\/\/git@|https:\/\/)([^/:]+)(?::\d+)?\/(?:scm\/)?([^/]+)\/([^/.]+)/);
  try {
    if (gh) {
      list = JSON.parse(sh("gh", ["pr", "list", "--repo", gh[1], "--author", "@me", "--state", "all", "--limit", "8", "--json", "number,title,state,isDraft,headRefName,url"], 20000) || "[]")
        .map((p) => ({ id: p.number, title: p.title, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, branch: p.headRefName, url: p.url }));
    } else if (bb) {
      const env = (() => { try { return fs.readFileSync(path.join(HOME, ".config/ott/.env"), "utf8"); } catch { return ""; } })();
      const token = process.env.BITBUCKET_TOKEN || env.match(/^BITBUCKET_TOKEN=(.+)$/m)?.[1]?.trim()
        || sh("security", ["find-generic-password", "-a", "bitbucket", "-s", "tokens/bitbucket", "-w"]);
      if (token) {
        const [host, proj, repo] = [bb[1], bb[2].toUpperCase(), bb[3]];
        const H = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) };
        // Имя пользователя токена: Bitbucket отдаёт его в заголовке X-AUSERNAME любого ответа.
        const me = decodeURIComponent((await fetch(`https://${host}/rest/api/1.0/dashboard/pull-requests?limit=1`, H)).headers.get("x-ausername") ?? "");
        const j = await (await fetch(`https://${host}/rest/api/1.0/projects/${proj}/repos/${repo}/pull-requests?state=ALL&role.1=AUTHOR&username.1=${encodeURIComponent(me)}&limit=8`, H)).json();
        list = (j.values ?? [])
          .slice(0, 8).map((p) => ({ id: p.id, title: p.title, state: p.state === "OPEN" && p.draft ? "DRAFT" : p.state, branch: p.fromRef?.displayId, url: p.links?.self?.[0]?.href }));
      }
    }
    writeJSON(out, { at: Date.now(), list });
  } catch { writeJSON(out, { at: Date.now(), list, error: true }); }
  process.exit(0);
}

// 4. Лимиты. Строки несут key (5h, W), длину окна в минутах и время сброса: по ним нижняя строка считает темп.
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const resetText = (sec) => {
  if (!sec) return "";
  const d = new Date(sec * 1000), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d - Date.now() < 864e5 ? `сброс ${hm}` : `${WD[d.getDay()]} ${hm}`;
};
const windowLabel = (min) => (min <= 300 ? "5 часов" : min >= 10080 ? "Неделя" : `${Math.round(min / 60)} ч`);

function readLimits() {
  const limits = { claude: null, codex: null };
  // Claude: снимок статусной строки, пишет data/ygg-panel/statusline.sh.
  const CS = path.join(DATA, "claude-status.json");
  if (!fresh(CS, 900000) && !fresh(`${CS}.miss`, 900000) && !fresh(`${CS}.lock`, 120000)) { writeJSON(`${CS}.lock`, {}); later("", "", "", "bg-claude-limits"); }
  const cs = readJSON(CS);
  if (cs?.rate_limits) {
    const MODEL = (k) => k.replace(/^seven_day_?/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    limits.claude = {
      plan: cs.plan || "",
      at: fs.statSync(path.join(DATA, "claude-status.json")).mtimeMs,
      rows: Object.entries(cs.rate_limits).filter(([, w]) => w && typeof w === "object").map(([k, w]) => {
        const pct = w.used_percentage ?? w.utilization ?? w.used_percent ?? 0;
        const reset = w.resets_at ? (typeof w.resets_at === "number" ? w.resets_at : Date.parse(w.resets_at) / 1000) : 0;
        const label = k === "five_hour" ? "5 часов" : k === "seven_day" ? "Неделя · все модели" : k.startsWith("seven_day") ? `Неделя · ${MODEL(k)}` : k;
        return { label, key: k === "five_hour" ? "5h" : "W", main: k === "five_hour" || k === "seven_day", minutes: k === "five_hour" ? 300 : 10080, resetAt: reset,
          pct: reset && reset * 1000 < Date.now() ? 0 : Math.round(pct), reset: resetText(reset) };
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
      const row = (w) => w && { label: windowLabel(w.window_minutes), key: w.window_minutes <= 300 ? "5h" : w.window_minutes >= 10080 ? "W" : `${Math.round(w.window_minutes / 60)}h`, main: true, minutes: w.window_minutes, resetAt: w.resets_at, pct: w.resets_at * 1000 < Date.now() ? 0 : Math.round(w.used_percent), reset: resetText(w.resets_at) };
      limits.codex = {
        plan: { prolite: "Pro", pro: "Pro", plus: "Plus", team: "Team", business: "Business" }[rl.plan_type] ?? rl.plan_type ?? "",
        rows: [row(rl.primary), row(rl.secondary)].filter(Boolean),
        credits: rl.credits?.has_credits && !rl.credits.unlimited ? Math.round(Number(rl.credits.balance)) : null,
      };
    }
  } catch {}
  // DeepSeek: бюджет ключа LiteLLM. Без litellm.json раздела нет.
  const conf = readJSON(LITELLM_CONF), budget = Number(conf?.budget);
  const LS = path.join(DATA, "litellm-status.json");
  if (conf && !fresh(LS, 900000) && !fresh(`${LS}.miss`, 900000) && !fresh(`${LS}.lock`, 120000)) { writeJSON(`${LS}.lock`, {}); later("", "", "", "bg-litellm"); }
  const ls = conf && readJSON(LS);
  if (ls && Number.isFinite(ls.spend) && budget > 0) {
    const rest = `$${Math.max(0, budget - ls.spend).toFixed(2)}`;
    limits.deepseek = { plan: "LiteLLM", rows: [{ label: `Бюджет · $${ls.spend.toFixed(2)} из $${budget}`, key: "$", main: true, minutes: 0, resetAt: 0,
      pct: Math.min(100, Math.round((ls.spend / budget) * 100)), reset: `осталось ${rest}`, note: rest,
      hint: `Расход ключа LiteLLM, лимит $${budget}${conf.period ? ` в ${conf.period}` : ""}; время сброса шлюз не сообщает` }] };
  }
  return limits;
}

// Только лимиты, для нижней строки (ygg-status): без сессии, git и PR.
if (action === "limits") { process.stdout.write(JSON.stringify(readLimits())); process.exit(0); }

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
const repo = cwd ? { folder: path.basename(cwd), parent: path.basename(path.dirname(cwd)), branch: git(cwd, ["branch", "--show-current"]) } : null;
if (repo) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]), common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  repo.worktree = Boolean(top && common && path.dirname(common) !== top);
  repo.remote = git(cwd, ["remote", "get-url", "origin"]);
}
// PR репозитория: из кэша, обновляется в фоне раз в 5 минут.
let prs = null;
if (repo?.remote) {
  const f = path.join(DATA, `prs-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`);
  prs = readJSON(f)?.list ?? null;
  if (!fresh(f, 300000) && !fresh(`${f}.lock`, 60000)) { writeJSON(`${f}.lock`, {}); later("", cwd, "", "bg-prs", repo.remote); }
}
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
if ((sessionFile || (machine && argSid)) && agent === "codex") {
  // Последний счётчик токенов из файла сессии; у Codex на сервере файл там же, читаем через hc exec
  // (Codex мог перенести файл: берём самый свежий с тем же id треда).
  const id = path.basename(sessionFile ?? "").match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? argSid;
  const raw = machine && id
    ? sh("hc", ["exec", "--on", machine, "sh", "-c", `f=$(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*-${id}.jsonl 2>/dev/null | head -n 1); [ -n "$f" ] && grep '"last_token_usage"' "$f" | tail -n 1`], 6000)
    : "";
  const e = machine ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
    : lastJSON(tail(sessionFile, 4e6), (l) => l.includes('"token_count"') && l.includes('"last_token_usage"'));
  const info = e?.payload?.info, l = info?.last_token_usage;
  if (l) {
    const codex = { cached: l.cached_input_tokens || 0, input: l.input_tokens || 0, output: l.output_tokens || 0, reasoning: l.reasoning_output_tokens || 0, session: info.total_token_usage?.total_tokens || 0 };
    context = context ? { ...context, codex } : { used: l.total_tokens, window: info.model_context_window, codex };
  }
} else if (!context && sessionFile && agent === "claude") {
  const e = lastJSON(tail(sessionFile, 4e6), (l) => l.includes('"usage"') && l.includes('"assistant"'));
  const u = e?.message?.usage;
  if (u) {
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    // ponytail: окно Claude по факту заполнения (200k или 1M); точное придёт со статусной строкой.
    context = { used, window: used > 200000 ? 1000000 : 200000, model: e.message.model };
  }
}

// Разбивка контекста Claude (кэш /context, обновляется в фоне, когда сессия сдвинулась).
let breakdown = null;
// Codex: своя разбивка из файла сессии, пересчёт в фоне, когда сдвинулся счётчик токенов.
const codexId = agent === "codex" ? (path.basename(sessionFile ?? "").match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? (machine ? argSid : "")) : "";
if (codexId) {
  const f = path.join(DATA, `ctx-codex-${codexId}.json`), c = readJSON(f);
  if (c && !c.error) breakdown = c;
  const moved = context?.used && c?.used !== context.used;
  if ((!c || (moved && !fresh(f, 20000))) && !fresh(`${f}.lock`, 30000)) { writeJSON(`${f}.lock`, {}); later("", sessionFile ?? "", "", "bg-codex-context", codexId, machine); }
}
const sid = argSid || (agent === "claude" && sessionFile ? path.basename(sessionFile, ".jsonl") : "");
if (agent === "claude" && sid && !machine) {
  const f = path.join(DATA, `ctx-${sid}.json`), c = readJSON(f);
  const moved = (() => { try { return fs.statSync(sessionFile ?? "").mtimeMs > (c?.at ?? 0); } catch { return !c; } })();
  breakdown = c;
  if ((!c || (moved && !fresh(f, 60000))) && !fresh(`${f}.lock`, 30000)) { writeJSON(`${f}.lock`, {}); later("", cwd ?? HOME, "", "bg-context", sid); }
  if (c?.used && c.window && !context?.exact) context = { used: c.used, window: c.window };
}

const limits = readLimits();

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

process.stdout.write(JSON.stringify({ agent, cwd, repo, prs, context, breakdown, limits, connectors, chat: !!chat, machine: machine || null }));
