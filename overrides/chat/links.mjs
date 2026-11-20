// Связи сессии чата с задачами и PR: рабочие у Yggdrasil, личные у Ariadne. Оба моста локальные, секрет Yggdrasil
// читается здесь, из его config.json, и наружу не выходит.
//   node links.mjs get <id сессии>              → {"work": {...}|null, "personal": {...}|null}
//   node links.mjs open <url>                  → открыть ссылку через Yggdrasil (Loop в открытом Loop), иначе системой
//   node links.mjs wait <postId> pause|resume|stop
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const YGG = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/jira-claude-board/config.json"), "utf8"));
    return c.secret ? { base: `http://127.0.0.1:${c.port ?? 47321}`, headers: { "x-board-secret": c.secret } } : null;
  } catch { return null; }
})();
const ARIADNE = "http://127.0.0.1:47400";

const get = async (url, headers = {}) => {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const post = async (url) => {
  try {
    const r = await fetch(url, { method: "POST", headers: YGG?.headers ?? {}, signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch { return null; }
};

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "get" && a) {
  const id = encodeURIComponent(a);
  const [work, personal] = await Promise.all([
    YGG ? get(`${YGG.base}/session-links/${id}`, YGG.headers) : null,
    get(`${ARIADNE}/session-links?id=${id}`),
  ]);
  // Иконки Jira и аватарки Loop приходят строкой SVG (часто с картинкой внутри): плашке нужен файл под
  // ~/.config/herdr-app, поэтому каждая пишется один раз в data/chat-links по хэшу содержимого.
  const dir = path.join(os.homedir(), ".config/herdr-app/data/chat-links");
  const asset = (svg) => {
    if (!svg) return null;
    const m = svg.match(/href="data:image\/(png|svg\+xml);base64,([^"]+)"/);
    const ext = m ? (m[1] === "png" ? "png" : "svg") : "svg";
    const name = `${createHash("sha1").update(svg).digest("hex").slice(0, 16)}.${ext}`;
    const file = path.join(dir, name);
    try {
      if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, m ? Buffer.from(m[2], "base64") : svg); }
      return `data/chat-links/${name}`;
    } catch { return null; }
  };
  for (const t of [...(work?.tasks ?? []), ...(work?.linked ?? [])]) { t.typeImg = asset(t.typeSvg); t.priorityImg = asset(t.prioritySvg); delete t.typeSvg; delete t.prioritySvg; }
  for (const t of work?.threads ?? []) { t.avatarImg = asset(t.avatarSvg); delete t.avatarSvg; }
  process.stdout.write(JSON.stringify({ work, personal }));
} else if (cmd === "open" && a) {
  const r = YGG ? await post(`${YGG.base}/go/open?u=${encodeURIComponent(a)}`) : null;
  if (!r?.ok) execFileSync("open", [a]);
} else if (cmd === "wait" && a && ["pause", "resume", "stop"].includes(b)) {
  if (YGG) await post(`${YGG.base}/loop/waits/${encodeURIComponent(a)}/${b}`);
}
