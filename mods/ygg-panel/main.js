// ygg-panel: правая панель «Сводка» для активной вкладки.
// Плоские секции с тонкими разделителями, как левая панель проектов: сводка по папке и ветке,
// контекст сессии, лимиты Claude и Codex с полосами, коннекторы активного агента с их значками.
// Данные собирает collect.mjs (раз в 5 с и при смене вкладки).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, terminals, theme, appHome, exec } from "herdr";

const ICONS = "mods/ygg-panel/icons";
// Семантика Yggdrasil: синий — идёт работа, жёлтый — упёрлись, зелёный — добавлено.
const BLUE = "#579dff", YELLOW = "#f5cd47", GREEN = "#2abb7f", RED = "#f87168", GREY = "#9fadbc";
const AGENT = { claude: "Claude", codex: "Codex" };
const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

export default class YggPanel extends View {
  init(_p, cx) {
    this.data = null;
    this.key = null;
    this.hooks = [];
    cx.timer.every(5000, (cx) => this.fetch(cx));
    this.fetchHooks(cx);
    cx.timer.every(60000, (cx) => this.fetchHooks(cx));
  }

  // Хуки Codex, которые он не запускает без одобрения (новые или изменившиеся после обновления плагина).
  fetchHooks(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/hooks.mjs`, "list", spaces().find((s) => s.active)?.folder ?? "/tmp"], { timeout: 25000 });
        const list = JSON.parse(r.stdout || "[]");
        if (Array.isArray(list) && JSON.stringify(list) !== JSON.stringify(this.hooks)) { this.hooks = list; cx.notify(); }
      } catch {}
    });
  }

  // Одобрение — только по клику пользователя: пишем хеш, который сейчас показывает сам Codex.
  trust(group, cx) {
    if (this.trusting) return;
    this.trusting = group.name; cx.notify();
    cx.spawn(async (cx) => {
      for (const h of group.hooks) {
        try { await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/hooks.mjs`, "trust", "/tmp", h.key, h.hash], { timeout: 25000 }); } catch {}
      }
      this.trusting = null; this.fetchHooks(cx);
    });
  }

  // Активная вкладка → её терминал (по метке herdr.tab), папка и вид агента.
  active() {
    const sp = spaces().find((s) => s.active);
    const tab = sp?.tabs?.find((x) => x.active);
    if (!sp || !tab) return null;
    const term = terminals().find((x) => x.labels?.["herdr.tab"] === tab.id);
    const argv = (term?.argv ?? []).join(" ");
    const kind = term?.labels?.["ygg.kind"] ?? (/codex/.test(argv) ? "codex" : /claude/.test(argv) ? "claude" : term?.report?.app ?? "");
    return { key: `${tab.id}|${term?.address ?? ""}`, term: term?.address ?? "", cwd: term?.cwd ?? sp.folder ?? "", kind, machine: sp.machine };
  }

  fetch(cx) {
    const a = this.active();
    if (!a || a.machine) { if (this.data) { this.data = null; cx.notify(); } return; }
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/collect.mjs`, a.term, a.cwd, a.kind], { timeout: 8000 });
        const d = JSON.parse(r.stdout || "null");
        if (JSON.stringify(d) !== JSON.stringify(this.data)) { this.data = d; cx.notify(); }
      } catch {}
      this.busy = false;
    });
  }

  compact(cx) {
    const a = this.active();
    if (!a || this.compacting) return;
    this.compacting = true; cx.notify();
    cx.spawn(async (cx) => {
      try { await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/collect.mjs`, a.term, a.cwd, a.kind, "compact"], { timeout: 130000 }); } catch {}
      this.compacting = false; cx.notify(); this.fetch(cx);
    });
  }

  header(text, t, right) {
    return h_flex().h(28).px(14).pt(8).flex_none().items_center().text_size(11).text_color(t.dim)
      .child(text.toUpperCase()).child(div().flex_1()).when(Boolean(right), (el) => el.child(right));
  }

  row(icon, text, right, t, tip) {
    return h_flex().h(26).px(14).gap(8).flex_none().items_center().min_w(0)
      .when(Boolean(icon), (el) => el.child(icon))
      .child(div().flex_1().min_w(0).truncate().child(text))
      .when(right != null, (el) => el.child(right))
      .when(Boolean(tip), (el) => el.id(`r-${text}`).tooltip(tip));
  }

  bar(parts, t) {
    return h_flex().mx(14).mt(6).mb(4).h(2).rounded_full().bg(t.border).overflow_hidden()
      .children(parts.map(([pct, color]) => div().h_full().rounded_full().w(`${Math.max(0, Math.min(100, pct))}%`).bg(color)));
  }

  limit(r, t) {
    const color = r.pct >= 90 ? YELLOW : BLUE;
    return v_flex().pt(6).pb(4).flex_none()
      .child(h_flex().px(14).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().child(r.label))
        .child(div().text_color(t.muted).child(`${r.reset ? `${r.reset} · ` : ""}${r.pct}%`)))
      .child(this.bar([[r.pct, color]], t));
  }

  agentHead(kind, plan, t) {
    return h_flex().px(14).pt(10).pb(2).gap(6).items_center().text_size(12).text_color(t.muted)
      .child(image(`mods/ygg-sidebar/icons/${kind}.svg`).size(13))
      .child(`${AGENT[kind]}${plan ? ` · ${plan}` : ""}`);
  }

  connector(c, t) {
    const icon = c.image ? image(c.image).size(15).rounded(3)
      : svg(c.svg).size(15).text_color(c.on ? (c.color ?? t.foreground) : t.dim);
    return this.row(icon, c.title ?? c.name, c.on ? null : div().text_color(t.dim).child("выкл"), t,
      `${c.kind === "mcp" ? "MCP-сервер" : "Плагин"} ${c.name}, ${c.on ? "включён" : "выключен в настройках агента"}`);
  }

  render(cx) {
    const t = theme();
    const a = this.active();
    if (a?.key !== this.key) { this.key = a?.key; this.fetch(cx); }
    const d = this.data;
    const line = () => div().mt(8).h(1).flex_none().bg(t.border);
    const body = v_flex().flex_1().min_h(0).pb(14).overflow_y_scrollbar();
    if (!d) return v_flex().size_full().bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(this.header("Сводка", t)).child(this.row(null, a?.machine ? "Сессия на сервере" : "Нет данных", null, t));

    // Сводка.
    body.child(this.header("Сводка", t, d.agent ? image(`mods/ygg-sidebar/icons/${d.agent}.svg`).size(13) : null));
    if (d.repo) {
      body.child(this.row(svg(`${ICONS}/folder.svg`).size(15).text_color(t.muted), d.repo.folder,
        d.repo.branch ? h_flex().gap(4).items_center().text_color(t.muted).child(svg(`${ICONS}/branch.svg`).size(12)).child(div().max_w(150).truncate().child(d.repo.branch)) : null,
        t, d.cwd));
      if (d.repo.files) body.child(this.row(svg(`${ICONS}/diff.svg`).size(15).text_color(t.muted), `${d.repo.files} файлов изменено`,
        h_flex().gap(6).child(div().text_color(GREEN).child(`+${d.repo.add}`)).child(div().text_color(RED).child(`−${d.repo.del}`)), t,
        "Незакоммиченные изменения относительно HEAD"));
    }

    // Контекст.
    if (d.context) {
      const pct = Math.round((d.context.used / d.context.window) * 100);
      body.child(line()).child(this.header("Контекст", t, div().child(`${k(d.context.used)} / ${k(d.context.window)}`)))
        .child(this.bar([[pct, pct >= 85 ? YELLOW : BLUE]], t))
        .child(this.row(null, `Занято ${pct}%`, null, t, "Сколько окна контекста занимает последний ход сессии"));
      if (d.chat) body.child(this.row(this.compacting ? svg("mods/workspace-chrome/spinner.svg").size(15).text_color(BLUE).spin(900) : svg(`${ICONS}/fold.svg`).size(15).text_color(t.muted),
        this.compacting ? "Сжимаю сессию" : "Сжать сессию", null, t, "Сжатие контекста сессии. Клик — сжать сейчас")
        .cursor_pointer().hover((s) => s.bg(t.hover)).rounded(6).mx(6).px(8)
        .on_click((_e, cx) => this.compact(cx)));
    }

    // Лимиты.
    const L = d.limits ?? {};
    body.child(line()).child(this.header("Лимиты", t));
    body.child(this.agentHead("claude", L.claude?.plan, t));
    if (L.claude?.rows?.length) for (const r of L.claude.rows) body.child(this.limit(r, t));
    else body.child(this.row(null, "нет данных", null, t, "Лимиты Claude приходят из статусной строки Claude Code: её снимок ещё не подключён"));
    body.child(this.agentHead("codex", L.codex?.plan, t));
    if (L.codex?.rows?.length) for (const r of L.codex.rows) body.child(this.limit(r, t));
    else body.child(this.row(null, "нет данных", null, t, "Лимиты Codex берутся из свежих файлов его сессий"));
    if (L.codex?.credits != null) body.child(this.row(null, "Кредиты", div().text_color(t.muted).child(String(L.codex.credits)), t, "Остаток кредитов Codex"));

    // Хуки Codex, ждущие одобрения: строка на плагин или файл хуков.
    if (this.hooks.length) {
      const groups = [];
      for (const h of this.hooks) {
        const name = h.plugin ? h.plugin.split("@")[0] : h.source.split("/").slice(-2).join("/");
        const g = groups.find((x) => x.name === name) ?? (groups.push({ name, hooks: [], modified: false }), groups.at(-1));
        g.hooks.push(h); g.modified ||= h.status === "modified";
      }
      body.child(line()).child(this.header("Хуки Codex", t, div().child(String(groups.length))));
      for (const g of groups) {
        const busy = this.trusting === g.name;
        body.child(this.row(busy ? svg("mods/workspace-chrome/spinner.svg").size(15).text_color(BLUE).spin(900) : svg(`${ICONS}/shield.svg`).size(15).text_color(YELLOW),
          g.name, div().text_color(t.dim).child(String(g.hooks.length)), t,
          `${g.modified ? "Плагин изменился после обновления" : "Новые хуки"}: Codex не запускает ${g.hooks.map((h) => h.event).join(", ")}, пока их не одобрить. Клик — одобрить`)
          .cursor_pointer().hover((s) => s.bg(t.hover)).rounded(6).mx(6).px(8)
          .on_click((_e, cx) => this.trust(g, cx)));
      }
    }

    // Коннекторы.
    if (d.connectors?.length) {
      body.child(line()).child(this.header("Коннекторы", t, div().child(String(d.connectors.filter((c) => c.on).length))));
      for (const c of d.connectors) body.child(this.connector(c, t));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground).child(body);
  }
}
