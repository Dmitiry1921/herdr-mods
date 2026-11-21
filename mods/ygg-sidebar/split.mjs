// ygg-sidebar: чат рядом с открытым, в любую сторону, и ровные доли панелей. Итог — строка JSON в stdout.
//   node split.mjs <right|left|down|up> '<props чата>'   новая панель рядом с панелью в фокусе
//   node split.mjs grid '<props чата>'                  в сетку: делится самая большая панель вкладки по длинной стороне
//   node split.mjs even                                 выровнять панели вкладки в фокусе
// Herdr делит только вправо и вниз и режет панель пополам (шестая выходит в 1/32): влево и вверх — деление и
// pane.swap с исходной, после деления доли соседей по ряду или колонке выравниваются (layout.resize weight 1).
import os from "node:os";
import { execFileSync } from "node:child_process";

const BIN = `${os.homedir()}/.local/bin/herdr-app`;
const HC = `${os.homedir()}/.local/bin/hc`;
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const herdr = (...args) => {
  const r = JSON.parse(execFileSync(BIN, args, { encoding: "utf8" }) || "{}");
  if (r.error) throw new Error(r.error);
  return r;
};
const doc = () => {
  const req = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const raw = execFileSync(HC, ["connect"], { input: `${req(1, "hello", { generation: 1 })}\n${req(2, "doc.get", { name: "herdr-app" })}\n`, encoding: "utf8" });
  for (const l of raw.split("\n")) { try { const m = JSON.parse(l); if (m.id === 2) return m.result?.value ?? null; } catch {} }
  return null;
};
// Ряд или колонка, где стоит панель, и вкладка с ней.
const place = (d, pane) => {
  let hit = null;
  const walk = (n, parent, tab) => {
    if (!n || hit) return;
    if (n.id === pane) hit = { parent, tab };
    for (const c of n.children ?? []) walk(c, n, tab);
  };
  for (const s of d?.spaces ?? []) for (const t of s.tabs ?? []) walk(t.root, null, t);
  return hit;
};
const even = (group) => { for (const c of group?.children ?? []) herdr("do", "layout.resize", "--id", c.id, "--weight", "1"); };

// at — панель, от которой делить (по умолчанию в фокусе); props "-" — терминал вместо чата (проверка раскладки).
const [, , dir, props, at] = process.argv;
try {
  const focused = at || herdr("status").focused_pane;
  if (!focused) out({ ok: false, error: "нет панели в фокусе" });
  if (dir === "even") {
    // Все ряды и колонки вкладки, вложенные тоже.
    const t = place(doc(), focused)?.tab;
    const walk = (n) => { if (n?.children?.length) { even(n); n.children.forEach(walk); } };
    walk(t?.root);
    out({ ok: true });
  }
  let from = focused;
  let side = dir;
  if (dir === "grid") {
    // Прямоугольники панелей по долям из документа, окно условно 16:10; самая большая делится по длинной стороне:
    // 2 панели — рядом, 4 — 2×2, 6 — 3×2.
    const t = place(doc(), focused)?.tab;
    let best = null;
    const walk = (n, w, h) => {
      const kids = n?.children ?? [];
      if (!kids.length) { if (n && (!best || w * h > best.w * best.h + 1e-9)) best = { id: n.id, w, h }; return; }
      const sum = kids.reduce((a, c) => a + (c.size?.weight ?? 1), 0) || 1;
      for (const c of kids) { const k = (c.size?.weight ?? 1) / sum; n.type === "column" ? walk(c, w, h * k) : walk(c, w * k, h); }
    };
    walk(t?.root, 16, 10);
    if (best) { from = best.id; side = best.w >= best.h ? "right" : "down"; }
    else side = "right";
  }
  if (!["right", "left", "down", "up"].includes(side)) out({ ok: false, error: `неизвестная сторона ${dir}` });
  const split = side === "left" ? "right" : side === "up" ? "down" : side;
  const { pane } = herdr("do", "pane.split", "--pane", from, "--direction", split, ...(props === "-" ? [] : ["--mod", "chat", "--props", props ?? "{}"]));
  if (side === "left" || side === "up") herdr("do", "pane.swap", "--pane", pane, "--target", from);
  even(place(doc(), pane)?.parent);
  out({ ok: true, pane });
} catch (e) {
  out({ ok: false, error: String(e.message ?? e) });
}
