// Плашка над полем ввода: с чем связана сессия чата. Рабочее (задачи Jira, PR, ожидания ответа в Loop, Kibana)
// у Yggdrasil, личное (PR и задачи GitHub) у Ariadne. Вид как у плашки мода Yggdrasil в Claude: строка-шапка,
// раскрытие стрелкой справа, ожидание ответа своей строкой под шапкой. Данные берёт links.mjs раз в 30 с.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec } from "herdr";
import { MOD, icon } from "./util.js";

const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
const script = (...args) => exec("sh", ["-c", RUN, `${appHome()}/mods/${MOD}/links.mjs`, ...args], { timeout: 10000 });
const TONE = { ok: "#1a9463", warn: "#a87a06", bad: "#dc4136", plain: "#7d8798", link: "#3a7aea" };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EVERY = 30000;
const MAX = 3;

// id сессии из файла транскрипта: <uuid>.jsonl у Claude, rollout-<время>-<uuid>.jsonl у Codex
export function sessionIdOf(file) {
  const base = String(file ?? "").split("/").pop() ?? "";
  return base.match(UUID)?.at(-1) ?? null;
}

const open = (url) => { script("open", url).catch(() => {}); };

// Jira: статус заглавными, цвет по категории (серый не начата, синий в работе, зелёный готова)
function lozenge(task, t) {
  const text = (task.status || "—").toUpperCase();
  const color = task.done || task.statusColor === "done" ? TONE.ok : task.statusColor === "new" || /^(open|to do|backlog|new|reopened|wait for)/i.test(task.status) ? t.dim : TONE.link;
  return div().flex_none().text_size(10.5).font_semibold().text_color(color).child(text);
}

// сигналы PR как в моде Claude: бот, ветка, сборка; худший задаёт цвет значка
function prSignals(p) {
  const out = [];
  const ob = p.openBlocker ?? 0, om = p.openMajor ?? 0;
  if (p.bot === "NOT_A_REVIEWER") out.push(["plain", "Бота нет в ревьюерах"]);
  else if (ob + om > 0) out.push(["bad", `Незакрытые замечания бота: ${ob} blocker, ${om} major`]);
  else if (!p.reviewed) out.push(["plain", "Бот ещё не ревьюил"]);
  else if (p.stale) out.push(["warn", "Бот не смотрел последний коммит"]);
  else if (p.bot === "NEEDS_WORK") out.push(["bad", "Бот просит доработать"]);
  else out.push(["ok", "Бот: замечаний нет"]);
  if (p.conflicted) out.push(["bad", `Конфликт с ${p.target}`]);
  else if (p.behind) out.push(["warn", `Ветка отстаёт на ${p.behind} коммит. от ${p.target}`]);
  if ((p.builds ?? []).includes("FAILED")) out.push(["bad", "Сборка упала"]);
  else if ((p.builds ?? []).includes("INPROGRESS")) out.push(["warn", "Сборка идёт"]);
  else if ((p.builds ?? []).length) out.push(["ok", "Сборка прошла"]);
  return out;
}
const worst = (sigs) => (sigs.some((s) => s[0] === "bad") ? "bad" : sigs.some((s) => s[0] === "warn") ? "warn" : "ok");
const GH_STATE = { open: ["ok", "открыт"], draft: ["plain", "черновик"], merged: ["link", "влит"], closed: ["bad", "закрыт"] };

const waitNext = (w, now) => {
  if (w.state === "paused") return "";
  if (w.next <= now) return "сейчас";
  const m = Math.max(1, Math.round((w.next - now) / 60000));
  return m < 60 ? `${m} мин` : `${Math.round(m / 60)} ч`;
};

export class Links {
  constructor() { this.id = null; this.data = null; this.at = 0; this.busy = 0; this.open = false; this.beat = 0; }

  // из render: новый id или устаревшие данные — запрос в фоне; раз в 30 с сам будит себя. Флаги — время, а не да/нет:
  // перезагрузка мода обрывает фоновые задачи, и булев флаг остался бы поднятым навсегда.
  tick(file, cx) {
    const id = sessionIdOf(file), now = Date.now();
    if (id !== this.id) { this.id = id; this.data = null; this.at = 0; }
    if (now - this.beat > EVERY * 2) {
      this.beat = now;
      cx.spawn(async (cx) => { for (;;) { await cx.sleep(EVERY); this.beat = Date.now(); if (this.id) this.load(cx, true); } });
    }
    if (id && now - this.at > EVERY) this.load(cx);
  }

  load(cx, quiet = false) {
    if (!this.id || Date.now() - this.busy < 15000) return;
    this.busy = Date.now();
    const id = this.id;
    cx.spawn(async (cx) => {
      try {
        const r = await script("get", id);
        const d = JSON.parse(r.stdout || "null");
        if (d && id === this.id && JSON.stringify(d) !== JSON.stringify(this.data)) { this.data = d; cx.notify(); }
      } catch {}
      this.at = Date.now();
      this.busy = 0;
      if (!quiet) cx.notify();
    });
  }

  wait(postId, action, cx) {
    cx.spawn(async (cx) => { try { await script("wait", postId, action); } catch {} this.at = 0; this.load(cx); });
  }

  view(t) {
    const w = this.data?.work, p = this.data?.personal;
    const tasks = w?.tasks ?? [], prs = w?.prs ?? [], threads = w?.threads ?? [], waits = w?.waits ?? [];
    const gh = p?.prs ?? [], issues = p?.issues ?? [];
    if (!tasks.length && !threads.length && !gh.length && !issues.length) return null;
    const now = Date.now();
    const dot = () => div().flex_none().text_color(t.dim).child("·");
    const link = (id, url, label, color = TONE.link) => div().id(id).flex_none().text_color(color).cursor_pointer().hover((s) => s.underline())
      .on_click((_e, _cx) => open(url)).child(label);
    const img = (path, size = 14) => (path ? image(path).size(size).flex_none().rounded(size >= 16 ? size / 2 : 0) : null);
    const mark = (name, color, tip, size = 13) => {
      const el = (name.endsWith(".png") ? image(`mods/${MOD}/icons/${name}`) : name.includes("/") ? svg(name) : svg(`mods/${MOD}/icons/${name}.svg`)).size(size).flex_none();
      const c = color ? el.text_color(color) : el;
      return tip ? div().id(`m-${name}-${tip.slice(0, 24)}`).flex_none().tooltip(tip).child(c) : c;
    };
    const main = tasks.find((x) => x.primary) ?? tasks[0];
    const others = [...tasks.filter((x) => x !== main), ...(w?.linked ?? [])];
    const lead = main ? undefined : threads[0];
    const sigs = prs.flatMap(prSignals);
    const tone = worst(sigs);
    const worstSig = sigs.find((s) => s[0] === tone && tone !== "ok");
    const kibDead = (w?.kibana?.envs ?? []).filter((e) => e.state === "dead");
    const loose = waits.filter((x) => !lead || x.threadKey !== lead.key);
    const hasMore = others.length + prs.length + gh.length + issues.length + waits.length + (gh.length || issues.length ? 1 : 0) > 0;

    const head = h_flex().w_full().gap(6).items_center().min_w(0)
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .when(Boolean(main), (e) => e
          .children([img(main.typeImg), main.priorityImg ? img(main.priorityImg) : null].filter(Boolean))
          .child(link("ln-main", main.url, main.key))
          .child(lozenge(main, t))
          .when(Boolean(main.summary), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(main.summary)))
          .when(tasks.length > 1, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${tasks.length - 1}`))))
        .when(Boolean(lead), (e) => e.child(mark("loop.png", null, "Loop")).child(img(lead.avatarImg, 16)).child(link("ln-lead", lead.url, `${lead.where}${lead.author ? ` · @${lead.author}` : ""}`)))
        .when(prs.length > 0, (e) => e.child(dot()).child(mark("bitbucket", null, `Pull requests: ${prs.length}`))
          .when(prs.length > 1, (e) => e.child(div().flex_none().text_size(11).text_color(TONE[tone]).child(String(prs.length))))
          .when(Boolean(worstSig), (e) => e.child(mark("git-pull-request", TONE[worstSig[0]], worstSig[1]))))
        .when(kibDead.length > 0, (e) => e.child(dot()).child(mark("scroll-text", TONE.bad, `Kibana: агент не прочитает логи\n${kibDead.map((k) => `${k.env}: ${k.why}`).join("\n")}`)))
        .when(Boolean(main) && threads.length > 0, (e) => e.child(dot()).child(mark("loop.png", null, "Loop"))
          .children(threads.slice(0, 3).map((x, i) => div().id(`av-${i}`).flex_none().tooltip(x.author ? `@${x.author}` : x.where).child(img(x.avatarImg, 16))))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(threads.length))))
        .when(gh.length > 0 || issues.length > 0, (e) => e.when(Boolean(main) || prs.length > 0, (e) => e.child(dot()))
          .child(mark("github", t.muted, `GitHub (Ariadne): PR ${gh.length}, задач ${issues.length}`))
          .when(!main && gh[0], (e) => e.child(link("ln-gh0", gh[0].url, `#${gh[0].n}`)).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(gh[0].title || gh[0].repo)))
          .when(Boolean(main) || !gh[0], (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(String(gh.length + issues.length))))))
      .when(hasMore, (e) => e.child(div().id("links-toggle").flex_none().px(4).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.open = !this.open; cx.notify(); })
        .child(icon(this.open ? "chevron-up" : "chevron-down", 13))));

    const btn = (id, label, color, onClick) => div().id(id).flex_none().px(3).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(color)).on_click(onClick).child(label);
    const waitMark = (x) => mark(x.state === "paused" ? "pause" : "eye", x.state === "paused" ? TONE.plain : TONE.link,
      `${x.state === "paused" ? "Ответ в Loop: слежение на паузе" : "Жду ответа в Loop: Yggdrasil следит и разбудит сессию"}\n${x.where}\n⏸ пауза, ▶ продолжить, ✕ не ждать`);
    const waitRow = (x, lead) => h_flex().gap(5).items_center().min_w(0)
      .child(waitMark(x))
      .when(lead, (e) => e.child(div().flex_none().text_size(11).text_color(TONE.link).child(x.state === "paused" ? "Ответ на паузе" : "Жду ответа")))
      .child(link(`w-${x.postId}`, x.url, x.where))
      .when(Boolean(x.text), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`«${x.text}»`)))
      .when(x.state === "on", (e) => e.child(mark("timer", TONE.plain, "Следующая проверка", 12)).child(div().flex_none().text_size(11).text_color(t.dim).child(waitNext(x, now))))
      .child(btn(`wp-${x.postId}`, x.state === "paused" ? "▶︎" : "⏸︎", TONE.link, (_e, cx) => this.wait(x.postId, x.state === "paused" ? "resume" : "pause", cx)))
      .child(btn(`wx-${x.postId}`, "✕", TONE.bad, (_e, cx) => this.wait(x.postId, "stop", cx)));
    const pending = loose.find((x) => x.state === "on") ?? loose[0];

    const rows = [head];
    if (pending) rows.push(waitRow(pending, true).when(loose.length > 1, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${loose.length - 1}`))));
    if (this.open && hasMore) {
      const more = (n) => (n > MAX ? [div().text_size(11).text_color(t.dim).child(`ещё ${n - MAX}`)] : []);
      for (const x of others.slice(0, MAX)) rows.push(h_flex().gap(5).items_center().min_w(0)
        .children([img(x.typeImg), x.priorityImg ? img(x.priorityImg) : null].filter(Boolean))
        .child(link(`ln-${x.key}`, x.url, x.key)).child(lozenge(x, t))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.via ? `общий PR ${x.via} · ${x.summary}` : x.summary)));
      rows.push(...more(others.length));
      for (const x of prs.slice(0, MAX)) rows.push(h_flex().gap(5).items_center().min_w(0)
        .child(mark("git-pull-request", TONE.link, "pull request"))
        .child(link(`ln-pr-${x.key}`, x.url, `${x.repo} #${x.id}`))
        .children(prSignals(x).map(([tn, text], i) => div().id(`sig-${x.key}-${i}`).flex_none().w(7).h(7).rounded(4).bg(TONE[tn]).tooltip(text))));
      rows.push(...more(prs.length));
      for (const x of waits.filter((x) => x !== pending).slice(0, MAX)) rows.push(waitRow(x, false));
      for (const x of gh.slice(0, MAX)) {
        const [tn, word] = GH_STATE[x.state] ?? ["plain", x.state ?? ""];
        rows.push(h_flex().gap(5).items_center().min_w(0)
          .child(mark("git-pull-request", TONE[tn], `PR ${word}${x.role === "author" ? " · сессия автор" : " · сессия смотрела"}`))
          .child(link(`ln-gh-${x.repo}-${x.n}`, x.url, `${x.repo.split("/").pop()} #${x.n}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.title)));
      }
      rows.push(...more(gh.length));
      for (const x of issues.slice(0, MAX)) rows.push(h_flex().gap(5).items_center().min_w(0)
        .child(mark("circle", TONE.plain, `Задача ${x.state ?? ""}`))
        .child(link(`ln-is-${x.repo}-${x.n}`, x.url, `${x.repo.split("/").pop()} #${x.n}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.title)));
    }
    return v_flex().id("chat-links").w_full().gap(6).px(6).text_size(12).children(rows);
  }
}
