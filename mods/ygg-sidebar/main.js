// ygg-sidebar: проекты → сессии деревом, как в Claude.
// Группы (Работа/Личное), алиас, иконка и цвет проекта — data/ygg-sidebar/projects.json
// (ключ — имя пространства в Herdr). Проект сворачивается кликом по строке.
// Клик по сессии: спящая (вкладка Yggdrasil с ygg.parked) на этом Mac открывается чатом
// herdr-chat на её сессии, остальные — переходом на свою вкладку.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, terminals, panes, machines, layout, shared, setShared, openOverlay, closeOverlay, props, run, theme, appHome, readTextFile, writeTextFile, exec } from "herdr";
import { randomBytes } from "crypto";

const ICONS = "mods/ygg-sidebar/icons";
const CONFIG = () => `${appHome()}/data/ygg-sidebar/projects.json`;
// Проекты, которые были открыты: Herdr убирает пространство с последней вкладкой, а проект в панели остаётся.
const KNOWN = () => `${appHome()}/data/ygg-sidebar/known.json`;
// Архив сессий: ушедшие из панели, их можно вернуть из меню проекта.
const ARCHIVE = () => `${appHome()}/data/ygg-sidebar/archive.json`;
const OPS = () => `${appHome()}/mods/ygg-sidebar/session-ops.mjs`;
const EXTERNAL = () => `${appHome()}/mods/ygg-sidebar/external.mjs`;
// Папка сессии относится к проекту: сама папка, внутри неё, её worktree (<папка>-worktrees/…)
// и worktree приложения Codex (~/.codex/worktrees/<id>/<имя папки>).
const inProject = (cwd, folder) => {
  if (!cwd || !folder) return false;
  const f = folder.replace(/\/$/, ""), name = f.split("/").pop();
  if (cwd === f || cwd.startsWith(`${f}/`) || cwd.startsWith(`${f}-worktrees/`)) return true;
  const m = cwd.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)/);
  return Boolean(m) && m[1] === name;
};
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
const ops = (...args) => exec("sh", ["-c", RUN, OPS(), ...args], { timeout: 40000 }).then((r) => JSON.parse(r.stdout || "{}")).catch((e) => ({ ok: false, error: String(e) }));
const copy = (text) => exec("sh", ["-c", 'printf %s "$0" | pbcopy', text]);
// ponytail: временный лог кликов, убрать после разбора.
const readJSON = async (file, d) => { try { return JSON.parse((await readTextFile(file)) ?? "null") ?? d; } catch { return d; } };
// Правка projects.json: перечитать, поменять, записать (expected — защита от чужой записи между ними).
const editConfig = async (fn) => {
  const raw = await readTextFile(CONFIG());
  const cfg = JSON.parse(raw ?? "{}");
  cfg.projects ??= {};
  fn(cfg.projects);
  await writeTextFile(CONFIG(), `${JSON.stringify(cfg, null, 2)}\n`, raw);
};
const LINE = "#3d3d40";
const ROW = 28;
const STUB = 14; // середина строки: туда приходит ветка
// Семантика Yggdrasil: работает синий, ждёт тебя жёлтый, готово зелёный, простой серый.
const C = { working: "#579dff", blocked: "#f5cd47", done: "#2abb7f", idle: "#9fadbc" };
// Машина: доступна зелёный, отвалилась красный, подключается серый.
const M = { ready: ["#2abb7f", "доступен"], unavailable: ["#f87168", "недоступен"], loading: ["#9fadbc", "подключается"] };
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const AGENT = { claude: "claude", "claude-code": "claude", codex: "codex", deepseek: "deepseek", dsh: "deepseek", "dsh-tui": "deepseek" };
const TIP = {
  working: "Агент работает. Клик — открыть сессию",
  blocked: "Агент ждёт тебя. Клик — открыть сессию",
  done: "Агент закончил, ты ещё не смотрел. Клик — открыть сессию",
  idle: "Сессия открыта, агент простаивает. Клик — открыть сессию",
  parked: "Сессия спит. Клик — продолжить её чатом",
  remote: "Сессия спит на сервере. Клик — продолжить её чатом",
};

// Сессия без заголовка паркуется с id треда вместо имени: показываем коротко.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (name, kind) => (!name ? "Без названия" : UUID.test(name) ? `Без названия · ${name.slice(0, 8)}` : name);
const top = (list) => list.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);

const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
// Порядок по сохранённому списку; новые в конце, в исходном порядке.
const byOrder = (list, order, key) => [...list].sort((a, b) => {
  const i = order.indexOf(key(a)), j = order.indexOf(key(b));
  return (i < 0 ? 1e9 : i) - (j < 0 ? 1e9 : j);
});
const move = (order, from, to) => { const o = order.filter((x) => x !== from); o.splice(Math.max(0, o.indexOf(to)), 0, from); return o; };

const find = (n, id) => { if (!n || typeof n !== "object") return null; if (n.id === id) return n; for (const c of n.children ?? []) { const r = find(c, id); if (r) return r; } return null; };
// Свёрнутая панель у Herdr — это узкая ширина (как в workspace-chrome), не флаг.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const unfold = () => { setShared("sidebar.collapsed", false); run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 }); };

export default class YggSidebar extends View {
  init(_p, cx) {
    this.popup = props()?.popup ?? null; // копия мода во всплывашке свёрнутой панели
    this.menu = props()?.menu ?? null; // копия мода в меню проекта (правый клик)
    this.smenu = props()?.smenu ?? null; // копия мода в меню сессии: { tab, space }
    this.view = props()?.view ?? null; // подменю проекта: "merge" | "group"
    this.archive = [];
    this.known = {};
    this.cfg = { groups: ["Работа", "Личное"], projects: {} };
    this.folded = new Set(loadJSON("ygg.folded", []));
    this.pins = new Set(loadJSON("ygg.pins", [])); // "p:<проект>", "s:<вкладка>"
    this.order = loadJSON("ygg.order", []); // проекты
    this.sorder = loadJSON("ygg.sorder", {}); // проект -> вкладки
    this.groupOf = loadJSON("ygg.groupOf", {});
    // Перенос старых перетаскиваний между группами из памяти мода в projects.json.
    if (Object.keys(this.groupOf).length) {
      const old = this.groupOf;
      editConfig((pr) => { for (const [k, g] of Object.entries(old)) { pr[k] = { ...pr[k], group: g }; if (g === "Без группы") delete pr[k].group; } })
        .then(() => save("ygg.groupOf", {})).catch(() => {});
    }
    this.more = new Set(loadJSON("ygg.more", [])); // проекты, где показаны все сессии // проект, перетащенный в другую группу
    this.drag = null; // { type: "p"|"s", id, scope }
    this.over = null;
    this.hovered = null;
    const load = (cx) => cx.spawn(async (cx) => {
      try {
        const txt = await readTextFile(CONFIG());
        if (txt && txt !== this.raw) { this.raw = txt; this.cfg = { ...this.cfg, ...JSON.parse(txt) }; cx.notify(); }
      } catch {}
      this.archive = await readJSON(ARCHIVE(), []);
      try {
        const k = await readTextFile(KNOWN());
        if (k && k !== this.knownRaw) { this.knownRaw = k; this.known = JSON.parse(k); cx.notify(); }
      } catch {}
    });
    load(cx);
    cx.timer.every(3000, load); // правки projects.json видны без перезапуска
    // Сессии, начатые вне Herdr (приложения Claude и Codex, Codex на сервере): опрашивает только основная панель,
    // копии (меню, всплывашка) берут готовое из shared.
    if (!this.menu && !this.smenu && !this.popup) {
      this.scanExternal(cx);
      cx.timer.every(30000, (cx) => this.scanExternal(cx));
    }
  }

  scanExternal(cx) {
    if (this.scanning) return;
    this.scanning = true;
    const ms = [...new Set([...spaces(), ...Object.values(this.known)].map((x) => x.machine).filter(Boolean))]
      .filter((m) => machines().find((x) => x.name === m)?.layout === "ready");
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", RUN, EXTERNAL(), ...ms], { timeout: 60000 });
        const d = JSON.parse(r.stdout || "null");
        if (d) { const old = shared("ygg.ext"); for (const m of ms) if (!d.machines[m] && old?.machines?.[m]) d.machines[m] = old.machines[m]; setShared("ygg.ext", d); cx.notify(); }
      } catch {}
      this.scanning = false;
    });
  }

  // Сессии проекта, начатые вне Herdr и ещё не открытые здесь.
  external(ss, taken) {
    const d = shared("ygg.ext");
    if (!d) return [];
    const known = new Set([...(d.mac?.known ?? []), ...taken]);
    const out = [], seen = new Set();
    for (const sp of ss) {
      const list = sp.machine ? d.machines?.[sp.machine]?.items : d.mac?.items;
      for (const e of list ?? []) {
        if (known.has(e.id) || seen.has(e.id) || this.archive.some((a) => String(a.session ?? "").includes(e.id)) || !inProject(e.cwd, sp.folder)) continue;
        seen.add(e.id);
        out.push({ s: sp, ext: e });
      }
    }
    return out.sort((a, b) => b.ext.at - a.ext.at);
  }

  // Открыть здесь сессию, начатую вне Herdr. Занятую приложением Claude — копией (форк), иначе два процесса
  // пишут в один файл сессии. Codex сервера — чатом во вкладке этого Mac, как и свои спящие.
  async openExternal(sp, e) {
    if (this.popup) { setShared("ygg.popHover", false); closeOverlay(props().overlay); }
    let to = sp.id;
    if (sp.machine) to = await this.hostSpace(sp);
    else if (!to) [to] = await this.ensure([sp]);
    if (!to) return;
    run("space.select", { id: to });
    let session = e.id, name = e.title;
    if (e.busy && e.kind === "claude") {
      const r = await ops("fork", "claude", e.id, e.cwd);
      if (!r?.ok) return;
      session = r.path; name = `${e.title} · копия`;
    }
    await this.openChat(to, name, e.kind, e.cwd, session, sp.machine ?? null);
  }

  extNode(sp, e, last, t) {
    const remote = Boolean(sp.machine);
    const busy = e.busy;
    const row = h_flex().id(`ext-${e.id}`).relative().h(ROW).px(6).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.openExternal(sp, e); cx.notify(); })
      .child(div().flex_none().opacity(0.55).child(this.agentIcon(e.kind, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(label(e.title, e.kind)))
      .when(remote, (el) => el.child(this.machineMark(sp.machine, t)))
      .child(this.slot(busy ? div().id(`busy-${e.id}`).tooltip("Открыта в приложении Claude. Клик — копия здесь")
        .child(svg(`${ICONS}/app-window.svg`).size(12).text_color(C.working)) : null));
    return v_flex().relative().child(this.branch(last)).child(row);
  }

  fold(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    save("ygg.folded", [...this.folded]);
    cx.notify();
  }

  pin(key, cx) {
    this.pins.has(key) ? this.pins.delete(key) : this.pins.add(key);
    save("ygg.pins", [...this.pins]);
    cx.notify();
  }

  // Перетаскивание: нажал на строку, отпустил на другой того же вида — перенос; на той же — клик.
  draggable(el, type, id, scope, onClick) {
    const target = this.drag && this.drag.type === type && this.drag.id !== id && (type === "p" || this.drag.scope === scope) && this.over === id;
    return el
      .when(this.drag?.id === id && this.over && this.over !== id, (e) => e.opacity(0.4))
      .when(Boolean(target), (e) => e.child(div().absolute().left(0).right(0).top(0).h(2).bg(C.working)))
      .on_mouse_down("left", () => { this.drag = { type, id, scope }; this.over = id; })
      .on_mouse_move((_e, cx) => { if (this.drag && this.over !== id) { this.over = id; cx.notify(); } })
      .on_mouse_up("left", (e, cx) => {
        const d = this.drag;
        this.drag = null; this.over = null;
        if (!d) return;
        if (d.id === id) onClick(e, cx);
        else if (d.type === type && type === "p") this.dropProject(d.id, id, scope);
        else if (d.type === type && d.scope === scope) { this.sorder[scope] = move(this.sorder[scope] ?? [], d.id, id); save("ygg.sorder", this.sorder); }
        cx.notify();
      });
  }

  dropProject(from, to, group) {
    // Группа живёт в projects.json, как и в окне настроек; groupOf остаётся до записи файла, чтобы строка не мигала.
    const conf = this.cfg.projects?.[from] ?? {};
    if ((conf.group ?? "Без группы") !== group) {
      this.groupOf[from] = group;
      editConfig((pr) => { pr[from] = { ...pr[from], group }; if (group === "Без группы") delete pr[from].group; });
    }
    this.order = move(this.order, from, to);
    save("ygg.order", this.order);
  }

  remember(live) {
    let changed = false;
    for (const x of live) {
      const k = this.known[x.name];
      const folder = (x.folder ?? "").replace(/-worktrees\/[^/]+\/?$/, ""); // корень проекта, не worktree задачи
      if (!folder || (k && k.folder === folder && (k.machine ?? null) === (x.machine ?? null))) continue;
      this.known[x.name] = { folder, machine: x.machine ?? null }; changed = true;
    }
    if (changed && !this.menu && !this.popup) {
      const text = `${JSON.stringify(this.known, null, 2)}\n`;
      writeTextFile(KNOWN(), text, this.knownRaw ?? null).then(() => { this.knownRaw = text; }, () => {});
    }
  }

  // Пространства проекта: убранные Herdr заводим заново (в той же папке и на той же машине).
  async ensure(ss) {
    for (const x of ss.filter((y) => y.absent)) run("space.new", { name: x.name, folder: x.folder, machine: x.machine ?? "", focus: false });
    for (let i = 0; i < 20 && ss.some((x) => x.absent && !spaces().some((y) => y.name === x.name)); i++) await new Promise((r) => setTimeout(r, 150));
    return ss.map((x) => (x.absent ? spaces().find((y) => y.name === x.name)?.id : x.id)).filter(Boolean);
  }

  // Меню проекта: объединить с другим, архив его сессий, разъединить, убрать пустой, файл настроек.
  // Высота окна считается заранее (menuHeight): всплывашка не растёт под содержимое.
  menuItems(r) {
    const archived = this.archive.filter((a) => r.ss.some((x) => x.name === a.space)).slice(0, 6);
    return { archived, split: r.ss.length > 1, absent: r.ss.every((x) => x.absent) };
  }
  menuHeight(r) {
    const m = this.menuItems(r);
    return 12 + 28 + 28 + 9 + (m.archived.length ? 24 + m.archived.length * 28 + 9 : 0) + (m.split ? 28 : 0) + (m.absent ? 28 : 0) + 28;
  }

  menuView(rows, t) {
    const r = rows.find((x) => x.s.name === this.menu);
    if (!r) return div();
    const close = () => closeOverlay(props().overlay);
    const item = (id, icon, text, tip, act, right = null) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_click((_e, cx) => act(cx))
      .child(icon).child(div().flex_1().min_w(0).truncate().child(text)).when(Boolean(right), (el) => el.child(right));
    const ico = (name, color = t.muted) => svg(`${ICONS}/${name}.svg`).size(14).flex_none().text_color(color);
    const head = (text) => div().h(24).px(8).pt(6).text_size(11).text_color(t.dim).child(text.toUpperCase());
    const line = () => div().h(1).my(4).bg(t.border);
    // Сначала дело, потом закрыть меню: меню — отдельное окно, с ним пропадает и незаконченная работа пункта.
    const done = (fn) => async (cx) => { try { await fn(cx); } finally { close(); } };
    const root = v_flex().w_full().bg(t.popover ?? t.chrome).p(6).text_size(13).text_color(t.foreground);
    const others = rows.filter((x) => x !== r);
    // Подменю открываем заново своей высоты: всплывашка не растёт, а список в 1 строку не видно.
    const sub = (view, n) => () => {
      close();
      openOverlay({ mod: "ygg-sidebar", kind: "popup", width: 280, height: view ? 12 + 28 + 9 + Math.min(n, 12) * 28 : this.menuHeight(r),
        at: props().at, props: { menu: r.s.name, at: props().at, view } });
    };
    const back = (text) => item("back", ico("chevron-left"), text, "Клик — назад к меню проекта", sub(null));
    const setAll = (patch) => done(() => editConfig((pr) => { for (const x of r.ss) {
      pr[x.name] = { ...pr[x.name], ...patch };
      for (const k of Object.keys(patch)) if (patch[k] == null) delete pr[x.name][k];
    } }));
    if (this.view === "merge") {
      return root.child(back(`Объединить «${r.title}» с`)).child(line())
        .child(v_flex().id("merge-list").h(Math.min(others.length, 12) * 28).overflow_y_scrollbar().children(others.map((o) =>
          item(`merge-${o.s.name}`, ico(o.conf.icon ?? "folder", o.conf.color ?? t.muted), o.title,
            `Один проект «${o.title}», сессии обоих вместе. Клик — объединить`,
            setAll({ alias: o.title, group: o.conf.group ?? null, icon: o.conf.icon ?? null, color: o.conf.color ?? null })))));
    }
    if (this.view === "group") {
      const gs = [...(this.cfg.groups ?? []), "Без группы"];
      return root.child(back(`Группа «${r.title}»`)).child(line())
        .child(v_flex().id("group-list").h(Math.min(gs.length + 1, 12) * 28).overflow_y_scrollbar()
          .children(gs.map((g) => item(`group-${g}`, ico("folder", g === r.group ? t.foreground : t.dim), g, null,
            g === r.group ? done(() => {}) : setAll({ group: g === "Без группы" ? null : g })).when(g === r.group, (el) => el.bg(t.selected))))
          .child(item("group-new", ico("plus"), "Новая группа", "Клик — назвать группу в настройках, проект попадёт в неё",
            done(() => openOverlay({ mod: "ygg-settings", kind: "dialog", width: 640, height: 560, props: { newGroupFor: r.ss.map((x) => x.name) } })))));
    }
    const m = this.menuItems(r);
    return root
      .child(item("merge", ico("merge"), "Объединить с проектом", "Два проекта под одним именем, например Mac и сервер. Клик — выбрать проект",
        sub("merge", others.length), svg(`${ICONS}/chevron-right.svg`).size(12).text_color(t.dim)))
      .child(item("group", ico("folder-input"), "Группа", `Сейчас «${r.group}». Клик — выбрать группу`,
        sub("group", (this.cfg.groups ?? []).length + 2), h_flex().gap(4).items_center()
          .child(div().max_w(90).truncate().text_size(12).text_color(t.dim).child(r.group))
          .child(svg(`${ICONS}/chevron-right.svg`).size(12).text_color(t.dim))))
      .child(line())
      .when(m.archived.length > 0, (el) => el.child(head("Архив")).children(m.archived.map((a, i) =>
        item(`restore-${i}`, ico("archive-restore"), a.name ?? "Без названия", `В архиве с ${new Date(a.at).toLocaleDateString("ru")}. Клик — вернуть чатом`, done(async () => {
          if (!a.session || a.machine) return;
          if (a.kind === "codex") await ops("unarchive", "codex", a.session);
          const [to] = await this.ensure(r.ss.filter((x) => x.name === a.space));
          if (to) await this.openChat(to, a.name, a.kind, a.cwd, a.session);
          const raw = await readTextFile(ARCHIVE());
          const list = JSON.parse(raw ?? "[]").filter((x) => !(x.at === a.at && x.session === a.session));
          await writeTextFile(ARCHIVE(), `${JSON.stringify(list, null, 2)}\n`, raw);
        })))).child(line()))
      .when(m.split, (el) => el.child(item("split", ico("split"), "Разъединить", "Каждое место проекта снова отдельным проектом. Клик — разъединить",
        done(() => editConfig((pr) => { for (const x of r.ss) if (x !== r.s) pr[x.name] = { ...pr[x.name], alias: `${r.title} · ${x.machine ?? x.name}` }; })))))
      .when(m.absent, (el) => el.child(item("forget", ico("eye-off"), "Убрать из панели", "Проект без сессий. Клик — больше не показывать (папка не трогается)",
        done(async () => { const raw = await readTextFile(KNOWN()); const k = JSON.parse(raw ?? "{}"); for (const x of r.ss) delete k[x.name]; await writeTextFile(KNOWN(), `${JSON.stringify(k, null, 2)}\n`, raw); }))))
      .child(item("settings", ico("settings"), "Настройки панели", "Проекты, группы, иконки и число сессий. Клик — открыть настройки", done(() => openOverlay({ mod: "ygg-settings", kind: "dialog", width: 640, height: 560 }))));
  }

  // Файл или id сессии вкладки: спящая знает id, чат — путь в своём состоянии.
  async sessionOf(info) {
    if (info.chatId) { const st = await readJSON(`${appHome()}/data/herdr-chat/chats/${info.chatId}.json`, {}); if (st.sessionFile) return st.sessionFile; }
    return info.sleepId ?? null;
  }

  // Открыть сессию чатом во вкладке пространства (путь к файлу: у Claude по голому id заводится новая).
  async openChat(spaceId, name, kind, cwd, session, machine = null) {
    // На сервере файл сессии не ищем: хост продолжает тред Codex по id в демоне машины.
    // DeepSeek (ACP) продолжает сессию по id, файла не ищем.
    const found = !machine && session && !session.startsWith("/") && kind !== "deepseek" ? (await ops("find", kind, session)).path : session;
    const remote = machine ? await sshTarget(machine) : null;
    run("tab.new", { space: spaceId, name, mod: "chat", props: { chat: `c-${randomBytes(4).toString("hex")}`, provider: kind, cwd, session: found ?? session, ...(remote ? { remote } : {}) } });
  }

  // Меню сессии (правый клик): переименовать, закрепить, форк, перенести, скопировать, архивировать.
  sessionMenu(rows, tabTerms, ps, kids, t) {
    const { tab: tabId, space: spaceId } = this.smenu;
    const s = spaces().find((x) => x.id === spaceId);
    const tab = s?.tabs?.find((x) => x.id === tabId);
    if (!s || !tab) return div();
    const info = this.session(tab, tabTerms, ps, kids);
    const local = !s.machine, agent = Boolean(info.kind) && Boolean(info.chat || info.sleepId);
    const close = () => closeOverlay(props().overlay);
    const why = !local ? "она на сервере" : "это не сессия агента";
    // Пункт меню: значок, подпись, справа — подсказка-стрелка. Недоступный — серый, в подсказке почему.
    const item = (id, icon, text, tip, act, on = true, right = null) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6)
      .text_color(on ? t.foreground : t.dim).when(!on, (el) => el.tooltip(`Недоступно: ${why}`))
      .when(on, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => act(cx)))
      .child(svg(`${ICONS}/${icon}.svg`).size(14).flex_none().text_color(on ? t.muted : t.dim))
      .child(div().flex_1().min_w(0).truncate().child(text))
      .when(Boolean(right), (el) => el.child(right));
    const line = () => div().h(1).my(4).bg(t.border);
    const pinned = this.pins.has(`s:${tab.id}`);
    const cwd = info.cwd || s.folder;
    const here = rows.find((r) => r.ss.some((x) => x.id === s.id));
    const targets = rows.filter((r) => r !== here && r.ss.some((x) => !x.machine));
    const root = v_flex().w_full().bg(t.popover ?? t.chrome).p(6).text_size(13).text_color(t.foreground);
    if (this.view === "move") {
      return root
        .child(item("back", "chevron-left", "Перенести в проект", "Клик — назад к меню сессии", (cx) => { this.view = null; cx.notify(); }))
        .child(line())
        .child(v_flex().id("move-list").h(186).overflow_y_scrollbar().children(targets.map((r) =>
          h_flex().id(`move-${r.s.name}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
            .on_click(async () => {
              close();
              const id = await this.sessionOf(info);
              const [to] = await this.ensure(r.ss.filter((x) => !x.machine));
              if (!id || !to) return;
              await this.openChat(to, tab.name, info.kind, cwd, id);
              run("tab.close", { id: tab.id });
            })
            .child(svg(`${ICONS}/${r.conf.icon ?? "folder"}.svg`).size(14).flex_none().text_color(r.conf.color ?? t.muted))
            .child(div().flex_1().min_w(0).truncate().child(r.title)))));
    }
    // Сначала дело, потом закрыть меню: меню — отдельное окно, с ним пропадает и незаконченная работа пункта.
    const done = (fn) => async (cx) => { try { await fn(cx); } finally { close(); } };
    return root
      .child(item("rename", "pencil", "Переименовать", "Имя сессии в панели. Клик — переименовать", done(() => run("tab.rename", { id: tab.id }))))
      .child(item("pin", "pin", pinned ? "Открепить" : "Закрепить", pinned ? "Сессия наверху панели. Клик — открепить" : "Клик — закрепить наверху панели",
        done(() => setShared("ygg.pinCmd", { key: `s:${tab.id}`, n: Date.now() }))))
      .child(line())
      .child(item("fork", "git-branch", "Форк", "Новая сессия с той же перепиской, дальше идёт отдельно. Клик — сделать форк", done(async () => {
        const id = await this.sessionOf(info);
        const r = id && await ops("fork", info.kind, id, cwd);
        if (r?.ok) this.openChat(s.id, `${tab.name ?? "Сессия"} · форк`, info.kind, cwd, r.path);
      }), local && agent))
      .child(item("move", "folder-input", "Перенести в проект", "Сессия продолжится в другом проекте. Клик — выбрать проект",
        (cx) => { this.view = "move"; cx.notify(); }, local && agent, svg(`${ICONS}/chevron-right.svg`).size(12).text_color(t.dim)))
      .child(line())
      .child(item("copy-cmd", "terminal", "Скопировать команду продолжения", "Команда, которая откроет эту сессию в терминале. Клик — скопировать", done(async () => {
        const id = await this.sessionOf(info);
        const bare = String(id ?? "").split("/").pop().replace(/\.jsonl$/, "").replace(/^rollout-.*?-([0-9a-f]{8}-[0-9a-f-]{27})$/, "$1");
        copy(info.kind === "codex" ? `cd ${cwd} && codex resume ${bare}` : `cd ${cwd} && claude --resume ${bare}`);
      }), agent))
      .child(item("copy-dir", "copy", "Скопировать путь к папке", `${cwd}. Клик — скопировать`, done(() => copy(cwd))))
      .child(line())
      // Вкладка без агента (терминал, у которого агент завершился): архивировать нечего, на месте архива пункт «Закрыть».
      .child(!info.kind ? item("close", "x", "Закрыть", "Терминал без агента. Клик — закрыть вкладку", done(() => run("tab.close", { id: tab.id, confirmed: true })))
        : item("archive", "archive", "Архивировать", "Сессия уходит из панели, вернуть её можно из меню проекта (правый клик). Клик — архивировать", done(async () => {
        const id = await this.sessionOf(info);
        if (info.kind === "codex" && local && id) await ops("archive", "codex", id);
        const raw = await readTextFile(ARCHIVE()).catch(() => null);
        const list = JSON.parse(raw ?? "[]");
        list.unshift({ name: tab.name ?? null, kind: info.kind, session: id, cwd, space: s.name, machine: s.machine ?? null, at: Date.now() });
        await writeTextFile(ARCHIVE(), `${JSON.stringify(list, null, 2)}\n`, raw ?? null);
        run("tab.close", { id: tab.id, confirmed: true });
      })));
  }

  // «+» у проекта: окно новой сессии (ygg-new) с местами запуска этого проекта.
  newButton(ss, title, conf, t, show) {
    return div().id(`new-${ss[0].name}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
      .when(!show, (e) => e.opacity(0))
      .hover((st) => st.bg(t.hover))
      .tooltip("Новая сессия")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation(); this.drag = null;
        this.ensure(ss).then((ids) => openOverlay({ mod: "ygg-new", kind: "dialog", width: 720, height: 210, props: { spaces: ids, title, icon: conf.icon, color: conf.color } }));
      })
      .child(svg(`${ICONS}/plus.svg`).size(13).text_color(t.muted));
  }

  pinButton(key, t, show) {
    const on = this.pins.has(key);
    return div().id(`pin-${key}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
      .when(!on && !show, (e) => e.opacity(0))
      .hover((st) => st.bg(t.hover))
      .tooltip(on ? "Открепить" : "Закрепить")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drag = null; this.pin(key, cx); })
      .child(svg(`${ICONS}/pin.svg`).size(12).text_color(on ? t.foreground : t.dim));
  }

  // Что за сессия во вкладке: агент, статус, спит ли, id сессии для чата.
  session(tab, tabTerms, ps, kids) {
    const ts = tabTerms.get(tab.id) ?? [];
    const mine = ps.filter((p) => p.tab === tab.id);
    const chatPane = mine.find((p) => p.mod === "chat");
    let kind = null, parked = null, cwd = null, chatId = null;
    for (const t of ts) {
      const l = t?.labels ?? {};
      // Вкладки, запаркованные без меток (codex1), узнаются по команде: codex resume / claude --resume.
      const argv = (t?.argv ?? []).join(" ");
      const byArgv = /\bcodex\b/.test(argv) ? "codex" : /\bclaude\b/.test(argv) ? "claude" : /\bdsh(-tui)?\b/.test(argv) ? "deepseek" : null;
      kind ??= AGENT[l["ygg.kind"]] ?? AGENT[l["herdr-chat.provider"]] ?? AGENT[t.report?.app] ?? AGENT[t.program?.key] ?? byArgv;
      // Codex, проснувшийся в терминале (codex resume <id>), тоже знает свой тред: по нему откроется чат.
      parked ??= l["ygg.parked"] ?? (kind === "codex" ? argv.match(/\bresume\b.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] : null) ?? null;
      chatId ??= l["herdr-chat.chat"] ?? null;
      cwd ??= t?.cwd ?? null;
    }
    if (!kind && chatPane) kind = AGENT[tab.name?.toLowerCase()] ?? "claude";
    const st = tab.status ?? top(ts.map((t) => t.status).filter(Boolean));
    const status = st === "error" ? "blocked" : st;
    const subs = ts.flatMap((t) => kids.get(t.address) ?? []);
    chatId ??= chatPane?.props?.chat ?? null;
    return { kind, status, parked: !status && parked ? parked : null, sleepId: parked, chatId, cwd, subs, chat: Boolean(chatPane) };
  }
  // Чат Codex сервера живёт во вкладке на этом Mac: herdr-chat находит свою вкладку только в раскладке
  // этого Mac. Вкладка встаёт в здешнее пространство того же проекта (его нет — заводится). Пространство
  // на сервере не закрывается: последняя его вкладка остаётся, в ней только гасится терминал.
  async hostSpace(s) {
    const title = (x) => this.cfg.projects?.[x]?.alias ?? x;
    let to = spaces().find((x) => !x.machine && title(x.name) === title(s.name))?.id;
    if (!to) {
      const [name, k] = Object.entries(this.known).find(([n, v]) => !v.machine && title(n) === title(s.name)) ?? [];
      const home = (await exec("sh", ["-c", "echo $HOME"])).stdout.trim();
      [to] = await this.ensure([{ name: name ?? title(s.name), folder: k?.folder ?? home, absent: true }]);
    }
    return to;
  }
  async remoteChat(s, tab, info) {
    const to = await this.hostSpace(s);
    if (!to) return run("tab.select", { id: tab.id });
    await this.openChat(to, tab.name, "codex", info.cwd || s.folder, info.sleepId, s.machine);
    if ((s.tabs?.length ?? 0) > 1) return run("tab.close", { id: tab.id });
    const own = tab.id.split("/").pop();
    for (const t of terminals().filter((x) => x.address.startsWith(`${s.machine}/`) && x.labels?.["herdr.tab"] === own))
      exec("sh", ["-c", 'PATH="$HOME/.local/bin:$PATH" exec hc kill "$0"', t.address]).catch(() => {});
  }
  open(s, tab, info) {
    if (this.popup) { setShared("ygg.popHover", false); closeOverlay(props().overlay); }
    run("space.select", { id: s.id });
    // Codex на сервере открывается чатом и спящий, и проснувшийся в терминале, пока он не занят ходом
    // или вопросом: терминал закрывается, тред продолжает демон Codex машины.
    const busy = info.status === "working" || info.status === "blocked";
    if (s.machine && info.kind === "codex" && info.sleepId && !info.chat && !busy) {
      this.remoteChat(s, tab, info);
    } else if (info.parked && !s.machine && info.kind) {
      // herdr-chat ждёт у Claude путь к файлу сессии: по голому id он заводит новую с тем же id
      // и Claude отвечает «Session ID … is already in use». Codex без пути открывается без истории.
      const id = info.parked;
      const find = info.kind === "claude"
        ? 'ls "$HOME"/.claude/projects/*/"$0".jsonl 2>/dev/null | head -1'
        : 'ls "$HOME"/.codex/sessions/*/*/*/rollout-*-"$0".jsonl "$HOME"/.codex/archived_sessions/rollout-*-"$0".jsonl 2>/dev/null | head -1';
      const where = exec("sh", ["-c", find, id]).then((r) => r.stdout.trim() || id).catch(() => id);
      where.then((session) => {
        const chat = `c-${randomBytes(4).toString("hex")}`;
        run("tab.new", { space: s.id, name: tab.name, mod: "chat", props: { chat, provider: info.kind, cwd: info.cwd || s.folder, session } });
        run("tab.close", { id: tab.id });
      });
      return;
    }
    run("tab.select", { id: tab.id });
  }

  // Сервер — всегда один значок без подписи: имя и состояние в подсказке.
  machineMark(name, t, what = "Сессия работает там") {
    const st = machines().find((m) => m.name === name)?.layout ?? "loading";
    const [color, word] = M[st] ?? M.loading;
    return div().id(`srv-${name}`).size(14).flex_none().flex().items_center().justify_center()
      .tooltip(`${name} ${word}`)
      .child(svg(`${ICONS}/server.svg`).size(12).text_color(color));
  }

  // Колонка статуса у правого края: одной ширины у проектов и сессий, чтобы значки стояли в линию.
  slot(el) { return div().w(14).flex_none().flex().items_center().justify_center().when(Boolean(el), (d) => d.child(el)); }

  // Кнопки строки появляются поверх правого края только при наведении, места в строке не занимают.
  actions(buttons, bg) {
    // Подсветка строки полупрозрачная: под ней сплошной фон панели, иначе сквозь кнопки видны значки статуса.
    return div().absolute().right(0).top(0).bottom(0).rounded(6).bg(theme().chrome)
      .child(h_flex().h_full().pl(6).pr(4).gap(2).items_center().rounded(6).bg(bg).children(buttons));
  }

  agentIcon(kind, t, size = 15) {
    if (kind) return image(`${ICONS}/${kind === "deepseek" ? "deepseek-badge" : kind}.svg`).w(size).h(size).flex_none();
    return svg(`${ICONS}/command.svg`).size(size - 2).flex_none().text_color(t.dim);
  }

  mark(info, remote, t) {
    if (info.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(C.working).spin(900);
    if (info.status === "blocked") return div().size(14).flex_none().rounded(4).bg(C.blocked).text_size(10).font_bold().text_color("#1d2125").flex().items_center().justify_center().child("!");
    if (info.status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(C.done);
    if (info.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(C.idle);
    if (info.parked || remote) return svg(`${ICONS}/moon.svg`).size(11).flex_none().text_color(t.dim);
    return div().size(7).mx(3).flex_none();
  }

  // Ветка дерева слева от узла: сквозная линия, если ниже есть соседи, иначе уголок.
  branch(last) {
    return last
      ? div().absolute().left(-STUB).top(0).w(10).h(STUB).border_l_1().border_b_1().border_color(LINE).rounded_bl(6)
      : div().absolute().left(-STUB).top(0).bottom(0).w(10)
          .child(div().absolute().left(0).top(0).bottom(0).w(1).bg(LINE))
          .child(div().absolute().left(0).top(STUB).w(10).h(1).bg(LINE));
  }

  sessionNode(s, tab, info, last, t, flat = false) {
    const remote = Boolean(s.machine);
    const sleeping = !info.status;
    const tip = info.status ? TIP[info.status] : remote ? TIP.remote : info.parked ? TIP.parked : "Терминал. Клик — открыть вкладку";
    const pkey = `s:${tab.id}`;
    const row = this.draggable(h_flex().id(`${flat ? "pin" : "ses"}-${tab.id}`).relative().h(ROW).px(6).gap(8).items_center().rounded(6).cursor_pointer()
      .when(tab.active && s.active, (el) => el.bg(t.selected))
      .when(!(tab.active && s.active), (el) => el.hover((st) => st.bg(t.hover)))
      .on_mouse_down("right", (e) => openOverlay({ mod: "ygg-sidebar", kind: "popup", width: 280, height: 235,
        at: { x: e.position?.x ?? 40, y: e.position?.y ?? 80 }, props: { smenu: { tab: tab.id, space: s.id } } }))
      .on_hover((h, cx) => { this.hovered = h ? pkey : this.hovered === pkey ? null : this.hovered; cx.notify(); }), "s", tab.id, flat ? "__pins" : s.name, () => this.open(s, tab, info))
      .child(div().flex_none().when(sleeping, (el) => el.opacity(0.55)).child(this.agentIcon(info.kind, t)))
      .child(div().flex_1().min_w(0).truncate().text_color(sleeping ? t.dim : t.foreground).child(label(tab.name, info.kind)))
      .when(flat, (el) => el.child(div().flex_none().max_w(90).truncate().text_size(11).text_color(t.dim).child((this.cfg.projects?.[s.name]?.alias) ?? s.name)))
      .when(remote && !flat, (el) => el.child(this.machineMark(s.machine, t)))
      .child(this.slot(this.mark(info, remote, t)))
      .when(this.hovered === pkey, (el) => el.child(this.actions([this.pinButton(pkey, t, true)], tab.active && s.active ? t.selected : t.hover)));
    if (flat) return row;
    const subs = info.subs.map((k, i) => v_flex().relative()
      .child(this.branch(i === info.subs.length - 1))
      .child(h_flex().h(ROW - 2).px(6).gap(8).items_center().text_color(t.dim)
        .child(this.agentIcon(info.kind, t, 13))
        .child(div().flex_1().min_w(0).truncate().child(k.name || k.title || k.address || "субагент"))
        .child(this.mark({ status: k.status === "error" ? "blocked" : k.status }, false, t))));
    return v_flex().relative()
      .child(this.branch(last))
      .child(row)
      .when(subs.length > 0, (el) => el.child(v_flex().relative().ml(13).pl(STUB).children(subs)));
  }

  // Проект — одно или несколько пространств с одним видимым именем (Vita на Mac и Vita на codex1).
  project(key, title, ss, conf, group, tabTerms, ps, kids, t) {
    const s = ss.find((x) => !x.machine) ?? ss[0];
    const folded = !this.popup && this.folded.has(key);
    const all = ss.flatMap((sp) => (sp.tabs ?? []).filter((tab) => !this.pins.has(`s:${tab.id}`)).map((tab) => ({ s: sp, tab, info: this.session(tab, tabTerms, ps, kids) })));
    // Свой порядок, если его задали перетаскиванием; иначе сначала те, кто ждёт и работает.
    all.sort((a, b) => (RANK[b.info.status] ?? 0) - (RANK[a.info.status] ?? 0));
    const items = byOrder(all, this.sorder[key] ?? [], (i) => i.tab.id);
    if (!this.sorder[key]?.length) this.sorder[key] = items.map((i) => i.tab.id);
    else for (const i of items) if (!this.sorder[key].includes(i.tab.id)) this.sorder[key].push(i.tab.id);
    const color = conf.color ?? t.muted;
    const lit = [...new Set(items.map((i) => i.info.status).filter((x) => x === "working" || x === "blocked"))];
    const pkey = `p:${key}`;
    const head = this.draggable(h_flex().id(`prj-${key}`).relative().h(ROW + 2).px(6).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_hover((h, cx) => { this.hovered = h ? pkey : this.hovered === pkey ? null : this.hovered; cx.notify(); }), "p", key, group, (_e, cx) => this.fold(key, cx))
      .on_mouse_down("right", (e) => openOverlay({ mod: "ygg-sidebar", kind: "popup", width: 280, height: this.menuHeight({ ss }),
        at: { x: e.position?.x ?? 40, y: e.position?.y ?? 80 }, props: { menu: key, at: { x: e.position?.x ?? 40, y: e.position?.y ?? 80 } } }))
      .child(svg(`${ICONS}/${conf.icon ?? "folder"}.svg`).size(15).flex_none().text_color(color))
      .child(div().flex_initial().min_w(0).truncate().font_medium().text_color(t.foreground).child(title))
      .child(svg(`${ICONS}/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1())
      .when(this.pins.has(pkey), (el) => el.child(this.slot(svg(`${ICONS}/pin.svg`).size(11).text_color(t.dim))))
      .children([...new Set(ss.map((x) => x.machine).filter(Boolean))].map((m) => this.machineMark(m, t, "Проект живёт и там")))
      // Свёрнутый проект показывает в колонке статуса самое важное из своих сессий.
      .child(this.slot(folded && lit.length ? this.mark({ status: top(lit) }, false, t) : null))
      .when(this.hovered === pkey, (el) => el.child(this.actions([
        ...(this.popup ? [] : [this.newButton(ss, title, conf, t, true)]), this.pinButton(pkey, t, true)], t.hover)));
    // Как в Codex: активные видны всегда, спящие добирают до N (visible в projects.json, по умолчанию 5),
    // остальные под «Показать больше».
    const limit = conf.visible ?? this.cfg.visible ?? 5;
    const open = this.popup || this.more.has(key);
    // Под своими — сессии этого проекта, начатые вне Herdr (свежие сверху): тоже под «Показать больше».
    const taken = all.flatMap((i) => [i.info.sleepId, i.info.parked].filter(Boolean));
    const ext = this.external(ss.filter((x) => !this.cfg.projects?.[x.name]?.noExternal), taken);
    // Начатые вне Herdr за последние сутки — сразу после работающих, раньше своих спящих: новое видно без «Показать больше».
    const day = Date.now() - 86400000, fresh = ext.filter((x) => x.ext.at > day);
    const every = [...items.filter((i) => i.info.status), ...fresh, ...items.filter((i) => !i.info.status), ...ext.filter((x) => x.ext.at <= day)];
    let room = Math.max(0, limit - items.filter((i) => i.info.status).length);
    const shown = open ? every : every.filter((i) => i.info?.status || room-- > 0);
    const hidden = every.length - shown.length;
    const more = !this.popup && (open || hidden > 0) ? [div().id(`more-${key}`).ml(4).mt(2).mb(4).px(8).h(24).flex().items_center().self_start().rounded(6)
      .text_size(12).text_color(t.dim).bg(t.hover).cursor_pointer().hover((st) => st.text_color(t.foreground))
      .on_click((_e, cx) => { open ? this.more.delete(key) : this.more.add(key); save("ygg.more", [...this.more]); cx.notify(); })
      .child(open ? "Свернуть" : "Показать больше")] : [];
    const body = folded || !every.length ? [] : [v_flex().relative().ml(13).pl(STUB)
      .children(shown.map(({ s: sp, tab, info, ext: e }, i) => (e ? this.extNode(sp, e, i === shown.length - 1, t) : this.sessionNode(sp, tab, info, i === shown.length - 1, t)))), ...more];
    return v_flex().child(head).children(body);
  }

  // Всплывашка свёрнутой панели (как в Codex): наведение на значок открывает проект с его сессиями.
  // Закрывается, когда указатель ушёл и со значка, и со всплывашки.
  pop(key, n) {
    clearTimeout(this.popTimer);
    if (this.popKey === key) return;
    if (this.popId) closeOverlay(this.popId);
    this.popKey = key;
    const y = Math.max(8, (this.at?.y ?? 80) - 22);
    this.popId = openOverlay({ mod: "ygg-sidebar", kind: "popup", width: 320, height: Math.min(560, 52 + Math.max(1, n) * ROW),
      at: { x: (find(layout(), "sidebar")?.size?.px ?? 76) + 4, y }, props: { popup: key } });
  }

  unpop() {
    clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => {
      if (shared("ygg.popHover") || !this.popId) return;
      closeOverlay(this.popId); this.popId = null; this.popKey = null;
    }, 350);
  }

  // Свёрнутая панель: кнопка «развернуть», затем значки проектов по группам с точкой статуса.
  // Клик по проекту — его самая важная сессия (ждёт, работает, готово, иначе первая).
  rail(sections, tabTerms, ps, kids, t) {
    const cell = (id) => div().id(id).size(36).flex_none().flex().items_center().justify_center().rounded(8).relative().cursor_pointer().hover((st) => st.bg(t.hover));
    const icons = sections.flatMap(({ g, list }, gi) => [
      ...(gi ? [div().w(24).h(1).my(6).flex_none().bg(LINE)] : []),
      ...list.map(({ s, ss, title, conf }) => {
        const items = ss.flatMap((sp) => (sp.tabs ?? []).map((tab) => ({ s: sp, tab, info: this.session(tab, tabTerms, ps, kids) })));
        const st = top(items.map((i) => i.info.status).filter(Boolean));
        const best = [...items].sort((a, b) => (RANK[b.info.status] ?? 0) - (RANK[a.info.status] ?? 0))[0];
        const active = ss.some((x) => x.active);
        return cell(`rail-${s.name}`).when(active, (el) => el.bg(t.selected))
          .on_mouse_move((e) => { this.at = e.position; })
          .on_hover((h) => (h ? this.pop(s.name, items.length) : this.unpop()))
          .on_click(() => (best ? this.open(best.s, best.tab, best.info) : s.id && run("space.select", { id: s.id })))
          .child(svg(`${ICONS}/${conf.icon ?? "folder"}.svg`).size(17).text_color(conf.color ?? t.muted))
          .when(st === "working" || st === "blocked" || st === "done", (el) => el.child(div().absolute().top(5).right(5).size(7).rounded(4).bg(C[st])));
      }),
    ]);
    return v_flex().size_full().min_h(0).bg(t.chrome).items_center()
      .child(cell("rail-unfold").mt(6).tooltip("Развернуть панель").on_click(unfold)
        .child(svg(`${ICONS}/sidebar.svg`).size(15).text_color(t.muted)))
      .child(v_flex().flex_1().min_h(0).w_full().items_center().gap(2).py(6).overflow_y_scrollbar().children(icons));
  }

  render() {
    const t = theme();
    // Закрепление из меню сессии (меню — отдельная копия мода): команда через shared.
    const cmd = shared("ygg.pinCmd");
    if (cmd && cmd.n !== this.lastPinCmd && !this.smenu && !this.popup && !this.menu) { this.lastPinCmd = cmd.n; if (cmd.n > (this.bornAt ??= Date.now())) { this.pins.has(cmd.key) ? this.pins.delete(cmd.key) : this.pins.add(cmd.key); save("ygg.pins", [...this.pins]); } }
    const ps = panes();
    const all = terminals();
    // Терминалы вкладки — по метке herdr.tab: панели есть не у всех вкладок (не открытых с запуска).
    const tabTerms = new Map();
    const kids = new Map(); // субагенты: терминалы с parent
    for (const x of all) {
      const tb = x.labels?.["herdr.tab"];
      if (tb) {
        const m = String(x.address).includes("/") ? `${String(x.address).split("/")[0]}/` : "";
        const id = tb.includes("/") ? tb : m + tb;
        tabTerms.set(id, [...(tabTerms.get(id) ?? []), x]);
      }
      if (x.parent && x.state === "live") kids.set(x.parent, [...(kids.get(x.parent) ?? []), x]);
    }
    for (const p of ps) if (p.terminal && !tabTerms.has(p.tab)) { const x = all.find((y) => y.address === p.terminal); if (x) tabTerms.set(p.tab, [x]); }
    const projects = this.cfg.projects ?? {};
    const groups = [...(this.cfg.groups ?? [])];
    const live = spaces();
    this.remember(live);
    // Проект без открытых сессий остаётся в панели пустым: пространство заведём, когда в нём что-то запустят.
    const sp = [...live, ...Object.entries(this.known).filter(([name]) => !live.some((x) => x.name === name))
      .map(([name, k]) => ({ id: null, name, folder: k.folder, machine: k.machine ?? null, tabs: [], absent: true }))];
    // Пространства с одним видимым именем — один проект. Ключ хранения — имя главного (локального)
    // пространства, чтобы порядок, свёрнутость и закрепление не терялись.
    const byTitle = new Map();
    for (const s of sp) { const title = projects[s.name]?.alias ?? s.name; byTitle.set(title, [...(byTitle.get(title) ?? []), s]); }
    const rows = byOrder([...byTitle].map(([title, ss]) => {
      const main = ss.find((x) => !x.machine) ?? ss[0];
      const conf = { ...ss.reduce((c, x) => ({ ...projects[x.name], ...c }), {}), ...projects[main.name] };
      return { s: main, ss, title, conf, group: conf.group ?? this.groupOf[main.name] ?? "Без группы" };
    }), this.order, (r) => r.s.name);
    for (const r of rows) if (!groups.includes(r.group)) groups.push(r.group);
    // Закреплённые проекты — первыми в своей группе.
    const sections = groups.map((g) => ({ g, list: rows.filter((r) => r.group === g)
      .sort((a, b) => Number(this.pins.has(`p:${b.s.name}`)) - Number(this.pins.has(`p:${a.s.name}`))) })).filter((x) => x.list.length);
    const pinned = [];
    for (const s of sp) for (const tab of s.tabs ?? []) if (this.pins.has(`s:${tab.id}`)) pinned.push({ s, tab, info: this.session(tab, tabTerms, ps, kids) });
    const pinnedSorted = byOrder(pinned, this.sorder.__pins ?? [], (i) => i.tab.id);
    if (this.menu) return this.menuView(rows, t);
    if (this.smenu) return this.sessionMenu(rows, tabTerms, ps, kids, t);
    if (this.popup) {
      const r = rows.find((x) => x.s.name === this.popup);
      return v_flex().id("ygg-pop").size_full().min_h(0).bg(t.popover ?? t.chrome).p(6).text_size(13)
        .on_hover((h) => { setShared("ygg.popHover", h); if (!h) setTimeout(() => { if (!shared("ygg.popHover")) closeOverlay(props().overlay); }, 350); })
        .child(r ? v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(this.project(r.s.name, r.title, r.ss, r.conf, r.group, tabTerms, ps, kids, t)) : div());
    }
    if (narrow()) return this.rail(sections, tabTerms, ps, kids, t);
    const header = (g) => div().id(`hdr-${g}`).h(26).px(8).pt(10).flex_none().text_size(11).text_color(t.dim).cursor_pointer()
      .hover((st) => st.text_color(t.muted)).on_click(() => openOverlay({ mod: "ygg-settings", kind: "dialog", width: 640, height: 560 })).child(g.toUpperCase());
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar()
        .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
        .when(pinnedSorted.length > 0, (el) => el.child(header("Закреплённое"))
          .children(pinnedSorted.map(({ s, tab, info }) => this.sessionNode(s, tab, info, false, t, true))))
        .children(sections.flatMap(({ g, list }) => [
          header(g),
          ...list.map(({ s, ss, title, conf, group }) => this.project(s.name, title, ss, conf, group, tabTerms, ps, kids, t)),
        ])));
  }
}
