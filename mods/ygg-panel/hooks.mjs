// ygg-panel: хуки Codex, ждущие одобрения. node hooks.mjs list <cwd> | trust <cwd> <key> <hash>
// list — хуки со статусом untrusted/modified (из hooks/list app-server Codex).
// trust — одобрение по клику пользователя: тот же путь, что у Codex, config/batchWrite в hooks.state.
import { spawn } from "node:child_process";

const [, , action, cwd = process.cwd(), key, hash] = process.argv;
const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], cwd });
let buf = "", id = 0;
const wait = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0;) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } } catch {}
  }
});
const req = (method, params) => new Promise((r) => { const n = ++id; wait.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const done = (out) => { process.stdout.write(JSON.stringify(out)); p.kill(); process.exit(0); };
setTimeout(() => done({ ok: false, error: "timeout" }), 20000);

await req("initialize", { clientInfo: { name: "ygg-panel", version: "0" }, capabilities: { experimentalApi: true } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");

if (action === "trust") {
  const r = await req("config/batchWrite", { edits: [{ keyPath: "hooks.state", value: { [key]: { trusted_hash: hash } }, mergeStrategy: "upsert" }] });
  done(r.error ? { ok: false, error: r.error.message } : { ok: true });
}
const r = await req("hooks/list", { cwds: [cwd] });
const all = (r.result?.data ?? []).flatMap((x) => x.hooks ?? []);
done(all.filter((h) => h.trustStatus === "modified" || h.trustStatus === "untrusted").map((h) => ({
  key: h.key, hash: h.currentHash, status: h.trustStatus, event: h.eventName,
  plugin: h.pluginId ?? null, source: h.sourcePath ?? h.key.split(":")[0], tip: h.statusMessage ?? null,
})));
