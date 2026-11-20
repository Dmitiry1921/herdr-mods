// ygg-new: первый ход нового чата herdr-chat. node start.mjs <chat> <model|""> <mode> <text>
// Ждёт, пока хост чата запишет своё состояние, подключается по WebSocket с его токеном,
// ставит модель и режим и отправляет текст. Итог — строка JSON в stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , chat, model, mode, text] = process.argv;
const file = path.join(os.homedir(), ".config/herdr-app/data/herdr-chat/chats", `${chat}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let st = null;
for (let i = 0; i < 80 && !st?.wsPort; i++) { try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch {} if (!st?.wsPort) await sleep(500); }
if (!st?.wsPort) { process.stdout.write(JSON.stringify({ ok: false, error: "чат не запустился" })); process.exit(0); }

const ws = new WebSocket(`ws://127.0.0.1:${st.wsPort}`);
const waiting = new Map();
let n = 0, ready, modelNow = null, sent = false, alive = false;
const snapshot = new Promise((r) => { ready = r; });
const req1 = (op, args = {}) => new Promise((resolve) => {
  const id = `y${++n}`;
  waiting.set(id, resolve);
  ws.send(JSON.stringify({ t: "req", id, op, ...args }));
  setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, error: "timeout" }); }, 3000);
});
// Агент в хосте поднимается не сразу: запросы до этого отказывают, поэтому повторяем.
const req = async (op, args = {}) => {
  let r;
  for (let i = 0; i < 4; i++) { r = await req1(op, args); if (r.ok) return r; await sleep(1000); }
  return r;
};
ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: st.token, client: "ygg-new" }));
ws.onclose = () => { process.stdout.write(JSON.stringify({ ok: false, error: "чат закрылся" })); process.exit(0); };
ws.onmessage = (m) => {
  const r = JSON.parse(m.data);
  if (r.t === "snapshot") { ready(r.state); modelNow = r.state?.model?.id ?? modelNow; /* модель уже нужная: патча о смене не будет */ if (r.state?.agentVersion || (r.state?.phase && r.state.phase !== "starting")) alive = true; }
  if (r.t === "patch" && (r.state?.agentVersion || (r.state?.phase && r.state.phase !== "starting"))) alive = true;
  if (r.t === "patch" && r.state?.model?.id) modelNow = r.state.model.id;
  if (r.t === "patch" && (r.upsert ?? []).some((it) => it.kind === "user")) sent = true;
  if (r.t === "res" && waiting.has(r.id)) { waiting.get(r.id)(r); waiting.delete(r.id); }
};
await Promise.race([snapshot, sleep(15000)]);
// Запросы до старта агента в хосте отказывают: ждём его версию или выход из фазы starting.
for (let i = 0; i < 60 && !alive; i++) await sleep(250);

const out = { ok: true, steps: {} };
if (model) {
  const list = (await req("models")).data;
  const all = (Array.isArray(list) ? list : list?.models ?? []).filter((m) => m.enabled !== false);
  const hit = all.find((m) => m.id === model) ?? all.find((m) => String(m.id).includes(model));
  // set_model меняет модель, но ответа не присылает: засчитываем по пришедшему патчу состояния.
  if (hit) { req1("set_model", { provider: hit.provider, modelId: hit.id }); for (let i = 0; i < 20 && modelNow !== hit.id; i++) await sleep(250); }
  out.steps.model = hit ? modelNow === hit.id : `нет в списке: ${all.map((m) => m.id).join(", ")}`;
}
if (mode) out.steps.mode = (await req("set_permission_mode", { mode })).ok;
// send тоже не отвечает: отправляем один раз (повтор задвоит задание) и ждём сообщение в чате.
if (text) { req1("send", { text }); for (let i = 0; i < 40 && !sent; i++) await sleep(250); out.steps.send = sent; }
// У Codex агент поднимается с первым сообщением: режим, не вставший до него, ставим после.
if (mode && !out.steps.mode) out.steps.mode = (await req("set_permission_mode", { mode })).ok;
ws.onclose = null; ws.close();
process.stdout.write(JSON.stringify(out));
process.exit(0);
