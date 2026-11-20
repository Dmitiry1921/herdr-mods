// Нижняя строка Herdr: лимиты Claude и Codex всегда на виду, подробности в правой панели («Лимиты»).
// Вместо встроенного workspace-status: «This computer · N agents» убраны, подсказка палитры осталась.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, keys, appHome, exec } from "herdr";

const YELLOW = "#f5cd47";
const NAME = { claude: "Claude", codex: "Codex", deepseek: "DeepSeek (LiteLLM)" };
const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
const WD = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];

// До сброса: «45м», «2ч30», «4д 23ч».
const left = (sec) => {
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  return m < 60 ? `${m}м` : m < 1440 ? `${Math.floor(m / 60)}ч${String(m % 60).padStart(2, "0")}` : `${Math.floor(m / 1440)}д ${Math.floor((m % 1440) / 60)}ч`;
};
const when = (sec) => { const d = new Date(sec * 1000); return `${d - Date.now() < 864e5 ? "сегодня" : `в ${WD[d.getDay()]}`} в ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class YggStatus extends View {
  init(_p, cx) {
    this.limits = null;
    this.fetch(cx);
    cx.timer.every(30000, (cx) => this.fetch(cx));
  }

  fetch(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/collect.mjs`, "", "", "", "limits"], { timeout: 15000 });
        const l = JSON.parse(r.stdout || "null");
        const key = (x) => JSON.stringify(x, (k, v) => (k === "at" ? undefined : v));
        if (l && key(l) !== key(this.limits)) { this.limits = l; cx.notify(); }
      } catch {}
    });
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : "commands";
  }

  // Полоска: заливка — израсходовано; белая засечка — сколько ушло бы к этому моменту при ровной трате до сброса.
  // Заливка нейтральная (агента различает цветной логотип), жёлтая — правее засечки больше чем на 15 пунктов или от 90%:
  // при таком темпе до сброса не хватит.
  meter(kind, r, t) {
    const pace = r.resetAt && r.minutes ? Math.min(100, Math.max(0, 100 - ((r.resetAt * 1000 - Date.now()) / 60000 / r.minutes) * 100)) : null;
    const hot = r.pct >= 90 || (pace != null && r.pct - pace > 15);
    const color = hot ? YELLOW : t.muted;
    const W = 40;
    const track = div().relative().w(W).h(4).rounded(2).bg(t.border)
      .child(div().absolute().left(0).top(0).h(4).rounded(2).w((W * Math.min(r.pct, 100)) / 100).bg(color))
      .when(pace != null, (el) => el.child(div().absolute().top(-3).h(10).w(1.5).left(Math.min(W - 1.5, (W * pace) / 100)).bg(t.foreground)));
    const tip = `${NAME[kind]}, ${r.key === "5h" ? "5 часов" : r.key === "W" ? "неделя" : r.label}: израсходовано ${r.pct}%`
      + (pace != null ? `, по ровному темпу было бы ${Math.round(pace)}%` : "")
      + (r.resetAt ? `. Сброс ${when(r.resetAt)}` : "") + (r.note ? `, осталось ${r.note}` : "") + (r.hint ? `. ${r.hint}` : "") + ". Клик — лимиты в панели";
    return h_flex().id(`lim-${kind}-${r.key}`).gap(5).items_center().cursor_pointer().tooltip(tip).on_click(() => this.open())
      .child(div().text_size(11).text_color(t.muted).child(r.key))
      .child(track)
      .child(div().text_color(hot ? YELLOW : t.foreground).child(`${r.pct}%`))
      .when(Boolean(r.resetAt), (el) => el.child(div().text_size(11).text_color(t.dim).child(left(r.resetAt))))
      .when(Boolean(r.note), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.note)));
  }

  open() { run("layout.show", { id: "panel" }); run("layout.select", { stack: "panel-body", child: "summary" }); }

  agent(kind, L, t) {
    const rows = (L?.rows ?? []).filter((r) => r.main);
    if (!rows.length && L?.credits == null) return null;
    return h_flex().gap(10).items_center()
      .child(image(`mods/ygg-sidebar/icons/${kind}.svg`).size(12))
      .children(rows.map((r) => this.meter(kind, r, t)))
      .when(L?.credits != null, (el) => el.child(h_flex().id(`credits-${kind}`).gap(4).items_center().tooltip(`Кредиты ${NAME[kind]}: ${L.credits}`)
        .child(svg("mods/ygg-status/icons/coins.svg").size(13).text_color(YELLOW)).child(div().text_color(t.foreground).child(String(L.credits)))));
  }

  render() {
    const t = theme(), L = this.limits ?? {};
    const groups = ["claude", "codex", "deepseek"].map((k) => this.agent(k, L[k], t)).filter(Boolean);
    const sep = () => div().w(1).h(14).bg(t.border);
    return h_flex().size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(div().flex_1())
      .children(groups.flatMap((g, i) => (i ? [sep(), g] : [g])))
      .when(groups.length > 0, (el) => el.child(sep()))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().tooltip("Палитра команд. Клик — открыть").on_click(() => run("app.palette")).child(this.hint()));
  }
}
