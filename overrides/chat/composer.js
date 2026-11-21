// The composer: a growing Textarea, its key bindings, the slash and @file
// menus, image chips and prompt history. The view owns what Enter, Esc and
// the menus do (main.js `actions`); this keeps the text state and the keys.
//
// Keys (spike d): the Textarea takes Up/Down/Enter before any on_key_down,
// but bindings in a context of ours *around* it ("HerdrChatMenu > Input") win,
// so the wrapper's key_context says which keys we want right now:
//   HerdrChatMenu     a menu is open: ↑ ↓ Enter Tab Esc drive it
//   HerdrChatEmpty    nothing typed (or a recalled prompt): ↑ ↓ walk history
//   HerdrChatComposer text typed: Enter sends (steers while working), Alt+Enter
//                  queues a follow-up, Shift+Enter is a newline
//   HerdrChatAsk      a permission card is open and nothing is typed: 1–9
//                  choose, ↑ ↓ move, Enter answers, Esc denies
//   HerdrChatQuestions the same for a questions card, and Space ticks
// Esc is ours in all of them.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { alpha, fileChip, homeRel, icon, spinner, thumbnail } from "./util.js";
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { follow } from "./menus.js";
import { keyHint } from "./shortcuts.js";

const CONTEXTS = ["HerdrChatMenu", "HerdrChatEmpty", "HerdrChatComposer", "HerdrChatAsk", "HerdrChatQuestions"];
const CARDS = ["HerdrChatAsk", "HerdrChatQuestions"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const ACTIONS = ["herdrchat_enter", "herdrchat_up", "herdrchat_down", "herdrchat_tab", "herdrchat_escape", "herdrchat_space", ...DIGITS.map((d) => `herdrchat_digit_${d}`)];

// The composer's bindings in the app's keymap (keymap.js says when).
export function bindComposerKeys(cx) {
  const b = [];
  for (const ctx of CONTEXTS) {
    // Sending (Enter steers, Alt+Enter queues a follow-up) is the `steer` and `followUp` shortcuts
    // (shortcuts.js), so the person can rebind them; in a menu and on an approval card Enter stays ours.
    if (ctx === "HerdrChatMenu" || CARDS.includes(ctx)) b.push({ keystroke: "enter", action: "herdrchat_enter", context: `${ctx} > Input` });
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: ctx });
    // An Input's own Esc (a picker's filter field) would win over the context around it.
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: `${ctx} > Input` });
  }
  for (const ctx of CARDS) for (const d of DIGITS) b.push({ keystroke: d, action: `herdrchat_digit_${d}`, context: `${ctx} > Input` });
  b.push({ keystroke: "space", action: "herdrchat_space", context: "HerdrChatQuestions > Input" });
  for (const ctx of ["HerdrChatMenu", "HerdrChatEmpty", ...CARDS]) {
    b.push({ keystroke: "up", action: "herdrchat_up", context: `${ctx} > Input` });
    b.push({ keystroke: "down", action: "herdrchat_down", context: `${ctx} > Input` });
  }
  b.push({ keystroke: "tab", action: "herdrchat_tab", context: "HerdrChatMenu" });
  // The dialog card: Enter submits an input; Esc cancels (an editor keeps Enter).
  b.push({ keystroke: "enter", action: "herdrchat_dialog_enter", context: "HerdrChatDialog > Input" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatDialog" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatEditor" });
  b.push({ keystroke: "cmd-enter", action: "herdrchat_dialog_enter", context: "HerdrChatEditor > Input" });
  cx.bind_keys(b);
}

// Fuzzy-ish rank: prefix > word start > substring > subsequence.
export function rank(name, q) {
  if (!q) return 1;
  const n = name.toLowerCase();
  q = q.toLowerCase();
  if (n.startsWith(q)) return 4 - n.length / 1000;
  if (n.split(/[-:_/ ]/).some((w) => w.startsWith(q))) return 3 - n.length / 1000;
  if (n.includes(q)) return 2 - n.length / 1000;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 1 - n.length / 1000 : 0;
}

// A skill in the text is a pill (an inline token): its text is the command
// (`/skill:diagnose`), so the value reads as typed; the pill shows its name.
export const skillToken = (s) => ({ id: `skill:${s.command}`, text: `/${s.command}`, label: s.name });

// An image chip's thumbnail: a fixed box, so the composer keeps its height while the image loads.
const THUMB = { w: 64, h: 48 };
const CARD = { w: 138, h: 92 }; // превью вложения в поле ввода (ygg)

export class Composer {
  // `skills()`: the chat's skill commands, [{command, name}] (main.js).
  // `onRemoveChip(chip)`: an image chip's ✕.
  constructor(cx, { onChange, onPasteOther, onRemoveChip, placeholder, skills }) {
    this.ta = TextareaState.new({ placeholder: placeholder ?? "Message…" });
    this.ta.set_auto_grow(1, 10);
    this.skills = skills ?? (() => []);
    this.onRemoveChip = onRemoveChip;
    this.value = "";
    this.cursor = 0; // where the last edit ended: the state has no getter for it
    this.chips = []; // {path, size, label, pending}: `size` as the host reads it (protocol.md v3.7), else null
    this.menu = null; // {kind: "slash"|"files", query, items, sel, start}
    this.history = null; // {list, i, text}
    this.focused = false;
    this.ta.on("change", (_e, cx) => {
      const before = this.value;
      this.value = this.ta.value();
      this.cursor = editEnd(before, this.value);
      if (this.history && this.value !== this.history.text) this.history = null;
      this.pillTyped(before);
      onChange?.(cx);
    });
    this.ta.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.ta.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.ta.on("paste_other", (_e, cx) => onPasteOther?.(cx));
  }

  focus() {
    this.ta.focus();
  }

  // The text, with its skill commands as pills.
  set(text) {
    const tokens = this.skillSpans(text);
    this.ta.set_value(tokens.length ? { text, tokens } : text);
    this.value = text;
    this.cursor = text.length;
    this.ta.set_selected_range({ start: text.length, end: text.length });
  }

  // Where `/command` of a known skill stands as a word in `text` (one per skill).
  skillSpans(text) {
    const out = [];
    for (const s of this.skills()) {
      const word = `/${s.command}`;
      const m = new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$)`).exec(text);
      if (m) out.push({ range: { start: m.index + m[1].length, end: m.index + m[1].length + word.length }, token: skillToken(s) });
    }
    return out.sort((a, b) => a.range.start - b.range.start);
  }

  tokens() {
    return this.ta.tokens?.() ?? [];
  }

  // What to send: a skill pill becomes the message's leading `/command`, the
  // rest follows (a pill inside the text leaves its name there). Null when
  // the text has more than one skill: an agent runs one skill per message.
  message() {
    const text = this.value;
    const pills = this.skillPills();
    if (pills.length > 1) return null;
    if (!pills.length) return text;
    const { range, token } = pills[0];
    const before = text.slice(0, range.start);
    const after = text.slice(range.end);
    const rest = (before.trim() ? `${before}${token.label ?? token.text.slice(1)}${after}` : after).trim();
    return `${token.text}${rest ? ` ${rest}` : ""}`;
  }

  // The skill pills in the text.
  skillPills() {
    return this.tokens().filter((t) => t.token.id.startsWith("skill:"));
  }

  // A skill command typed out in full, then a space or newline: a pill.
  pillTyped(before) {
    if (this.value.length !== before.length + 1 || !/\s/.test(this.value[this.cursor - 1] ?? "")) return;
    const head = this.value.slice(0, this.cursor - 1);
    const m = /(^|\s)\/(\S+)$/.exec(head);
    const s = m && this.skills().find((x) => x.command === m[2]);
    if (!s) return;
    const start = head.length - m[2].length - 1;
    if (this.tokens().some((t) => t.range.start < head.length && t.range.end > start)) return;
    this.ta.set_selected_range({ start, end: head.length });
    this.ta.replace_with_token(skillToken(s));
    this.ta.set_selected_range({ start: this.cursor, end: this.cursor });
    this.value = this.ta.value();
  }

  // A skill picked from the menu: a pill in place of the "/query" being typed, then a space.
  insertSkill(s) {
    const m = this.menu;
    const start = m?.start ?? 0;
    const end = start + 1 + (m?.query?.length ?? 0);
    this.ta.set_selected_range({ start, end });
    this.ta.replace_with_token(skillToken(s));
    this.ta.replace(" ");
    this.value = this.ta.value();
    this.cursor = start + skillToken(s).text.length + 1;
    this.menu = null;
  }

  // ygg: диктовка с текстом по ходу речи. Скрипт мода ygg-new (dictate.mjs: ffmpeg + whisper-server, локально)
  // пишет растущий текст в <base>.txt, поле раз в четверть секунды показывает его после набранного до записи.
  // Второй клик останавливает запись, последний проход уточняет текст.
  dictate(cx) {
    const base = `${appHome()}/data/dictate/${(this.dictId ??= Math.random().toString(36).slice(2, 8))}`;
    if (this.dict === "rec") {
      this.dict = "busy";
      fs.writeFile(`${base}.stop`, "1").catch(() => {});
      cx.notify();
      return;
    }
    if (this.dict) return;
    const pre = this.value;
    const glue = (text) => (pre && text && !/\s$/.test(pre) ? `${pre} ${text}` : `${pre}${text}`);
    let shown = "";
    const run = (this.dictRun = { then: null });
    const show = async (cx) => {
      const text = await fs.readFile(`${base}.txt`, "utf8").catch(() => "");
      const lvl = await fs.readFile(`${base}.lvl`, "utf8").catch(() => "");
      if (lvl !== this.levelsRaw) { this.levelsRaw = lvl; this.levels = lvl ? lvl.split(",").map(Number) : []; cx.notify(); }
      if (text !== shown) { shown = text; this.set(glue(text)); cx.notify(); }
    };
    this.dict = "rec"; this.dictErr = null;
    cx.notify();
    const RUN = 'n=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); exec "${n:-node}" "$0" "$@"';
    const tick = cx.timer.every(100, (cx) => { cx.spawn(show); });
    cx.spawn(async (cx) => {
      await exec("sh", ["-c", RUN, `${appHome()}/mods/ygg-new/dictate.mjs`, base], { timeout: 16 * 60000 }).catch(() => {});
      tick.cancel();
      await show(cx);
      this.dictErr = await fs.readFile(`${base}.err`, "utf8").catch(() => null);
      this.dict = null; this.levels = []; this.levelsRaw = "";
      cx.notify();
      run.then?.(cx);
    });
  }

  // Отправка во время записи: запись останавливается, последний проход распознаёт хвост, и только потом `then`
  // отправляет поле целиком. Раньше уходило то, что успело распознаться, и последние слова терялись.
  finishDictation(then) {
    if (!this.dict || !this.dictRun) return false;
    this.dictRun.then = then;
    fs.writeFile(`${appHome()}/data/dictate/${this.dictId}.stop`, "1").catch(() => {});
    if (this.dict === "rec") this.dict = "busy";
    return true;
  }

  // «+» как у Claude: системный выбор файлов; картинки встают превью, остальное — @путь в тексте (как при перетаскивании).
  pick(c, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", 'set fs to choose file with multiple selections allowed', "-e", 'set out to ""', "-e",
        'repeat with f in fs', "-e", 'set out to out & POSIX path of f & linefeed', "-e", 'end repeat', "-e", 'out'], { timeout: 10 * 60000 }).catch(() => null);
      const paths = (r?.stdout ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
      if (paths.length) c.drop?.(paths, cx);
    });
  }

  // Волна диктовки, как в Claude: точки по громкости последних секунд, новые справа.
  wave(t) {
    const lv = this.levels ?? [];
    const pad = Array(Math.max(0, 48 - lv.length)).fill(0).concat(lv);
    return h_flex().id("dictate-wave").h(20).gap(3).items_center().flex_none()
      .children(pad.map((v, i) => div().w(3).rounded(2).bg(v > 0.3 ? t.foreground : t.dim).h(Math.max(3, Math.round(3 + v * 15)))
        .opacity(v > 0.3 ? 0.55 + v * 0.45 : 0.6)));
  }

  // `pending`: a dropped file the host is still copying (main.js attachImage); it gets the thumbnail's box.
  addChip(path, { pending = false, size = null } = {}) {
    const chip = { path, size, label: path.split("/").pop(), pending };
    this.chips.push(chip);
    return chip;
  }

  removeChip(i) {
    const [ch] = this.chips.splice(i, 1);
    if (ch) this.onRemoveChip?.(ch);
  }

  clear() {
    this.set("");
    this.chips = [];
    this.menu = null;
    this.history = null;
  }

  context() {
    // A menu, or a select/confirm dialog while nothing is typed: ↑ ↓ Enter choose.
    if (this.menu?.items?.length || (this.dialogKeys && !this.value.trim())) return "HerdrChatMenu";
    if (this.askCard && !this.value.trim()) return this.askCard === "questions" ? "HerdrChatQuestions" : "HerdrChatAsk";
    if (!this.value.trim() || (this.history && this.value === this.history.text)) return "HerdrChatEmpty";
    return "HerdrChatComposer";
  }

  // Up/Down through the prompts sent before (newest first).
  recall(list, dir) {
    if (!list.length) return false;
    if (!this.history) {
      if (dir > 0) return false;
      this.history = { list, i: -1, draft: this.value };
    }
    const i = this.history.i - dir; // up = older = higher index
    if (i < 0) {
      const draft = this.history.draft ?? "";
      this.history = null;
      this.set(draft);
      return true;
    }
    if (i >= this.history.list.length) return false;
    this.history.i = i;
    this.history.text = this.history.list[i];
    this.set(this.history.text);
    return true;
  }

  // What the text asks for: "/cmd" alone (every command), "/name" being
  // typed anywhere else (skills only: the rest need the whole message), or
  // "@query" at the end.
  wanted() {
    const v = this.value;
    const inPill = (at) => this.tokens().some((t) => t.range.start <= at && t.range.end > at);
    const slash = /^\/([^\s]*)$/.exec(v);
    if (slash && !inPill(0)) return { kind: "slash", query: slash[1], start: 0 };
    const head = v.slice(0, this.cursor);
    const mid = /(^|\s)\/([^\s/]*)$/.exec(head);
    if (mid) {
      const start = head.length - mid[2].length - 1;
      if (!inPill(start)) return { kind: "slash", query: mid[2], start, skillsOnly: true };
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(v);
    if (at) return { kind: "files", query: at[2] };
    return null;
  }

  moveSel(d) {
    const m = this.menu;
    if (!m?.items?.length) return;
    m.sel = (m.sel + d + m.items.length) % m.items.length;
    follow(m);
  }

  // Replace "@query" at the end with "@path ".
  insertFile(path) {
    const v = this.value.replace(/(^|\s)@([^\s@]*)$/, (_m, pre) => `${pre}@${path} `);
    this.set(v);
    this.menu = null;
  }

  // The composer card (visual-v2.md §1): the text, image chips, then the
  // footer row `c.footer` (model, thinking, context; statuses, ⋯) and the
  // send / stop button. `c` is the view's render context (cards.js).
  view(t, c) {
    const chips = this.chips.map((ch, i) => {
      const x = div().id(`chip-x-${i}`).cursor_pointer().rounded(4).hover((s) => s.text_color(t.foreground).bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.removeChip(i); cx.notify(); }).child(icon("x", 11));
      // ygg: карточка как в Codex: превью целиком (вписано в рамку), под ним значок и имя, × в углу.
      const rel = ch.pending ? null : homeRel(ch.path, appHome());
      if (ch.pending || rel) {
        const k = ch.size ? Math.min(CARD.w / ch.size.w, CARD.h / ch.size.h) : 1;
        const pic = rel ? image(rel).rounded(6).w(ch.size ? Math.round(ch.size.w * k) : CARD.w).h(ch.size ? Math.round(ch.size.h * k) : CARD.h) : spinner(14, t.muted);
        return div().relative().flex_none().child(v_flex().id(`chip-${i}`).w(CARD.w + 12).rounded(12).border_1().border_color(t.border).bg(t.background)
          .tooltip(ch.label).cursor_pointer().on_click((_e, cx) => rel && c.enlarge?.(ch.path, ch.size, cx))
          .child(h_flex().h(CARD.h + 12).items_center().justify_center().child(pic))
          .child(h_flex().h(28).px(8).gap(6).items_center().border_t_1().border_color(t.border)
            .child(div().text_color(t.muted).child(icon("image", 12))).child(div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(ch.label))))
          .child(x.absolute().top(-6).right(-6).size(20).flex().items_center().justify_center().rounded_full().bg(t.foreground).text_color(t.background));
      }
      return fileChip(`chip-${i}`, ch.label, t).pr(6).bg(t.raised).child(x);
    });
    let wrap = div().id("composer-box").w_full().min_w(0).key_context(this.context());
    for (const a of ACTIONS) wrap = wrap.on_action(a, (_e, cx) => c.action(a, cx));
    wrap = wrap.child(Textarea.new(this.ta).w_full().px(6).pt(10).pb(8).text_size(14.5).text_color(t.foreground).bg(alpha(t.background, 0))
      .token((tok, _cx) => skillPillEl(tok, t)));
    const working = c.working;
    const typed = Boolean(this.value.trim() || this.chips.length);
    const stop = working && !typed;
    // Как блок ввода Claude: залитая карточка, «+» слева, справа ↵ и микрофон; превью вложений сверху.
    const round = (id) => h_flex().id(id).flex_none().size(32).rounded(10).items_center().justify_center().cursor_pointer();
    const plus = round("attach").text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Приложить файлы. Клик — выбрать").on_click((_e, cx) => this.pick(c, cx)).child(icon("plus", 18));
    const btn = round(stop ? "stop" : "send")
      .when(stop, (e) => e.bg(t.foreground).text_color(t.background))
      .when(!stop, (e) => e.text_color(typed ? t.foreground : t.dim).hover((s) => s.bg(t.hover)))
      .tooltip(stop ? `Stop (Esc${keyHint("stop") ? ` · ${keyHint("stop")}` : ""})` : working ? "Steer (Enter)" : "Send (Enter)")
      .on_click((_e, cx) => c.action(stop ? "herdrchat_stop" : "herdrchat_enter", cx))
      .child(icon(stop ? "square" : "corner-down-left", stop ? 11 : 17));
    const rec = this.dict === "rec", busy = this.dict === "busy";
    const mic = round("dictate")
      .when(rec, (e) => e.bg(alpha(t.accent, 0.22)).text_color(t.accent))
      .when(!rec, (e) => e.text_color(this.dictErr ? (t.error ?? "#f87168") : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(rec ? "Идёт запись. Клик — остановить (Enter — дораспознать и отправить)" : busy ? "Распознаю речь" : this.dictErr ?? "Надиктовать. Клик — начать запись")
      .on_click((_e, cx) => this.dictate(cx))
      .child(busy ? spinner(14, t.muted) : rec ? icon("square", 11) : icon("mic", 17));
    return v_flex().w_full().rounded(18).border_1().bg(t.input)
      .border_color(alpha(t.foreground, this.focused ? 0.16 : 0.07))
      .when(chips.length > 0, (e) => e.child(h_flex().px(14).pt(12).gap(8).flex_wrap().children(chips)))
      .child(h_flex().w_full().pl(8).pr(8).py(6).gap(4).items_end()
        .child(h_flex().h(36).items_center().child(plus))
        .child(wrap.flex_1())
        .child(h_flex().h(36).gap(2).items_center().child(btn).child(mic)))
      // Пока идёт запись, вместо чипов модели бежит волна (как у Claude); чипы не дублируются отдельной строкой.
      .child(h_flex().h(34).pl(14).pr(10).gap(4).items_center().border_t(1).border_color(alpha(t.foreground, 0.05))
        .when(rec || busy, (e) => e.child(this.wave(t)).child(div().flex_1()))
        .when(!(rec || busy), (e) => e.child(h_flex().flex_1().min_w(0).gap(2).items_center().overflow_hidden().child(c.footer ?? div()))));
  }
}

// The pill a skill token draws in the text (cards.js draws the same in a sent message).
function skillPillEl(tok, t) {
  if (!tok.token.id.startsWith("skill:")) return null;
  const h = Math.max(18, Math.min(22, Math.round(tok.line_height) - 2));
  return h_flex().h(h).px(6).gap(4).items_center().rounded(5).text_size(12.5).font_medium()
    .bg(alpha(t.accent, tok.selected ? 0.3 : 0.14)).text_color(t.accent)
    .child(icon("book", 11.5)).child(tok.token.label ?? tok.token.text);
}

// Where an edit from `a` to `b` ends in `b`: after what was typed or pasted.
function editEnd(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return b.length - s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
