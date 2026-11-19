// ygg-settings: окно настроек левой панели вместо правки projects.json руками.
// Проекты: имя в панели (одинаковое имя у двух проектов = один проект), группа, иконка, цвет, сколько сессий видно.
// Группы: добавить, убрать. Пишет в тот же projects.json, панель подхватывает его сама за пару секунд.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, theme, appHome, readTextFile, writeTextFile, props, closeOverlay } from "herdr";

const ICONS = "mods/ygg-sidebar/icons";
const CONFIG = () => `${appHome()}/data/ygg-sidebar/projects.json`;
const KNOWN = () => `${appHome()}/data/ygg-sidebar/known.json`;
const PICK_ICONS = ["folder", "plane", "train", "wrench", "sparkles", "paw", "piggy", "home", "clapper", "chat", "terminal", "server", "command", "git-branch"];
const COLORS = ["#579dff", "#7a9dff", "#9f8fef", "#f87fb0", "#f87168", "#d97757", "#fea362", "#e2b203", "#4bce97", "#2abb7f", "#6cc3e0", "#9fadbc"];
const NO_GROUP = "Без группы";

export default class Settings extends View {
  init(_p, cx) {
    this.cfg = { groups: [], projects: {} };
    this.known = {};
    this.open = null;      // { key, what: "icon" | "color" } — раскрытый выбор под строкой
    this.editing = null;   // ключ проекта, чьё имя правится, или "+group"
    this.input = InputState.new({ placeholder: "" });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("blur", (_e, cx) => this.commit(cx));
    cx.spawn(async (cx) => {
      try { this.cfg = { groups: [], projects: {}, ...JSON.parse((await readTextFile(CONFIG())) ?? "{}") }; } catch {}
      try { this.known = JSON.parse((await readTextFile(KNOWN())) ?? "{}") ?? {}; } catch {}
      cx.notify();
    });
  }

  // Перечитать, поменять, записать с expected: не затереть запись панели между чтением и записью.
  async save(fn, cx) {
    const raw = await readTextFile(CONFIG()).catch(() => null);
    const cfg = { groups: [], projects: {}, ...JSON.parse(raw ?? "{}") };
    fn(cfg);
    await writeTextFile(CONFIG(), `${JSON.stringify(cfg, null, 2)}\n`, raw);
    this.cfg = cfg;
    cx.notify();
  }

  setProject(key, patch, cx) {
    this.save((c) => {
      const p = { ...c.projects[key], ...patch };
      for (const k of Object.keys(p)) if (p[k] === null || p[k] === "") delete p[k];
      c.projects[key] = p;
    }, cx);
  }

  edit(key, value, cx) {
    this.editing = key;
    this.input.set_value(value);
    this.input.focus();
    cx.notify();
  }

  commit(cx) {
    const key = this.editing;
    if (!key) return;
    this.editing = null;
    const v = this.input.value().trim();
    if (key === "+group") { if (v) this.save((c) => { if (!c.groups.includes(v)) c.groups.push(v); }, cx); else cx.notify(); return; }
    this.setProject(key, { alias: v === key ? null : v }, cx);
  }

  keys() {
    const all = new Set([...Object.keys(this.cfg.projects ?? {}), ...Object.keys(this.known), ...spaces().map((s) => s.name)]);
    return [...all].sort((a, b) => this.title(a).localeCompare(this.title(b), "ru") || a.localeCompare(b));
  }

  title(key) { return this.cfg.projects?.[key]?.alias ?? key; }

  render() {
    const t = theme();
    const close = () => closeOverlay(props().overlay);
    const icon = (name, size = 14, color = t.muted) => svg(`${ICONS}/${name}.svg`).size(size).flex_none().text_color(color);
    const btn = (id, child, tip, act, on = false) => h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => act(cx)).child(child);
    const groups = this.cfg.groups ?? [];
    const stepper = (id, value, fallback, tip, set) => h_flex().flex_none().items_center().gap(2)
      .child(btn(`${id}-minus`, div().text_color(t.muted).child("−"), `${tip}. Клик — меньше`, (cx) => set(Math.max(1, value - 1), cx)))
      .child(div().w(22).text_center().text_color(value === fallback ? t.dim : t.foreground).child(String(value)))
      .child(btn(`${id}-plus`, div().text_color(t.muted).child("+"), `${tip}. Клик — больше`, (cx) => set(value + 1, cx)));
    const defVisible = this.cfg.visible ?? 5;

    const row = (key) => {
      const c = this.cfg.projects?.[key] ?? {};
      const color = c.color ?? t.muted, name = this.title(key);
      const group = c.group ?? NO_GROUP;
      const nextGroup = [...groups, NO_GROUP][([...groups, NO_GROUP].indexOf(group) + 1) % (groups.length + 1)];
      const vis = c.visible ?? defVisible;
      const open = this.open?.key === key ? this.open.what : null;
      const toggle = (what) => (cx) => { this.open = open === what ? null : { key, what }; cx.notify(); };
      const line = h_flex().id(`p-${key}`).h(36).px(8).gap(6).items_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(btn(`i-${key}`, icon(c.icon ?? "folder", 15, color), "Иконка проекта. Клик — выбрать", toggle("icon"), open === "icon"))
        .child(btn(`c-${key}`, div().size(12).rounded(6).bg(color), "Цвет проекта. Клик — выбрать", toggle("color"), open === "color"))
        .child(this.editing === key
          ? div().flex_1().min_w(0).child(Input.new(this.input).w_full())
          : h_flex().id(`n-${key}`).flex_1().min_w(0).gap(6).items_center().cursor_pointer()
            .tooltip("Имя в панели; одно имя у двух проектов собирает их в один. Клик — переименовать")
            .on_click((_e, cx) => this.edit(key, name, cx))
            .child(div().min_w(0).truncate().text_color(t.foreground).child(name))
            .when(name !== key, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(key))))
        .child(h_flex().id(`g-${key}`).flex_none().h(24).px(8).items_center().rounded(12).border(1).border_color(t.border).cursor_pointer()
          .text_size(12).text_color(group === NO_GROUP ? t.dim : t.muted).hover((s) => s.bg(t.hover))
          .tooltip(`Группа в панели. Клик — «${nextGroup}»`)
          .on_click((_e, cx) => this.setProject(key, { group: nextGroup === NO_GROUP ? null : nextGroup }, cx))
          .child(group))
        .child(stepper(`v-${key}`, vis, defVisible, "Сколько сессий видно в свёрнутом проекте",
          (n, cx) => this.setProject(key, { visible: n === defVisible ? null : n }, cx)));
      if (!open) return line;
      const pick = open === "icon"
        ? PICK_ICONS.map((n) => btn(`pi-${key}-${n}`, icon(n, 15, n === (c.icon ?? "folder") ? color : t.muted), `Иконка ${n}. Клик — поставить`,
          (cx) => { this.open = null; this.setProject(key, { icon: n }, cx); }, n === (c.icon ?? "folder")))
        : COLORS.map((col) => btn(`pc-${key}-${col}`, div().size(14).rounded(7).bg(col), `Цвет ${col}. Клик — поставить`,
          (cx) => { this.open = null; this.setProject(key, { color: col }, cx); }, col === c.color));
      return v_flex().child(line).child(h_flex().pl(40).pb(6).gap(2).flex_wrap().children(pick));
    };

    const chip = (g) => h_flex().id(`grp-${g}`).h(24).pl(8).pr(2).gap(4).items_center().rounded(12).border(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(g)
      .child(btn(`grp-x-${g}`, svg("mods/pane/close.svg").size(10).text_color(t.dim), `Группа «${g}». Клик — убрать (проекты уйдут в «${NO_GROUP}»)`,
        (cx) => this.save((c) => { c.groups = c.groups.filter((x) => x !== g); for (const p of Object.values(c.projects)) if (p.group === g) delete p.group; }, cx)));

    return v_flex().size_full().bg(t.popover ?? t.chrome).text_size(13).text_color(t.foreground)
      .child(h_flex().h(44).px(16).items_center().border_b(1).border_color(t.border)
        .child(icon("settings", 15))
        .child(div().flex_1().pl(8).font_medium().child("Настройки панели"))
        .child(btn("close", svg("mods/pane/close.svg").size(13).text_color(t.muted), "Закрыть. Клик — закрыть окно", () => close())))
      .child(v_flex().id("projects").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(6).children(this.keys().map(row)))
      .child(v_flex().px(16).py(10).gap(8).border_t(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(div().w(150).text_color(t.muted).child("Группы"))
          .children(groups.map(chip))
          .child(this.editing === "+group"
            ? div().w(160).child(Input.new(this.input).w_full())
            : btn("grp-add", icon("plus", 13), "Новая группа. Клик — назвать", (cx) => this.edit("+group", "", cx))))
        .child(h_flex().gap(6).items_center()
          .child(div().w(150).text_color(t.muted).child("Сессий в проекте"))
          .child(stepper("vis-def", defVisible, -1, "Сколько сессий видно в свёрнутом проекте по умолчанию",
            (n, cx) => this.save((c) => { c.visible = n; }, cx)))));
  }
}
