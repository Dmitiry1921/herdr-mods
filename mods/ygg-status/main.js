// Нижняя строка Herdr: лимиты Claude и Codex всегда на виду, подробности в правой панели («Лимиты»).
// Вместо встроенного workspace-status: «This computer · N agents» убраны, подсказка палитры осталась.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, keys, appHome, exec, openOverlay, updates } from "herdr";

const YELLOW = "#f5cd47";
const alpha = (c, a) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
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
    this.upd = null; // {behind, log} — новые версии модов на GitHub
    this.updating = false;
    this.fetch(cx);
    cx.timer.every(30000, (cx) => this.fetch(cx));
    this.check(cx);
    cx.timer.every(120000, (cx) => this.check(cx));
  }

  // Новые версии модов на GitHub: ставятся только кнопкой, пока ты не нажал, ничего не перезагружается.
  check(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${appHome()}/mods/ygg-status/update.sh`, "check"], { timeout: 30000 });
        const u = JSON.parse(r.stdout || "null");
        if (u && JSON.stringify(u) !== JSON.stringify(this.upd)) { this.upd = u; cx.notify(); }
      } catch {}
    });
  }

  update(cx) {
    if (this.updating) return;
    this.updating = true;
    cx.notify();
    cx.spawn(async (cx) => {
      // После установки этот мод перезагрузится сам; если в нём ничего не поменялось — снимаем кнопку здесь.
      await exec("sh", [`${appHome()}/mods/ygg-status/update.sh`, "apply"], { timeout: 120000 }).catch(() => {});
      this.updating = false;
      this.upd = null;
      cx.notify();
    });
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
      .child(image(`mods/ygg-sidebar/icons/${kind === "deepseek" ? "deepseek-badge" : kind}.svg`).size(12))
      .children(rows.map((r) => this.meter(kind, r, t)))
      .when(L?.credits != null, (el) => el.child(h_flex().id(`credits-${kind}`).gap(4).items_center().tooltip(`Кредиты ${NAME[kind]}: ${L.credits}`)
        .child(svg("mods/ygg-status/icons/coins.svg").size(13).text_color(YELLOW)).child(div().text_color(t.foreground).child(String(L.credits)))));
  }

  render() {
    const t = theme(), L = this.limits ?? {};
    const groups = ["claude", "codex", "deepseek"].map((k) => this.agent(k, L[k], t)).filter(Boolean);
    const sep = () => div().w(1).h(14).bg(t.border);
    // Настройки — одна шестерёнка слева: в окне и Herdr, и добавить машину. Точка — готово обновление Herdr.
    const gear = h_flex().id("settings").relative().size(22).items_center().justify_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Настройки. Клик — открыть настройки")
      .on_click(() => openOverlay({ mod: "ygg-settings", kind: "dialog", width: 640, height: 560 }))
      .child(svg("mods/ygg-sidebar/icons/settings.svg").size(14).text_color(t.muted))
      .when(Boolean(updates()?.app?.ready), (el) => el.child(div().absolute().top(2).right(2).size(6).rounded_full().bg(t.accent)));
    const n = this.upd?.behind ?? 0;
    const tipUpd = `Обновление интерфейса: ${n} ${n % 10 === 1 && n % 100 !== 11 ? "изменение" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "изменения" : "изменений"}`
      + `${this.upd?.log?.length ? `\n${this.upd.log.map((x) => `• ${x.split(":")[0]}`).join("\n")}` : ""}`
      + "\nКлик — поставить. Панели перезагрузятся: допиши сообщение до клика";
    const upd = n > 0 || this.updating ? h_flex().id("ygg-update").h(20).px(8).gap(5).items_center().rounded(10).cursor_pointer()
      .bg(alpha(t.accent, 0.18)).text_color(t.accent).hover((s) => s.bg(alpha(t.accent, 0.28)))
      .tooltip(this.updating ? "Ставлю обновление" : tipUpd).on_click((_e, cx) => this.update(cx))
      .child(svg("mods/ygg-status/icons/download.svg").size(12)).child(this.updating ? "Обновляю…" : "Обновить") : null;
    return h_flex().size_full().pl(8).pr(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(gear)
      .when(Boolean(upd), (el) => el.child(upd))
      .child(div().flex_1())
      .children(groups.flatMap((g, i) => (i ? [sep(), g] : [g])))
      .when(groups.length > 0, (el) => el.child(sep()))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().tooltip("Палитра команд. Клик — открыть").on_click(() => run("app.palette")).child(this.hint()));
  }
}
