// ygg-panel: правая панель «Сводка» для активной вкладки.
// Плоские секции с тонкими разделителями, как левая панель проектов: сводка по папке и ветке,
// контекст сессии, лимиты Claude и Codex с полосами, коннекторы активного агента с их значками.
// Данные собирает collect.mjs (раз в 5 с и при смене вкладки).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, terminals, panes, props, shared, setShared, theme, appHome, exec, layout, run } from "herdr";

const ICONS = "mods/ygg-panel/icons";
// Семантика Yggdrasil: синий — идёт работа, жёлтый — упёрлись, зелёный — добавлено.
// Цвета брендов: лимиты Claude оранжевые, Codex синие, как их логотипы.
const BRAND = { claude: "#D97757", codex: "#6a7dff" };
const BLUE = "#579dff", YELLOW = "#f5cd47", GREEN = "#2abb7f", RED = "#f87168", GREY = "#9fadbc";
const AGENT = { claude: "Claude", codex: "Codex" };
const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const PURPLE = "#9f8fef";
// Разделы панели: порядок, свёрнутые и закреплённые (закреплённые видны поверх сессии, когда панель скрыта).
const SECTIONS = { env: "Среда", context: "Контекст", limits: "Лимиты", prs: "Запросы на слияние", hooks: "Хуки Codex", connectors: "Коннекторы" };
const PREFS = "ygg-panel.prefs";
// shared, а не localStorage: у плавающей копии мода своё хранилище, а настройки нужны обеим.
const EMPTY = () => ({ order: [], collapsed: {}, pinned: [], open: {} });
const prefs = () => {
  let v = shared(PREFS);
  if (v == null) { try { v = JSON.parse(localStorage.getItem(PREFS) ?? "null"); } catch {} }
  return { ...EMPTY(), ...(v ?? {}) };
};
const setPrefs = (fn) => { const p = prefs(); fn(p); setShared(PREFS, p); };
const orderOf = (p) => [...p.order.filter((id) => SECTIONS[id]), ...Object.keys(SECTIONS).filter((id) => !p.order.includes(id))];
// Категории /context Claude: подпись и цвет как в окне контекста Claude; отложенные в окно не входят.
const CAT = {
  "Messages": ["Сообщения", BLUE], "System tools": ["Системные инструменты", "#e2763c"], "MCP tools": ["Инструменты MCP", "#4bae8f"],
  "MCP server instructions": ["Инструкции MCP", "#2a9d8f"], "Memory files": ["Файлы памяти", "#e0a030"], "Skills": ["Скиллы", "#b0b4ba"],
  "System prompt": ["Системный промпт", "#9aa0a6"], "Custom agents": ["Свои агенты", PURPLE],
  "Autocompact buffer": ["Запас автосжатия", "#5c6068"], "Free space": ["Свободно", null],
  "MCP tools (deferred)": ["MCP, отложенные", null], "System tools (deferred)": ["Системные, отложенные", null],
  // Codex (оценка по файлу сессии, сумма точная).
  "Tool calls": ["Вызовы инструментов", "#d4a72c"], "Reasoning": ["Рассуждения", "#7f6df2"], "Compacted history": ["Сжатая история", "#6c7a89"],
  "Images": ["Изображения", "#c76b98"], "Last reply": ["Последний ответ", "#2abb7f"], "Unaccounted": ["Не разобрано", "#5c6068"],
};
const CAT_TIP = {
  "Tool calls": "Вызовы и их результаты в истории. Самые тяжёлые ниже",
  "Reasoning": "Рассуждения текущего хода",
  "Compacted history": "Выжимка прошлой истории после сжатия",
  "Unaccounted": "Описания инструментов и прочее, чего нет в файле сессии",
};
const PR = { OPEN: ["git-pull-request", BLUE, "открыт"], DRAFT: ["git-pull-request-draft", GREY, "черновик"], MERGED: ["git-merge", PURPLE, "влит"], DECLINED: ["git-pull-request-closed", RED, "отклонён"], CLOSED: ["git-pull-request-closed", RED, "закрыт"] };

export default class YggPanel extends View {
  init(_p, cx) {
    this.data = null;
    this.key = null;
    // Старые настройки разделов из localStorage панели переезжают в shared один раз.
    if (!props()?.pins && shared(PREFS) == null) { try { const v = JSON.parse(localStorage.getItem(PREFS) ?? "null"); if (v) setShared(PREFS, v); } catch {} }
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
    // Терминалы вкладки: живые раньше закончившихся, хост чата раньше прочих.
    const mine = terminals().filter((x) => x.labels?.["herdr.tab"] === tab.id.split("/").pop() && (!sp.machine || x.address.startsWith(`${sp.machine}/`)))
      .sort((a, b) => (b.state === "live") - (a.state === "live") || (b.labels?.["herdr-chat.role"] === "host") - (a.labels?.["herdr-chat.role"] === "host"));
    const term = mine[0];
    const chat = panes().find((x) => x.tab === tab.id && x.mod === "chat");
    const argv = (term?.argv ?? []).join(" ");
    const kind = term?.labels?.["ygg.kind"] ?? (/codex/.test(argv) ? "codex" : /claude/.test(argv) ? "claude" : term?.report?.app ?? "");
    // Чат Codex сервера живёт во вкладке на Mac: его машина — в props чата.
    const host = mine.find((x) => x.labels?.["herdr-chat.role"] === "host" && x.state === "live") ?? (chat?.props?.chat ? terminals().find((x) => x.labels?.["herdr-chat.chat"] === chat.props.chat) : null);
    // Хост чата сервера запущен с --remote <машина>, даже если в props чата её нет.
    const hargv = host?.argv ?? [], ri = hargv.indexOf("--remote");
    const machine = sp.machine ?? chat?.props?.remote ?? (ri >= 0 ? hargv[ri + 1] : "") ?? "";
    return { key: `${tab.id}|${term?.address ?? ""}|${host?.address ?? ""}`, term: (host ?? term)?.address ?? "", cwd: chat?.props?.cwd ?? term?.cwd ?? sp.folder ?? "",
      kind, machine, sid: term?.labels?.["ygg.parked"] ?? "" };
  }

  fetch(cx) {
    const a = this.active();
    if (!a) { if (this.data) { this.data = null; cx.notify(); } return; }
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-panel/collect.mjs`, a.term, a.cwd, a.kind, "", a.sid, a.machine], { timeout: 10000 });
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

  limit(r, t, brand) {
    const color = r.pct >= 90 ? YELLOW : brand;
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

  // Заголовок раздела: шеврон и название сворачивают; при наведении — булавка и ручка перетаскивания.
  section(id, t, right, rows, p) {
    const collapsed = Boolean(p.collapsed[id]), pinned = p.pinned.includes(id), float = this.float;
    const over = this.drag && this.drag !== id && this.over === id;
    const head = h_flex().id(`h-${id}`).h(30).px(10).pt(6).flex_none().items_center().gap(4).text_size(12).text_color(t.muted)
      .on_hover((h, cx) => { this.hot = h ? id : this.hot === id ? null : this.hot; cx.notify(); })
      .on_mouse_move((_e, cx) => { if (this.drag && this.over !== id) { this.over = id; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag && this.drag !== id) { const from = this.drag; setPrefs((q) => { const o = orderOf(q).filter((x) => x !== from); o.splice(o.indexOf(id), 0, from); q.order = o; }); }
        this.drag = null; this.over = null; cx.notify();
      })
      .child(h_flex().id(`t-${id}`).gap(4).items_center().cursor_pointer().flex_1().min_w(0)
        .on_click((_e, cx) => { setPrefs((q) => { q.collapsed[id] = !collapsed; }); cx.notify(); })
        .child(svg(`${ICONS}/${collapsed ? "chevron-right" : "chevron-down"}.svg`).size(12).text_color(t.dim))
        .child(div().truncate().child(SECTIONS[id])))
      .when(right != null, (el) => el.child(div().text_color(t.dim).child(right)))
      .when(float || this.hot === id || pinned, (el) => el.child(h_flex().id(`pin-${id}`).size(20).items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(pinned ? "Закреплено рядом с сессией. Клик — открепить" : "Закрепить рядом с сессией")
        .on_click((_e, cx) => { setPrefs((q) => { q.pinned = pinned ? q.pinned.filter((x) => x !== id) : [...q.pinned, id]; }); cx.notify(); })
        .child(svg(`${ICONS}/pin.svg`).size(12).text_color(pinned ? BLUE : t.dim))))
      .when(!float && this.hot === id, (el) => el.child(h_flex().id(`grip-${id}`).size(20).items_center().justify_center().rounded(4).cursor_pointer()
        .tooltip("Перетащить раздел").on_mouse_down("left", (_e, cx) => { this.drag = id; this.over = id; cx.notify(); })
        .child(svg(`${ICONS}/grip-vertical.svg`).size(12).text_color(t.dim))));
    return v_flex().flex_none().relative().when(this.drag === id, (el) => el.opacity(0.5))
      .when(over, (el) => el.child(div().absolute().left(0).right(0).top(0).h(2).bg(BLUE)))
      .child(head).when(!collapsed, (el) => el.children(rows.filter(Boolean)).child(div().h(6)));
  }

  envRows(d, t) {
    const r = d.repo, rows = [];
    rows.push(this.row(svg(`${ICONS}/${d.machine ? "server" : "laptop"}.svg`).size(15).text_color(t.muted), d.machine ? `Сервер ${d.machine}` : "Этот компьютер", null, t));
    if (r) {
      rows.push(this.row(svg(`${ICONS}/folder.svg`).size(15).text_color(t.muted),
        h_flex().gap(6).min_w(0).child(div().truncate().child(r.folder)).child(div().text_color(t.dim).truncate().child(r.parent ?? "")), null, t, d.cwd));
      if (r.branch) rows.push(this.row(svg(`${ICONS}/branch.svg`).size(15).text_color(t.muted), r.branch,
        r.worktree ? div().text_color(t.dim).child("worktree") : null, t, r.worktree ? "Ветка в отдельном worktree" : "Ветка"));
      if (r.files) rows.push(this.row(svg(`${ICONS}/diff.svg`).size(15).text_color(t.muted), `${r.files} файлов изменено`,
        h_flex().gap(6).child(div().text_color(GREEN).child(`+${r.add}`)).child(div().text_color(RED).child(`−${r.del}`)), t, "Незакоммиченные изменения"));
    }
    return rows;
  }

  // Контекст как в окне контекста Claude: полоса по категориям, строки с долей, раскрываемые списки.
  contextRows(d, t, p) {
    const c = d.context, b = d.breakdown, rows = [];
    if (!c && !b) return [this.row(null, "нет данных", null, t)];
    const used = b?.used ?? c.used, win = b?.window ?? c.window, pct = Math.round((used / win) * 100);
    rows.push(this.row(null, `Использовано ${pct}%`, div().text_color(t.dim).child(`${k(used)} / ${k(win)}`), t));
    // Codex не делит контекст по категориям: последний ход по токен-счётчику (кэш, новый ввод, ответ, рассуждения).
    const cx5 = c?.codex, codexCats = cx5 && !b ? [
      ["Ввод из кэша", cx5.cached, GREY, "Повторно прочитанный контекст, дешевле нового"],
      ["Новый ввод", cx5.input - cx5.cached, BRAND.codex, "Ввод, который модель прочла впервые"],
      ["Ответ", cx5.output - cx5.reasoning, GREEN, "Текст ответа и вызовы инструментов"],
      ["Рассуждения", cx5.reasoning, PURPLE, "Скрытые рассуждения модели"],
    ].filter((x) => x[1] > 0) : [];
    const cats = (b?.cats ?? []).filter((x) => CAT[x.name]?.[1] || !CAT[x.name]);
    rows.push(cats.length ? this.bar(cats.map((x) => [(x.tokens / win) * 100, CAT[x.name]?.[1] ?? GREY]), t)
      : codexCats.length ? this.bar(codexCats.map((x) => [(x[1] / win) * 100, x[2]]), t) : this.bar([[pct, pct >= 85 ? YELLOW : BLUE]], t));
    const line = (name, tokens, color, deferred, tip) => h_flex().h(24).px(14).gap(8).flex_none().items_center().text_color(deferred ? t.dim : t.foreground)
      .child(div().size(9).rounded(2).flex_none().when(Boolean(color), (el) => el.bg(color)).when(!color, (el) => el.border_1().border_color(t.border)))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .child(div().text_color(t.dim).child(k(tokens)))
      .child(h_flex().w(46).flex_none().justify_end().text_color(t.muted).child(deferred ? "" : `${((tokens / win) * 100).toFixed(1)}%`))
      .when(Boolean(tip), (el) => el.id(`c-${name}`).tooltip(tip));
    for (const x of b?.cats ?? []) {
      const [name, color] = CAT[x.name] ?? [x.name, GREY];
      rows.push(line(name, x.tokens, color, /deferred/.test(x.name), /deferred/.test(x.name) ? "Подгружаются по запросу, в окно не входят" : CAT_TIP[x.name] ?? null));
    }
    for (const [name, tokens, color, tip] of codexCats) rows.push(line(name, tokens, color, false, tip));
    const session = cx5?.session ?? b?.session;
    if (session) rows.push(this.row(null, "За всю сессию", div().text_color(t.dim).child(k(session)), t, "Сколько токенов сессия прошла за все ходы, с повторами контекста"));
    if (!b && d.agent === "claude") rows.push(this.row(null, "Разбивка считается", null, t));
    const fold = (key, title, items, tip) => {
      if (!items?.length) return;
      const open = Boolean(p.open[key]);
      rows.push(h_flex().id(`f-${key}`).h(24).px(14).gap(6).flex_none().items_center().cursor_pointer().text_color(t.muted)
        .tooltip(tip).on_click((_e, cx) => { setPrefs((q) => { q.open[key] = !open; }); cx.notify(); })
        .child(svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12))
        .child(div().flex_1().child(title)).child(div().text_color(t.dim).child(String(items.length))));
      if (open) for (const it of items) rows.push(h_flex().h(22).pl(32).pr(14).gap(8).flex_none().items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().child(it.name)).child(div().text_color(t.dim).child(k(it.tokens))));
    };
    fold("mcp", "Инструменты MCP по серверам", b?.mcp, "Сколько токенов описания инструментов у каждого MCP-сервера");
    fold("memory", "Файлы памяти", b?.memory?.map((m) => ({ name: m.path.replace(/^\/Users\/[^/]+/, "~"), tokens: m.tokens })), "CLAUDE.md, AGENTS.md и память, которые Claude читает в начале");
    fold("skills", "Скиллы", b?.skills, "Описания скиллов в контексте");
    fold("prompt", "Части системного промпта", b?.prompt, "Из каких блоков собран системный промпт");
    fold("tools", "Системные инструменты", b?.tools, "Описания встроенных инструментов по группам");
    fold("heavy", "Самые тяжёлые вызовы", b?.heavy?.map((h) => ({ name: `${h.name} ${h.arg}`, tokens: h.tokens })), "Вызовы инструментов, которые больше всего занимают в контексте");
    if (b?.estimated) rows.push(this.row(null, "Доли оценены по файлу сессии", null, t, "Codex не делит контекст по категориям: доли посчитаны по истории, сумма из счётчика Codex"));
    if (d.chat && !this.float) rows.push(this.row(this.compacting ? svg("mods/workspace-chrome/spinner.svg").size(15).text_color(BLUE).spin(900) : svg(`${ICONS}/fold.svg`).size(15).text_color(t.muted),
      this.compacting ? "Сжимаю сессию" : "Сжать сессию", null, t, "Сжать контекст сессии сейчас")
      .cursor_pointer().hover((s) => s.bg(t.hover)).rounded(6).mx(6).px(8).on_click((_e, cx) => this.compact(cx)));
    return rows;
  }

  limitRows(d, t) {
    const L = d.limits ?? {}, rows = [];
    rows.push(this.agentHead("claude", L.claude?.plan, t));
    if (L.claude?.rows?.length) for (const r of L.claude.rows) rows.push(this.limit(r, t, BRAND.claude));
    else rows.push(this.row(null, "считается", null, t, "Лимиты Claude приходят с ходом Claude Code, раз в 15 минут"));
    rows.push(this.agentHead("codex", L.codex?.plan, t));
    if (L.codex?.rows?.length) for (const r of L.codex.rows) rows.push(this.limit(r, t, BRAND.codex));
    else rows.push(this.row(null, "нет данных", null, t));
    if (L.codex?.credits != null) rows.push(this.row(null, "Кредиты", div().text_color(t.muted).child(String(L.codex.credits)), t, "Остаток кредитов Codex"));
    return rows;
  }

  prRows(d, t) {
    if (!d.prs?.length) return [this.row(null, d.prs ? "моих нет" : "загружаются", null, t)];
    return d.prs.map((x) => {
      const [icon, color, word] = PR[x.state] ?? PR.OPEN;
      return this.row(svg(`${ICONS}/${icon}.svg`).size(15).text_color(color), x.title, div().text_color(t.dim).child(`#${x.id}`), t, `${word}, ${x.branch ?? ""}`)
        .cursor_pointer().hover((s) => s.bg(t.hover)).rounded(6).mx(6).px(8)
        .on_click(() => { if (x.url) exec("open", [x.url]).catch(() => {}); });
    });
  }

  hookRows(t) {
    const groups = [];
    for (const h of this.hooks) {
      const name = h.plugin ? h.plugin.split("@")[0] : h.source.split("/").slice(-2).join("/");
      const g = groups.find((x) => x.name === name) ?? (groups.push({ name, hooks: [], modified: false }), groups.at(-1));
      g.hooks.push(h); g.modified ||= h.status === "modified";
    }
    return groups.map((g) => this.row(this.trusting === g.name ? svg("mods/workspace-chrome/spinner.svg").size(15).text_color(BLUE).spin(900) : svg(`${ICONS}/shield.svg`).size(15).text_color(YELLOW),
      g.name, div().text_color(t.dim).child(String(g.hooks.length)), t,
      `${g.modified ? "Плагин изменился" : "Новые хуки"}: ${g.hooks.map((h) => h.event).join(", ")} ждут одобрения. Клик — одобрить`)
      .cursor_pointer().hover((s) => s.bg(t.hover)).rounded(6).mx(6).px(8).on_click((_e, cx) => this.trust(g, cx)));
  }

  // Колонка закреплённого видна, только когда есть закреплённое и правая панель скрыта.
  // Сверяют обе копии и верхняя полоса: кто перерисовался, тот и поправит.
  syncPins(p) {
    const root = layout(), find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((f, c) => f ?? find(c, id), null));
    const pins = find(root, "pins"), panel = find(root, "panel");
    if (!pins) return;
    const want = p.pinned.length > 0 && Boolean(panel?.hidden);
    if (Boolean(pins.hidden) !== want || Date.now() - (this.pinsAt ?? 0) < 400) return;
    this.pinsAt = Date.now();
    run(want ? "layout.show" : "layout.hide", { id: "pins" });
  }

  render(cx) {
    const t = theme();
    // Копия в колонке «pins» рядом с чатом: закреплённые разделы карточками, как в Codex.
    // Колонку показывает и прячет верхняя полоса (ygg-tabs): видна, когда есть закреплённые и панель скрыта.
    this.float = Boolean(props()?.pins);
    const a = this.active();
    if (a?.key !== this.key) { this.key = a?.key; this.fetch(cx); }
    const d = this.data, p = prefs();
    this.syncPins(p);
    if (this.float && (!d || !p.pinned.length)) return div();
    if (!d) return v_flex().size_full().bg(t.chrome).text_size(13).text_color(t.foreground).child(this.row(null, "Нет данных", null, t));
    const parts = {
      env: () => this.section("env", t, null, this.envRows(d, t), p),
      context: () => this.section("context", t, null, this.contextRows(d, t, p), p),
      limits: () => this.section("limits", t, null, this.limitRows(d, t), p),
      prs: () => (d.repo?.remote ? this.section("prs", t, d.prs?.length ? String(d.prs.length) : null, this.prRows(d, t), p) : null),
      hooks: () => (this.hooks.length ? this.section("hooks", t, String(this.hooks.length), this.hookRows(t), p) : null),
      connectors: () => (d.connectors?.length ? this.section("connectors", t, String(d.connectors.filter((c) => c.on).length), d.connectors.map((c) => this.connector(c, t)), p) : null),
    };
    const ids = orderOf(p).filter((id) => !this.float || p.pinned.includes(id));
    const list = ids.map((id) => parts[id]()).filter(Boolean);
    if (this.float) return v_flex().size_full().min_h(0).gap(8).overflow_y_scrollbar().text_size(13).text_color(t.foreground)
      .children(list.map((x) => v_flex().flex_none().rounded(12).border_1().border_color(t.border).bg(t.chrome).pb(4).child(x)));
    const body = v_flex().pb(10).children(list.flatMap((x, i) => (i ? [div().mx(14).h(1).flex_none().bg(t.border), x] : [x])));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(body.flex_1().min_h(0).overflow_y_scrollbar());
  }
}
