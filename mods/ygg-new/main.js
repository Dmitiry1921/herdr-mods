// ygg-new: окно новой сессии, как «Над чем поработаем?» в Codex.
// Проект и где запускать (этот Mac или сервер проекта), новый worktree или папка проекта,
// агент (Claude или Codex), модель, режим. Enter или стрелка — старт.
// Локально — чат herdr-chat (первый ход отправляет start.mjs), на сервере — терминал агента.
// props: { spaces: [id…], title, icon, color }

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, machines, run, exec, theme, appHome, props, closeOverlay } from "herdr";
import { randomBytes } from "crypto";
import * as fs from "fs/promises";

const ICONS = "mods/ygg-new/icons";
const SIDEBAR = "mods/ygg-sidebar/icons";
const GREEN = "#2abb7f", RED = "#f87168", GREY = "#9fadbc", BLUE = "#579dff";
const CLAUDE_MODELS = [
  { id: "", name: "По умолчанию" },
  { id: "fable", name: "Fable 5.2" },
  { id: "opus", name: "Opus 5.5" },
  { id: "sonnet", name: "Sonnet 5.5" },
  { id: "haiku", name: "Haiku 5.5" },
];
// Общие режимы Claude и Codex: id режима herdr-chat и флаги CLI для сервера.
const MODES = [
  { key: "ask", name: "Спрашивать", tip: "Спрашивает перед правками и командами",
    claude: "default", codex: "untrusted", claudeArgs: ["--permission-mode", "default"], codexArgs: ["-a", "untrusted"] },
  { key: "auto", name: "Авто", tip: "Решает сам по каждому действию, правит в рабочей папке",
    claude: "auto", codex: "auto", claudeArgs: ["--permission-mode", "auto"], codexArgs: ["--full-auto"] },
  { key: "plan", name: "План", tip: "Только читает и предлагает план, без правок",
    claude: "plan", codex: "plan", claudeArgs: ["--permission-mode", "plan"], codexArgs: ["-s", "read-only"] },
];
const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
const PREF = () => `${appHome()}/data/ygg-new/last.json`;

export default class YggNew extends View {
  init(_p, cx) {
    const p = props() ?? {};
    this.ids = p.spaces ?? [spaces().find((s) => s.active)?.id].filter(Boolean);
    this.where = 0; // индекс пространства проекта: Mac или сервер
    this.agent = "claude";
    this.model = 0;
    this.mode = 1;
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
        this.codexModels = [{ id: "", name: "По умолчанию" }, ...list.map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }))];
      } catch {}
      try {
        const last = JSON.parse(await fs.readFile(PREF(), "utf8"));
        Object.assign(this, { agent: last.agent ?? this.agent, mode: last.mode ?? this.mode, worktree: last.worktree ?? false });
        const models = this.models();
        this.model = Math.max(0, models.findIndex((m) => m.id === last.models?.[this.agent]));
        this.lastModels = last.models ?? {};
      } catch { this.lastModels = {}; }
      cx.notify();
    });
  }

  models() { return this.agent === "claude" ? CLAUDE_MODELS : this.codexModels; }
  spaces() { return this.ids.map((id) => spaces().find((s) => s.id === id)).filter(Boolean); }

  // Чип в нижней строке: значок, подпись, клик — следующее значение.
  chip(id, icon, text, tip, onClick, t, on = false) {
    return h_flex().id(id).h(30).px(10).gap(6).items_center().rounded(8).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(); cx.notify(); })
      .when(Boolean(icon), (el) => el.child(icon)).child(text);
  }

  async start(cx) {
    const text = this.input.value().trim();
    const sp = this.spaces()[this.where];
    if (!text || !sp || this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    const model = this.models()[this.model]?.id ?? "";
    const mode = MODES[this.mode];
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
      if (!on) {
        const chat = `c-${randomBytes(4).toString("hex")}`;
        run("tab.new", { space: sp.id, name, mod: "chat", props: { chat, provider: this.agent, cwd } });
        exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-new/start.mjs`, chat, model, mode[this.agent], text], { timeout: 90000 }).catch(() => {});
      } else {
        const argv = this.agent === "codex"
          ? ["codex", ...(model ? ["-m", model] : []), ...mode.codexArgs, text]
          : ["claude", ...(model ? ["--model", model] : []), ...mode.claudeArgs, text];
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
    const mode = MODES[this.mode];
    const can = Boolean(this.input.value().trim()) && !this.busy && state !== "unavailable";
    return v_flex().size_full().bg(t.popover ?? t.chrome).p(18).gap(12).text_size(13).text_color(t.foreground)
      .child(div().text_size(20).font_medium().child("Над чем поработаем?"))
      .child(v_flex().rounded(14).border_1().border_color(t.border).bg(t.background ?? t.chrome)
        .child(div().px(12).pt(10).pb(4).child(Input.new(this.input).w_full()))
        .child(h_flex().px(6).pb(6).gap(2).items_center()
          .child(this.chip("mode", svg(`${ICONS}/shield.svg`).size(14), mode.name, `${mode.tip}. Клик — другой режим`, () => { this.mode = (this.mode + 1) % MODES.length; }, t))
          .child(div().flex_1())
          .child(this.chip("agent", image(`${SIDEBAR}/${this.agent}.svg`).size(14), this.agent === "claude" ? "Claude" : "Codex",
            "Агент сессии. Клик — другой агент", () => { this.agent = this.agent === "claude" ? "codex" : "claude"; this.model = Math.max(0, this.models().findIndex((m) => m.id === this.lastModels?.[this.agent])); }, t, true))
          .child(this.chip("model", null, models[this.model]?.name ?? "По умолчанию", "Модель. Клик — следующая", () => { this.model = (this.model + 1) % models.length; }, t, true))
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
