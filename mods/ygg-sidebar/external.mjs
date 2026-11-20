// ygg-sidebar: сессии агентов, начатые вне Herdr (приложение Claude, приложение и CLI Codex), чтобы левая панель
// показывала их рядом со своими и открывала здесь.
//   node external.mjs [машина…]   → {"mac": {items, known}, "machines": {"<имя>": {items}}}
//   node external.mjs --here      → {items, known} этой машины (так скрипт гоняется на сервере через hc exec)
// items: {kind, id, title, cwd, at, born, busy, parent}. born — когда сессия заведена (панель ставит старые выше новых). busy — сессия сейчас открыта приложением Claude (процесс с её id);
// parent — id сессии Claude, из которой эта запущена (боковые сессии), панель вкладывает её под родителя.
// known: [{chat, id}] сессии чатов Herdr (состояния herdr-chat). Панель прячет только те, чья вкладка сейчас открыта:
// состояние остаётся и после закрытия вкладки (⌘W), а сессия должна вернуться в список.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const H = os.homedir();
// Все неархивные сессии, как в списках Codex и Claude: лишнее панель прячет под «Показать больше».
const since = 0;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Название треда Codex: имя, которое дал Codex, иначе первая строка запроса без служебной шапки про вложения.
const nice = (name, title) => {
  if (name) return name;
  let t = String(title ?? "");
  const m = t.indexOf("## My request:");
  if (m >= 0) t = t.slice(m + 14);
  return t.replace(/\s+/g, " ").trim().slice(0, 90) || "Без названия";
};

// Треды Codex: без субагентов и ревьюеров ({subagent…}), без запусков codex exec (автоматизации) и пустых (ни одного сообщения).
function codex() {
  const dbs = fs.readdirSync(path.join(H, ".codex")).filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!dbs.length) return [];
  process.removeAllListeners("warning");
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite"); // Node 22.5+, без флагов в 24
  const db = new DatabaseSync(path.join(H, ".codex", dbs[0]), { readOnly: true });
  const rows = db.prepare("select id, name, title, cwd, updated_at, created_at from threads where archived = 0 and (first_user_message <> '' or title <> '') and source not like '{%' and source <> 'exec' and coalesce(originator, '') <> 'codex_exec' and updated_at >= ? order by updated_at desc limit 300")
    .all(Math.floor(since / 1000));
  return rows.map((r) => ({ kind: "codex", id: r.id, title: nice(r.name, r.title), cwd: r.cwd, at: r.updated_at * 1000, born: (r.created_at ?? r.updated_at) * 1000, busy: false }));
}

function claude() {
  const root = path.join(H, "Library/Application Support/Claude/claude-code-sessions");
  if (!fs.existsSync(root)) return [];
  let ps = "";
  try { ps = execFileSync("ps", ["-axo", "command"], { maxBuffer: 1 << 24 }).toString(); } catch {}
  const running = new Set([...ps.matchAll(/--(?:resume|session-id)[= ]([0-9a-f-]{36})/g)].map((m) => m[1]));
  const out = [], cli = new Map();
  for (const a of fs.readdirSync(root)) for (const b of fs.readdirSync(path.join(root, a)).filter((x) => !x.startsWith("."))) {
    const dir = path.join(root, a, b);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^local_.*\.json$/.test(x))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        const at = s.lastActivityAt ?? s.createdAt ?? 0;
        if (s.cliSessionId) cli.set(s.sessionId, s.cliSessionId);
        if (s.isArchived || at < since || !s.cliSessionId || !s.cwd) continue;
        out.push({ kind: "claude", id: s.cliSessionId, title: s.title || "Без названия", cwd: s.cwd, at, born: s.createdAt ?? at, busy: running.has(s.cliSessionId), from: s.spawnedFrom?.sessionId ?? null });
      } catch {}
    }
  }
  for (const e of out) { e.parent = cli.get(e.from) ?? null; delete e.from; }
  return out;
}

// Сессии DeepSeek Harness (~/.dsh/sessions/<папка>/session-<uuid>/session.v4.jsonl.zstd): каждая запись — свой кадр zstd,
// CLI zstd читает их подряд. Папка и название — из записей session и session/title; без сообщений пользователя не показываем.
function dsh() {
  const root = path.join(process.env.DSH_HOME ?? path.join(H, ".dsh"), "sessions");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const a of fs.readdirSync(root)) for (const b of fs.readdirSync(path.join(root, a)).filter((x) => x.startsWith("session-"))) {
    const file = path.join(root, a, b, "session.v4.jsonl.zstd");
    try {
      const st = fs.statSync(file), at = st.mtimeMs;
      if (at < since) continue;
      const recs = execFileSync("zstd", ["-dcq", file], { maxBuffer: 1 << 26, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } }).toString().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const cwd = recs.find((r) => r.type === "session")?.cwd;
      const first = recs.find((r) => r.type === "user/message");
      if (!cwd || !first) continue;
      const title = recs.findLast((r) => r.type === "session/title" && r.data?.title)?.data?.title
        ?? first.data?.message?.content?.find?.((c) => c.type === "text")?.text;
      out.push({ kind: "deepseek", id: b.slice(8), title: nice(null, title), cwd, at, born: st.birthtimeMs || at, busy: false });
    } catch {}
  }
  return out;
}

function known() {
  const dir = path.join(H, ".config/herdr-app/data/herdr-chat/chats");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        for (const v of [s.sessionFile, s.session, s.sessionId, s.threadId]) { const m = String(v ?? "").match(UUID); if (m) out.push({ chat: s.chat, id: m[0] }); }
      } catch {}
    }
  } catch {}
  return out;
}

const here = () => {
  const items = [];
  for (const f of [codex, claude, dsh]) { try { items.push(...f()); } catch {} }
  return { items, known: known() };
};

if (process.argv.includes("--here")) {
  process.stdout.write(JSON.stringify(here()));
  process.exit(0);
}
const me = fs.readFileSync(new URL(import.meta.url), "utf8");
const PATH = `/opt/homebrew/bin:/usr/local/bin:${H}/.local/bin:/usr/bin:/bin`;
const machines = {};
for (const m of process.argv.slice(2).filter((x) => !x.startsWith("-"))) {
  try {
    const raw = execFileSync("hc", ["exec", "--on", m, "sh", "-c", 'exec node --input-type=module -e "$0" -- --here', me],
      { env: { ...process.env, PATH }, timeout: 20000, maxBuffer: 1 << 24 }).toString();
    machines[m] = JSON.parse(raw);
  } catch { machines[m] = null; }
}
process.stdout.write(JSON.stringify({ mac: here(), machines }));
