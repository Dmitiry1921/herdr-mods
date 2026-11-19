// ygg-sidebar: операции с сессией агента. Итог — строка JSON в stdout.
//   node session-ops.mjs find <claude|codex> <id>      путь к файлу сессии по id
//   node session-ops.mjs fork <claude|codex> <id> <cwd> новая сессия-копия, путь к её файлу
//   node session-ops.mjs archive|unarchive codex <id>   архив в самом Codex (thread/archive), как кнопка в его приложении
// Codex: форк через app-server (thread/fork), как в самом Codex. Claude: как claude --fork-session,
// копия переписки с новым sessionId рядом с исходной.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const [, , op, kind, id, cwd = os.homedir()] = process.argv;
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const HOME = os.homedir();

const find = () => {
  if (id.startsWith("/")) return fs.existsSync(id) ? id : null;
  const cmd = kind === "claude"
    ? `ls "${HOME}"/.claude/projects/*/"${id}".jsonl 2>/dev/null | head -1`
    : `ls "${HOME}"/.codex/sessions/*/*/*/rollout-*-"${id}".jsonl "${HOME}"/.codex/archived_sessions/rollout-*-"${id}".jsonl 2>/dev/null | head -1`;
  return execFileSync("sh", ["-c", cmd]).toString().trim() || null;
};

const file = find();
if (op === "find") out({ ok: Boolean(file), path: file });
if (!["fork", "archive", "unarchive"].includes(op)) out({ ok: false, error: `неизвестная операция ${op}` });
if (!file) out({ ok: false, error: "файл сессии не найден" });

if (op === "fork" && kind === "claude") {
  const old = path.basename(file, ".jsonl"), fresh = randomUUID();
  const text = fs.readFileSync(file, "utf8").split(`"sessionId":"${old}"`).join(`"sessionId":"${fresh}"`);
  const dest = path.join(path.dirname(file), `${fresh}.jsonl`);
  fs.writeFileSync(dest, text);
  out({ ok: true, path: dest });
}

const thread = path.basename(file, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)?.[1];
const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], cwd });
let buf = "", n = 0;
const wait = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } } catch {}
  }
});
const req = (method, params) => new Promise((r) => { const k = ++n; wait.set(k, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n"); });
setTimeout(() => { p.kill(); out({ ok: false, error: "timeout" }); }, 30000);
await req("initialize", { clientInfo: { name: "ygg-sidebar", version: "0" }, capabilities: { experimentalApi: true } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
if (op !== "fork") { const a = await req(`thread/${op}`, { threadId: thread }); p.kill(); out(a.error ? { ok: false, error: a.error.message } : { ok: true }); }
const r = await req("thread/fork", { threadId: thread });
p.kill();
const t = r.result?.thread;
out(t ? { ok: true, path: t.path ?? t.rolloutPath ?? null, id: t.id } : { ok: false, error: r.error?.message ?? "нет ответа" });
