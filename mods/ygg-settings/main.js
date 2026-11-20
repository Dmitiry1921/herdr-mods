// ygg-settings: окно настроек левой панели вместо правки projects.json руками.
// Проекты: имя в панели (одинаковое имя у двух проектов = один проект), группа, иконка, цвет, сколько сессий видно.
// Группы: добавить, убрать. Пишет в тот же projects.json, панель подхватывает его сама за пару секунд.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Scrollbar } from "gpui-base";
import { spaces, theme, appHome, readTextFile, writeTextFile, props, closeOverlay } from "herdr";

// Тонкая полоса прокрутки (3 px) вместо широкой встроенной: область прокручивается сама (overflow_y_scroll),
// полоса — Scrollbar того же id в узкой колонке справа (он заполняет свой контейнер).
const thin = (id, el, fill) => div().relative().w_full().flex().flex_col()
  .when(fill === "full", (d) => d.size_full().min_h(0)).when(fill === true, (d) => d.flex_1().min_h(0))
  .child(el)
  .child(Scrollbar.vertical(id).absolute().top(2).bottom(2).right(0).w(3));

const ICONS = "mods/ygg-sidebar/icons";
const CONFIG = () => `${appHome()}/data/ygg-sidebar/projects.json`;
const KNOWN = () => `${appHome()}/data/ygg-sidebar/known.json`;
const PICK_ICONS = [
  "folder", "code", "terminal", "command", "git-branch", "bug", "database", "server", "cloud", "cpu", "bot", "brain", "sparkles", "wrench",
  "box", "boxes", "gamepad-2", "joystick", "dices", "puzzle", "rocket", "palette", "pen-tool", "image", "camera", "clapper", "music", "headphones",
  "plane", "train", "car", "bike", "globe", "map-pin", "home", "briefcase", "chart-line", "wallet", "piggy", "shopping-cart", "mail", "calendar", "chat", "users",
  "book", "graduation-cap", "flask-conical", "heart", "star", "zap", "shield", "leaf", "paw", "coffee", "utensils", "dumbbell", "smartphone", "monitor",
];
const COLORS = [
  "#579dff", "#388bff", "#7a9dff", "#6cc3e0", "#60c6d2", "#9f8fef", "#8f7ee7", "#e774bb", "#f87fb0", "#f87168", "#ef5c48", "#d97757",
  "#fea362", "#f5cd47", "#e2b203", "#b3df72", "#94c748", "#4bce97", "#2abb7f", "#1f845a", "#8590a2", "#9fadbc", "#c7d1db", "#ae8e6a",
];
const NO_GROUP = "Без группы";

export default class Settings extends View {
  init(_p, cx) {
    this.cfg = { groups: [], projects: {} };
    this.known = {};
    this.open = null;      // { title, what: "icon" | "color" | "group" }: раскрытый выбор под строкой
    this.editing = null;   // имя проекта, которое правится, или "+group"
    this.newGroupFor = props()?.newGroupFor ?? null; // из меню проекта «Группа › Новая группа»
    this.input = InputState.new({ placeholder: "Название" });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("blur", (_e, cx) => this.commit(cx));
    cx.spawn(async (cx) => {
      try { this.cfg = { groups: [], projects: {}, ...JSON.parse((await readTextFile(CONFIG())) ?? "{}") }; } catch {}
      try { this.known = JSON.parse((await readTextFile(KNOWN())) ?? "{}") ?? {}; } catch {}
      if (this.newGroupFor) this.edit("+group", "", cx);
      cx.notify();
    });
  }

  // Перечитать, поменять, записать с expected: не затереть запись панели между чтением и записью.
  // Сразу показываем правку (fn по копии в памяти), файл пишем следом: cx события после await уже не годится.
  save(fn, cx) {
    const mine = JSON.parse(JSON.stringify(this.cfg));
    fn(mine);
    this.cfg = mine;
    cx.notify();
    cx.spawn(async (cx) => {
      const raw = await readTextFile(CONFIG()).catch(() => null);
      const cfg = { groups: [], projects: {}, ...JSON.parse(raw ?? "{}") };
      fn(cfg);
      await writeTextFile(CONFIG(), `${JSON.stringify(cfg, null, 2)}\n`, raw);
      this.cfg = cfg;
      cx.notify();
    });
  }

  // Правка сразу всех мест проекта (Mac и сервер под одним именем).
  setProject(keys, patch, cx) {
    return this.save((c) => {
      for (const key of keys) {
        const p = { ...c.projects[key], ...patch };
        for (const k of Object.keys(p)) if (p[k] === null || p[k] === "") delete p[k];
        c.projects[key] = p;
      }
    }, cx);
  }

  edit(what, value, cx) {
    this.editing = what;
    this.input.set_value(value);
    this.input.focus();
    cx.notify();
  }

  commit(cx) {
    const what = this.editing;
    if (!what) return;
    this.editing = null;
    const v = this.input.value().trim();
    if (what === "+group") {
      const keys = this.newGroupFor;
      this.newGroupFor = null;
      if (!v) { cx.notify(); return; }
      this.save((c) => {
        if (!c.groups.includes(v)) c.groups.push(v);
        for (const k of keys ?? []) c.projects[k] = { ...c.projects[k], group: v };
      }, cx);
      return;
    }
    const keys = this.projects().find((p) => p.title === what)?.keys ?? [];
    if (!v || v === what) { cx.notify(); return; }
    this.save((c) => { for (const k of keys) { c.projects[k] = { ...c.projects[k], alias: v }; if (v === k) delete c.projects[k].alias; } }, cx);
  }

  // Проекты как в панели: одно имя = один проект, сколько бы мест под ним ни было.
  projects() {
    const pr = this.cfg.projects ?? {};
    const all = new Set([...Object.keys(pr), ...Object.keys(this.known), ...spaces().map((s) => s.name)]);
    const by = new Map();
    for (const k of all) { const title = pr[k]?.alias ?? k; by.set(title, [...(by.get(title) ?? []), k]); }
    return [...by].map(([title, keys]) => {
      const main = keys.find((k) => !k.includes(" · ")) ?? keys[0];
      const conf = { ...keys.reduce((c, k) => ({ ...pr[k], ...c }), {}), ...pr[main] };
      return { title, keys, conf, remote: keys.some((k) => k.includes(" · ")) };
    }).sort((a, b) => a.title.localeCompare(b.title, "ru"));
  }

  render() {
    const t = theme();
    const close = () => closeOverlay(props().overlay);
    const icon = (name, size = 14, color = t.muted) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);
    const btn = (id, child, tip, act, on = false, size = 26) => h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).when(Boolean(tip), (el) => el.tooltip(tip)).on_click((_e, cx) => act(cx)).child(child);
    const chip = (id, text, tip, act, on = false) => h_flex().id(id).flex_none().h(24).px(10).items_center().rounded(12).border(1).cursor_pointer()
      .border_color(on ? t.foreground : t.border).text_size(12).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).when(Boolean(tip), (el) => el.tooltip(tip)).on_click((_e, cx) => act(cx)).child(text);
    const groups = this.cfg.groups ?? [];
    const stepper = (id, value, fallback, tip, set) => h_flex().flex_none().items_center().gap(2)
      .child(btn(`${id}-minus`, div().text_color(t.muted).child("−"), null, (cx) => set(Math.max(1, value - 1), cx)))
      .child(div().w(22).text_center().text_color(value === fallback ? t.dim : t.foreground).child(String(value)))
      .child(btn(`${id}-plus`, div().text_color(t.muted).child("+"), null, (cx) => set(value + 1, cx)));
    const defVisible = this.cfg.visible ?? 5;

    const row = ({ title, keys, conf: c, remote }) => {
      const color = c.color ?? t.muted;
      const group = c.group ?? NO_GROUP;
      const vis = c.visible ?? defVisible;
      const open = this.open?.title === title ? this.open.what : null;
      const toggle = (what) => (cx) => { this.open = open === what ? null : { title, what }; cx.notify(); };
      const set = (patch) => (cx) => { this.open = null; this.setProject(keys, patch, cx); };
      const line = h_flex().id(`p-${title}`).h(36).px(8).gap(6).items_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(btn(`i-${title}`, icon(c.icon ?? "folder", 15, color), "Иконка", toggle("icon"), open === "icon"))
        .child(btn(`c-${title}`, div().size(12).rounded(6).bg(color), "Цвет", toggle("color"), open === "color"))
        .child(this.editing === title
          ? div().flex_1().min_w(0).child(Input.new(this.input).w_full())
          : h_flex().id(`n-${title}`).flex_1().min_w(0).gap(6).items_center().cursor_pointer()
            .on_click((_e, cx) => this.edit(title, title, cx))
            .child(div().min_w(0).truncate().text_color(t.foreground).child(title))
            .when(remote, (el) => el.child(icon("server", 12, t.dim))))
        .child(btn(`g-${title}`, icon("folder-input", 14, open === "group" ? t.foreground : t.muted), "Группа", toggle("group"), open === "group"))
        .child(stepper(`v-${title}`, vis, defVisible, "Сколько сессий видно в свёрнутом проекте",
          (n, cx) => this.setProject(keys, { visible: n === defVisible ? null : n }, cx)));
      if (!open) return line;
      const cur = c.icon ?? "folder";
      const pick = open === "icon"
        ? PICK_ICONS.map((n) => btn(`pi-${title}-${n}`, icon(n, 15, n === cur ? color : t.muted), null, set({ icon: n }), n === cur))
        : open === "color"
          ? COLORS.map((col) => btn(`pc-${title}-${col}`, div().size(14).rounded(7).bg(col), null, set({ color: col }), col === c.color))
          : [...groups, NO_GROUP].map((g) => chip(`pg-${title}-${g}`, g, null,
            set({ group: g === NO_GROUP ? null : g }), g === group))
            .concat([btn(`pg-${title}-new`, icon("plus", 13), "Новая группа",
              (cx) => { this.open = null; this.newGroupFor = keys; this.edit("+group", "", cx); })]);
      return v_flex().child(line).child(h_flex().pl(76).pb(8).gap(4).flex_wrap().items_center().children(pick));
    };

    const list = this.projects();
    const sections = [...groups, NO_GROUP].map((g) => ({ g, items: list.filter((p) => (p.conf.group ?? NO_GROUP) === g || (g === NO_GROUP && !groups.includes(p.conf.group ?? NO_GROUP))) }));
    const header = (g, n) => h_flex().id(`h-${g}`).h(28).px(8).pt(8).gap(4).items_center()
      .child(div().text_size(11).text_color(t.dim).child(g.toUpperCase()))
      .child(div().flex_1())
      .when(g !== NO_GROUP, (el) => el.child(btn(`grp-x-${g}`, svg("mods/pane/close.svg").size(10).text_color(t.dim),
        "Убрать группу", (cx) => this.save((c) => {
          c.groups = c.groups.filter((x) => x !== g);
          for (const p of Object.values(c.projects)) if (p.group === g) delete p.group;
        }, cx), false, 20)));

    return v_flex().size_full().bg(t.popover ?? t.chrome).text_size(13).text_color(t.foreground)
      .child(h_flex().h(44).px(16).items_center().border_b(1).border_color(t.border)
        .child(icon("settings", 15))
        .child(div().flex_1().pl(8).font_medium().child("Настройки панели"))
        .child(btn("close", svg("mods/pane/close.svg").size(13).text_color(t.muted), "Закрыть", () => close())))
      .child(thin("projects", v_flex().id("projects").flex_1().min_h(0).overflow_y_scroll().px(8).pb(8)
        .children(sections.filter((x) => x.items.length || x.g !== NO_GROUP).flatMap(({ g, items }) => [header(g, items.length), ...items.map(row)])), true))
      .child(h_flex().px(16).py(10).gap(10).items_center().border_t(1).border_color(t.border)
        .child(this.editing === "+group"
          ? div().w(200).child(Input.new(this.input).w_full())
          : h_flex().id("grp-add").h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.edit("+group", "", cx))
            .child(icon("plus", 13)).child("Группа"))
        .child(div().flex_1())
        .child(div().text_color(t.muted).child("Сессий в свёрнутом проекте"))
        .child(stepper("vis-def", defVisible, -1, "Сколько сессий видно в свёрнутом проекте по умолчанию",
          (n, cx) => this.save((c) => { c.visible = n; }, cx))));
  }
}
