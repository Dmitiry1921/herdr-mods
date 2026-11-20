// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, openOverlay, closeOverlay } from "herdr";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // ygg: нажатие не уходит дальше (в терминал под заголовком и в захват панели для перетаскивания), иначе клик терялся
  // и крестик не закрывал панель (пользователь, 21.11.2026). Подпись: что это и что будет по клику.
  button(t, id, icon, command, args, tip) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        typeof command === "function" ? command(cx) : run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  // ygg: разделение спрашивает, что открыть рядом: новый чат (окно новой сессии) или терминал.
  // Уже идущую сессию рядом открывает её меню в боковой панели: «Открыть справа» или «Открыть снизу».
  splitMenu(pane, direction) {
    openOverlay({ mod: "pane", kind: "popup", width: 260, height: 112, props: { menu: { pane, direction } } });
  }

  menuView(t) {
    const { pane, direction } = props().menu;
    const close = () => closeOverlay(props().overlay);
    const item = (id, ic, text, tip, act) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click(() => { close(); act(); })
      .child(svg(ic).size(14).flex_none().text_color(t.muted)).child(div().flex_1().child(text));
    return v_flex().size_full().bg(t.popover ?? t.chrome).p(6).text_size(13).text_color(t.foreground)
      .child(item("new-chat", "mods/ygg-sidebar/icons/chat.svg", "Новый чат", "Окно новой сессии, чат откроется рядом. Клик — начать",
        () => openOverlay({ mod: "ygg-new", kind: "dialog", width: 720, height: 210, props: { split: { direction, pane } } })))
      .child(item("terminal", "mods/ygg-sidebar/icons/terminal.svg", "Терминал", "Клик — открыть терминал рядом", () => run("pane.split", { direction, pane })))
      .child(div().h(1).my(4).bg(t.border))
      .child(div().px(8).text_size(11.5).text_color(t.dim).child("Сессию: правый клик в панели › Открыть справа"));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menuView(t);
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", () => this.splitMenu(pane, "right"), null, "Разделить вправо. Клик — выбрать: чат или терминал"))
        .child(this.button(t, `ph-d-${pane}`, "split-down", () => this.splitMenu(pane, "down"), null, "Разделить вниз. Клик — выбрать: чат или терминал"))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, p.zoomed ? "Клик — вернуть рядом с остальными" : "Клик — развернуть на всю вкладку"))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }, "Клик — закрыть панель")));
  }
}
