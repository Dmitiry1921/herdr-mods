// Диктовка с текстом по ходу речи. node dictate.mjs <base>
// ffmpeg пишет микрофон в <base>.pcm, whisper-server держит модель в памяти и раз в долю секунды
// распознаёт всё записанное: текст лежит в <base>.txt и растёт, пока говоришь.
// Файл <base>.stop — остановить: последний проход, <base>.done. Ошибка — <base>.err.
// Общий для чата (overrides/chat/composer.js) и окна новой сессии (ygg-new).
// ponytail: каждый проход распознаёт запись целиком (минута речи ~2 с на M4); если станет медленно — фиксировать готовые куски.
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const base = process.argv[2];
const H = os.homedir();
const PATH = `/opt/homebrew/bin:/usr/local/bin:${H}/.local/bin:/usr/bin:/bin`;
const env = { ...process.env, PATH };
// DICTATE_FILE: вместо микрофона файл в реальном времени (проверка без голоса).
const MODEL = `${H}/.cache/whisper-cpp/ggml-large-v3-turbo.bin`;
const RATE = 16000, BYTES = 2; // моно, 16 бит
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const put = (ext, s) => { fs.writeFileSync(`${base}.${ext}.tmp`, s); fs.renameSync(`${base}.${ext}.tmp`, `${base}.${ext}`); };
for (const e of ["pcm", "txt", "stop", "done", "err", "lvl"]) fs.rmSync(`${base}.${e}`, { force: true });

const port = 47600 + Math.floor(Math.random() * 300);
const server = spawn("whisper-server", ["-m", MODEL, "-l", "ru", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore" });
const mic = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...(process.env.DICTATE_FILE ? ["-re", "-i", process.env.DICTATE_FILE] : ["-f", "avfoundation", "-i", ":default"]), "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-flush_packets", "1", "-y", `${base}.pcm`], { env, stdio: ["ignore", "ignore", "pipe"] });
let micErr = "";
mic.stderr.on("data", (d) => { micErr += d; });
const micDone = new Promise((r) => mic.on("exit", r));
const end = (err) => {
  if (err) put("err", err);
  try { server.kill(); } catch {}
  try { mic.kill("SIGINT"); } catch {}
  fs.rmSync(`${base}.pcm`, { force: true });
  fs.rmSync(`${base}.lvl`, { force: true });
  put("done", "1");
  process.exit(0);
};
setTimeout(() => end("Запись дольше 15 минут"), 15 * 60000).unref();

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * BYTES, 28); h.writeUInt16LE(BYTES, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function hear() {
  let pcm;
  try { pcm = fs.readFileSync(`${base}.pcm`); } catch { return null; }
  pcm = pcm.subarray(0, pcm.length - (pcm.length % BYTES));
  if (pcm.length < RATE * BYTES * 0.3) return { len: pcm.length, text: "" };
  const form = new FormData();
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "a.wav");
  form.append("response_format", "text");
  const r = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form });
  const text = (await r.text()).replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  return { len: pcm.length, text };
}

// Громкость для волны под полем ввода: раз в 80 мс RMS последних 50 мс записи, последние 48 значений 0..1 в <base>.lvl.
const levels = [];
setInterval(() => {
  try {
    const fd = fs.openSync(`${base}.pcm`, "r");
    try {
      const size = fs.fstatSync(fd).size, n = Math.min(size - (size % BYTES), RATE * BYTES * 0.05);
      const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - (size % BYTES) - n);
      let sum = 0; for (let i = 0; i < n; i += 2) { const v = b.readInt16LE(i) / 32768; sum += v * v; }
      levels.push(Math.min(1, Math.sqrt(sum / Math.max(1, n / 2)) * 6));
    } finally { fs.closeSync(fd); }
  } catch { levels.push(0); }
  if (levels.length > 48) levels.shift();
  try { put("lvl", levels.map((x) => x.toFixed(2)).join(",")); } catch {}
}, 80).unref();

// Модель грузится около секунды: пока её нет, запись уже идёт.
let up = false;
for (let i = 0; i < 120 && !up; i++) { try { await fetch(`http://127.0.0.1:${port}/`); up = true; } catch { await sleep(100); } }
if (!up) end("Не поднялся whisper-server");

let last = 0;
while (!fs.existsSync(`${base}.stop`)) {
  if (mic.exitCode !== null) { if (!last) end(micErr.trim() ? "Нет записи: разреши Herdr микрофон в настройках macOS" : "Запись оборвалась"); break; }
  let size = 0;
  try { size = fs.statSync(`${base}.pcm`).size; } catch {}
  if (size - last >= RATE * BYTES * 0.4) {
    try { const h = await hear(); if (h) { last = h.len; put("txt", h.text); } } catch {}
  } else await sleep(150);
}
mic.kill("SIGINT");
await Promise.race([micDone, sleep(2000)]);
try { const h = await hear(); if (h) put("txt", h.text); } catch {}
end(fs.existsSync(`${base}.txt`) && fs.readFileSync(`${base}.txt`, "utf8") ? null : "Не расслышал");
