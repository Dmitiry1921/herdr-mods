// ygg-new: окно новой сессии, как «Над чем поработаем?» в Codex.
// Проект и где запускать (этот Mac или сервер проекта), новый worktree или папка проекта,
// агент (Claude или Codex), модель, режим. Enter или стрелка — старт.
// Локально — чат herdr-chat (первый ход отправляет start.mjs), на сервере — терминал агента.
// props: { spaces: [id…], title, icon, color }

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popover } from "gpui-base";
import { spaces, machines, run, exec, theme, appHome, props, closeOverlay } from "herdr";
import { randomBytes } from "crypto";
import * as fs from "fs/promises";

const ICONS = "mods/ygg-new/icons";
const SIDEBAR = "mods/ygg-sidebar/icons";
const GREEN = "#2abb7f", RED = "#f87168", GREY = "#9fadbc", BLUE = "#579dff";
const ORANGE = "#fea362";
const CLAUDE_MODELS = [
  { id: "", name: "По умолчанию", tip: "Как в настройках Claude" },
  { id: "fable", name: "Fable 5.2" },
  { id: "opus", name: "Opus 5.5" },
  { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 5.5" },
];
// Пояснения моделей Codex приходят по-английски (~/.codex/models_cache.json): известные переводим, новые остаются как есть.
const RU = {
  "Fast, go-to model for coding and everyday work.": "Быстрая основная модель для кода и повседневной работы",
  "Our most capable model for complex coding and professional work.": "Самая сильная модель для сложного кода и профессиональной работы",
  "Efficient model that excels at visual understanding and computer use.": "Экономная модель, сильна в работе с картинками и управлении компьютером",
  "Previous generation model for coding and everyday work.": "Прошлое поколение: код и повседневная работа",
  "Previous generation model for complex coding and professional work.": "Прошлое поколение: сложный код и профессиональная работа",
  "Legacy model for coding and everyday work.": "Устаревшая модель для кода и повседневной работы",
  "Fast and affordable model for easier tasks.": "Быстрая и дешёвая модель для простых задач",
  "Legacy balanced model for agentic coding.": "Устаревшая сбалансированная модель для работы агентом",
  "Legacy fast model for simpler tasks.": "Устаревшая быстрая модель для простых задач",
};
const AGENTS = [
  { id: "claude", name: "Claude", tip: "Claude Code от Anthropic" },
  { id: "codex", name: "Codex", tip: "Codex от OpenAI" },
];
// Общие режимы: один список для всех агентов, у каждого агента свой id режима herdr-chat (нет id — режима у агента нет).
// Claude на сервере идёт терминалом: id режима уходит в --permission-mode.
const MODES = [
  { key: "ask", icon: "hand", name: "Спрашивать", tip: "Спрашивает разрешение перед правками и командами", claude: "default", codex: "untrusted" },
  { key: "edits", icon: "file-pen", name: "Принимать правки", tip: "Правит файлы сам, перед командами спрашивает", claude: "acceptEdits" },
  { key: "auto", icon: "shield-check", name: "Авто", tip: "Решает сам по каждому действию, спрашивает только про рискованное", claude: "auto", codex: "auto" },
  { key: "review", icon: "user-check", name: "Авто с ревьюером", tip: "Как Авто, но на запросы разрешений отвечает агент-ревьюер", codex: "auto-review" },
  { key: "read", icon: "eye", name: "Только чтение", tip: "Читает файлы, перед правками и командами спрашивает", codex: "read-only" },
  { key: "plan", icon: "list-checks", name: "План", tip: "Только читает и предлагает план, без правок", claude: "plan", codex: "plan" },
  { key: "full", icon: "shield-alert", name: "Полный доступ", tip: "Без песочницы и без вопросов: любые файлы и интернет", codex: "full", color: ORANGE },
];
const OLD_MODES = ["ask", "auto", "plan"]; // last.json до списков хранил номер режима
const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';

// SSH-цель машины Herdr (её host из hc machine ls); чат Codex на ней ходит в демон Codex по ssh.
let TARGETS = null;
const sshTarget = async (name) => {
  if (!TARGETS) {
    try {
      const r = await exec("sh", ["-c", 'PATH="$HOME/.local/bin:$PATH" exec hc machine ls --json'], { timeout: 10000 });
      TARGETS = Object.fromEntries((JSON.parse(r.stdout).machines ?? []).map((m) => [m.name, m.host ?? m.target ?? m.name]));
    } catch { TARGETS = {}; }
  }
  return TARGETS[name] ?? name;
};
const PREF = () => `${appHome()}/data/ygg-new/last.json`;

export default class YggNew extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.ids = p.spaces ?? [spaces().find((s) => s.active)?.id].filter(Boolean);
    this.where = 0; // индекс пространства проекта: Mac или сервер
    this.agent = "claude";
    this.model = 0;
    this.mode = "auto";
    this.open = null; // открытый список: mode, agent, model
    this.worktree = false;
    this.codexModels = [{ id: "", name: "По умолчанию" }];
    this.input = InputState.new({ placeholder: "Опиши задачу для агента" });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.focus();
    cx.spawn(async (cx) => {
      try {
        const cache = JSON.parse(await fs.readFile(`${appHome().replace(/\/\.config\/herdr-app\/?$/, "")}/.codex/models_cache.json`, "utf8"));
        const list = (cache.models ?? cache).filter((m) => m.visibility !== "hide");
        this.codexModels = [{ id: "", name: "По умолчанию", tip: "Как в настройках Codex" }, ...list.map((m) => ({ id: m.slug, name: m.display_name ?? m.slug, tip: RU[m.description] ?? m.description ?? "" }))];
      } catch {}
      try {
        const last = JSON.parse(await fs.readFile(PREF(), "utf8"));
        Object.assign(this, { agent: last.agent ?? this.agent, mode: (typeof last.mode === "number" ? OLD_MODES[last.mode] : last.mode) ?? this.mode, worktree: last.worktree ?? false });
        const models = this.models();
        this.model = Math.max(0, models.findIndex((m) => m.id === last.models?.[this.agent]));
        this.lastModels = last.models ?? {};
      } catch { this.lastModels = {}; }
      cx.notify();
    });
  }

  models() { return this.agent === "claude" ? CLAUDE_MODELS : this.codexModels; }
  spaces() { return this.ids.map((id) => spaces().find((s) => s.id === id)).filter(Boolean); }

  modes() { return MODES.filter((m) => m[this.agent]); }
  modeOf() { return this.modes().find((m) => m.key === this.mode) ?? MODES.find((m) => m.key === "auto"); }
  setAgent(id) {
    this.agent = id;
    this.model = Math.max(0, this.models().findIndex((m) => m.id === this.lastModels?.[id]));
    if (!MODES.find((m) => m.key === this.mode)?.[id]) this.mode = "auto";
  }

  // Чип в нижней строке: значок, подпись, клик — следующее значение.
  chip(id, icon, text, tip, onClick, t, on = false) {
    return h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(8).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .when(Boolean(icon), (el) => el.child(icon)).child(text);
  }

  // Чип со списком: клик открывает список, строка — значок, название, пояснение, галка у текущего.
  picker(id, icon, text, title, items, current, pick, t, { on = false, color = null, anchor = "bottom_left", width = 460 } = {}) {
    const trigger = h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(8).cursor_pointer()
      .text_color(color ?? (on ? t.foreground : t.muted)).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .when(this.open === id, (el) => el.bg(t.hover))
      .when(Boolean(icon), (el) => el.child(icon)).child(text)
      .child(svg(`${ICONS}/chevron-down.svg`).size(12).text_color(t.dim));
    const rows = items.map((it, i) => h_flex().id(`${id}-${i}`).px(10).py(7).gap(10).items_start().rounded(8).cursor_pointer()
      .when(it.key === current, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { pick(it); this.open = null; cx.notify(); })
      .when(Boolean(it.icon), (el) => el.child(div().pt(1).child(it.icon)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).text_color(it.color ?? t.foreground).child(it.name))
        .when(Boolean(it.tip), (el) => el.child(div().text_size(10.5).line_height("14px").text_color(it.color ?? t.dim).opacity(it.color ? 0.85 : 1).child(it.tip))))
      .when(it.key === current, (el) => el.child(svg(`${ICONS}/check.svg`).size(14).mt(2).text_color(it.color ?? BLUE))));
    return Popover.new(id).anchor(anchor).open(this.open === id)
      .on_open_change((open, cx) => { this.open = open ? id : this.open === id ? null : this.open; cx.notify(); })
      .trigger(trigger)
      .content(v_flex().id(`${id}-list`).w(width).max_h(320).overflow_y_scroll().p(6).gap(1).rounded(12).border_1().border_color(t.border)
        .bg(t.popover ?? t.chrome).shadow_lg().text_color(t.foreground)
        .child(div().px(10).pt(4).pb(4).text_size(12).text_color(t.dim).child(title))
        .children(rows));
  }

  // Диктовка, как в чате (overrides/chat/composer.js): клик пишет звук ffmpeg, второй клик останавливает,
  // whisper-cli распознаёт локально, текст встаёт в поле.
  dictate(cx) {
    const H = appHome().replace(/\/\.config\/herdr-app\/?$/, "");
    const PATH = `/opt/homebrew/bin:/usr/local/bin:${H}/.local/bin:/usr/bin:/bin`;
    const base = `/tmp/herdr-dictate-new-${(this.dictId ??= Math.random().toString(36).slice(2, 8))}`;
    if (this.dict === "rec") {
      this.dict = "busy";
      exec("sh", ["-c", 'kill -INT "$(cat "$0.pid")" 2>/dev/null', base]).catch(() => {});
      cx.notify();
      return;
    }
    if (this.dict) return;
    this.dict = "rec"; this.dictErr = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await exec("sh", ["-c", `export PATH="${PATH}"; rm -f "$0.wav"; ffmpeg -hide_banner -loglevel error -f avfoundation -i ":default" -ac 1 -ar 16000 -y "$0.wav" </dev/null & echo $! > "$0.pid"; wait`, base], { timeout: 900000 });
        const r = await exec("sh", ["-c", `export PATH="${PATH}"; [ -s "$0.wav" ] || exit 3; whisper-cli -m "${H}/.cache/whisper-cpp/ggml-large-v3-turbo.bin" -l ru -nt -np -f "$0.wav" 2>/dev/null`, base], { timeout: 180000 });
        const text = (r.stdout ?? "").replace(/\s+/g, " ").replace(/\[[^\]]*\]/g, "").trim();
        if (text) { const v = this.input.value(); this.input.set_value(v && !/\s$/.test(v) ? `${v} ${text}` : `${v}${text}`); this.input.focus(); }
        else this.dictErr = "Не расслышал";
      } catch { this.dictErr = "Нет записи: разреши Herdr микрофон в настройках macOS"; }
      this.dict = null;
      cx.notify();
    });
  }

  async start(cx) {
    const text = this.input.value().trim();
    const sp = this.spaces()[this.where];
    if (!text || !sp || this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    const model = this.models()[this.model]?.id ?? "";
    const mode = this.modeOf();
    const name = text.split("\n")[0].slice(0, 60);
    const on = sp.machine ?? null;
    try {
      await fs.mkdir(`${appHome()}/data/ygg-new`, { recursive: true });
      await fs.writeFile(PREF(), JSON.stringify({ agent: this.agent, mode: this.mode, worktree: this.worktree, models: { ...this.lastModels, [this.agent]: model } }));
      let cwd = sp.folder;
      if (this.worktree) {
        const slug = `session-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomBytes(2).toString("hex")}`;
        const dir = `${cwd.replace(/\/$/, "")}-worktrees/${slug}`;
        const r = await exec("git", ["-C", cwd, "worktree", "add", "-b", slug, dir], { on, timeout: 30000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop());
        cwd = dir;
      }
      // Codex на сервере тоже чатом: хост чата здесь, ход идёт в демоне Codex на сервере и доживает, пока Mac спит.
      if (!on || this.agent === "codex") {
        const chat = `c-${randomBytes(4).toString("hex")}`;
        const remote = on ? await sshTarget(on) : null;
        // Вкладка чата только на этом Mac (herdr-chat ищет её в здешней раскладке): здешнее пространство проекта.
        const here = on ? (this.spaces().find((x) => !x.machine) ?? spaces().find((x) => !x.machine) ?? sp).id : sp.id;
        run("tab.new", { space: here, name, mod: "chat", props: { chat, provider: this.agent, cwd, ...(remote ? { remote } : {}) } });
        exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-new/start.mjs`, chat, model, mode[this.agent], text], { timeout: 90000 }).catch(() => {});
      } else {
        // Сюда доходит только Claude: Codex и на сервере открывается чатом.
        const argv = ["claude", ...(model ? ["--model", model] : []), "--permission-mode", mode.claude, text];
        run("tab.new", { space: sp.id, name, argv: ["sh", "-c", 'cd "$0" && exec "$@"', cwd, ...argv] });
      }
      closeOverlay(props().overlay);
    } catch (e) {
      this.error = e?.message ?? String(e);
      this.busy = false; cx.notify();
    }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const ss = this.spaces();
    const sp = ss[this.where];
    const state = sp?.machine ? machines().find((m) => m.name === sp.machine)?.layout ?? "loading" : "ready";
    const srvColor = state === "ready" ? GREEN : state === "unavailable" ? RED : GREY;
    const models = this.models();
    const mode = this.modeOf();
    const ico = (name, color) => svg(`${ICONS}/${name}.svg`).size(15).text_color(color ?? t.muted);
    const can = Boolean(this.input.value().trim()) && !this.busy && state !== "unavailable";
    return v_flex().size_full().bg(t.popover ?? t.chrome).p(18).gap(12).text_size(13).text_color(t.foreground)
      .child(div().text_size(20).font_medium().child("Над чем поработаем?"))
      .child(v_flex().rounded(14).border_1().border_color(t.border).bg(t.background ?? t.chrome)
        .child(div().px(12).pt(10).pb(4).child(Input.new(this.input).w_full()))
        .child(h_flex().px(6).pb(6).gap(2).items_center()
          .child(this.picker("mode", ico(mode.icon, mode.color), mode.name, `Как подтверждать действия ${AGENTS.find((a) => a.id === this.agent)?.name}?`,
            this.modes().map((m) => ({ key: m.key, icon: ico(m.icon, m.color), name: m.name, tip: m.tip, color: m.color })), mode.key,
            (it) => { this.mode = it.key; }, t, { color: mode.color }))
          .child(div().flex_1())
          .child(this.picker("agent", image(`${SIDEBAR}/${this.agent}.svg`).size(14), AGENTS.find((a) => a.id === this.agent)?.name ?? this.agent, "Агент",
            AGENTS.map((a) => ({ key: a.id, icon: image(`${SIDEBAR}/${a.id}.svg`).size(16), name: a.name, tip: a.tip })), this.agent,
            (it) => this.setAgent(it.key), t, { on: true, anchor: "bottom_right", width: 260 }))
          .child(this.picker("model", null, models[this.model]?.name ?? "По умолчанию", "Модель",
            models.map((m, i) => ({ key: i, name: m.name, tip: m.tip })), this.model,
            (it) => { this.model = it.key; }, t, { on: true, anchor: "bottom_right", width: 340 }))
          .child(h_flex().id("dictate").size(32).rounded_full().items_center().justify_center().cursor_pointer()
            .when(this.dict === "rec", (e) => e.bg(t.hover).text_color(RED).loop("opacity", { from: 0.55, to: 1, period: 1100 }))
            .when(this.dict !== "rec", (e) => e.text_color(this.dictErr ? RED : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
            .tooltip(this.dict === "rec" ? "Идёт запись. Клик — остановить и вставить текст" : this.dict === "busy" ? "Распознаю речь" : this.dictErr ?? "Надиктовать. Клик — начать запись")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.dictate(cx))
            .child(this.dict === "busy" ? svg("mods/workspace-chrome/spinner.svg").size(14).text_color(BLUE).spin(900)
              : svg(`${ICONS}/${this.dict === "rec" ? "square" : "mic"}.svg`).size(this.dict === "rec" ? 11 : 15)))
          .child(div().id("go").size(32).ml(4).rounded_full().flex().items_center().justify_center()
            .bg(can ? t.foreground : t.hover).cursor_pointer().tooltip(this.busy ? "Запускаю сессию" : "Клик — запустить сессию (Enter)")
            .on_click((_e, cx) => this.start(cx))
            .child(this.busy ? svg("mods/workspace-chrome/spinner.svg").size(15).text_color(BLUE).spin(900)
              : svg(`${ICONS}/arrow-up.svg`).size(16).text_color(can ? (t.background ?? "#111") : t.dim)))))
      .child(h_flex().px(4).gap(2).items_center()
        .child(this.chip("project", svg(`${SIDEBAR}/${p.icon ?? "folder"}.svg`).size(14).text_color(p.color ?? t.muted), p.title ?? sp?.name ?? "Проект",
          ss.map((x) => x.folder).join(", "), () => {}, t, true))
        .child(this.chip("where", sp?.machine ? svg(`${ICONS}/server.svg`).size(14).text_color(srvColor) : svg(`${ICONS}/laptop.svg`).size(14),
          sp?.machine ?? "Этот Mac",
          sp?.machine ? `Сервер ${sp.machine} ${state === "ready" ? "доступен" : state === "unavailable" ? "недоступен" : "подключается"}. ${ss.length > 1 ? "Клик — запустить в другом месте" : "Других мест у проекта нет"}` : `Сессия на этом Mac. ${ss.length > 1 ? "Клик — запустить на сервере" : "Других мест у проекта нет"}`,
          () => { this.where = (this.where + 1) % Math.max(1, ss.length); }, t))
        .child(this.chip("worktree", svg(`${ICONS}/branch.svg`).size(14).text_color(this.worktree ? BLUE : t.muted), this.worktree ? "Новый worktree" : "Папка проекта",
          this.worktree ? "Сессия в своём worktree с новой веткой. Клик — работать в папке проекта" : "Сессия в папке проекта. Клик — завести отдельный worktree", () => { this.worktree = !this.worktree; }, t, this.worktree))
        .child(div().flex_1())
        .when(Boolean(this.error), (el) => el.child(div().max_w(260).truncate().text_color(RED).tooltip(this.error).child(this.error))));
  }
}
